from collections import defaultdict

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import (
    Case,
    Count,
    Exists,
    F,
    OuterRef,
    Q,
    Subquery,
    Value,
    When,
)
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import (
    NotFound,
    PermissionDenied,
    ValidationError,
)
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .imaging import (
    MAX_IMAGES_PER_POST,
    POST_IMAGE_MAX_EDGE,
    POST_THUMB_EDGE,
    clear_avatar,
    process_avatar,
    process_image,
    save_avatar,
)
from .models import (
    Block,
    Connection,
    Conversation,
    ConversationRead,
    Group,
    GroupMembership,
    Message,
    Participant,
    ParticipantInterval,
    Post,
    PostImage,
)
from .serializers import (
    CommentCreateSerializer,
    CommentSerializer,
    ConnectionRequestSerializer,
    ConversationSerializer,
    GroupInviteSerializer,
    GroupMemberSerializer,
    GroupSerializer,
    MessageCreateSerializer,
    MessageSerializer,
    PostSerializer,
    UserListSerializer,
)

User = get_user_model()

ACCEPTED = Connection.Status.ACCEPTED
PENDING = Connection.Status.PENDING

# Group membership states/roles (Phase 6).
ACTIVE = GroupMembership.Status.ACTIVE
INVITED = GroupMembership.Status.INVITED
ADMIN = GroupMembership.Role.ADMIN
MEMBER = GroupMembership.Role.MEMBER


def connected_user_ids(user):
    """The set of user ids ``user`` is connected with (accepted, either way).

    A connection is symmetric once accepted, so the row can name ``user`` as
    *either* endpoint — we return the *other* endpoint each time. This single
    "who can I see" set is what the feed, profiles, and the comment tree all key
    off, so those three surfaces can't drift apart.
    """
    pairs = Connection.objects.filter(
        Q(requester=user) | Q(requestee=user), status=ACCEPTED
    ).values_list("requester_id", "requestee_id")
    return {
        requestee if requester == user.id else requester
        for requester, requestee in pairs
    }


def is_blocked_between(user, other):
    """True if either of ``user``/``other`` has blocked the other (Phase 5).

    A block in *either* direction cuts the pair off, so this checks both. It's
    the single gate the messaging + connection paths consult, so "blocked means
    blocked" can't be interpreted differently in two places.
    """
    return Block.objects.filter(
        Q(blocker=user, blocked=other) | Q(blocker=other, blocked=user)
    ).exists()


def can_message(user, other):
    """Whether ``user`` may send a message to ``other`` (Phase 5).

    Messaging is connection-gated (no cold DMs from strangers — see the phase
    doc): both accounts active, mutually connected, and neither has blocked the
    other. This is the one place the rule lives; the create-conversation and
    send-message views both defer to it.
    """
    if not other.is_active or not user.is_active:
        return False
    if is_blocked_between(user, other):
        return False
    return other.id in connected_user_ids(user)


# Group-chat membership states (Phase 6a). Mirrors the ACCEPTED/PENDING and
# ACTIVE/INVITED aliases above so call sites read as state names, not strings.
ACTIVE_P = Participant.Status.ACTIVE
PENDING_P = Participant.Status.PENDING


def active_participant_ids(convo):
    """The user ids currently ``active`` in ``convo`` — the clique that must
    stay fully mutually-connected. Excludes anyone who has left."""
    return set(
        convo.participants.filter(status=ACTIVE_P, left_at__isnull=True)
        .values_list("user_id", flat=True)
    )


def participant_user_ids(convo):
    """Everyone still attached to ``convo`` — active or pending, not left."""
    return set(
        convo.participants.filter(left_at__isnull=True).values_list("user_id", flat=True)
    )


def open_interval(participant):
    """Open a fresh access interval for ``participant`` starting now-ish.

    Kept separate from ``activate`` so callers that already know they need a
    new interval (e.g. a migration backfill) don't have to touch status too.
    """
    return ParticipantInterval.objects.create(
        participant=participant, started_at=timezone.now()
    )


def close_intervals(participant, when):
    """Close any of ``participant``'s open-ended intervals as of ``when``.

    A participant should have at most one open interval at a time, but this
    closes all of them defensively so a data hiccup can't leave a stale one
    silently extending visibility forever.
    """
    participant.intervals.filter(ended_at__isnull=True).update(ended_at=when)


def activate(participant, when):
    """Make a participant active and open a fresh access interval (idempotent).

    Safe to call on an already-active participant with an already-open
    interval — the promotion sweep and reconnection flows both call this
    without first checking current state.
    """
    open_iv = participant.intervals.filter(ended_at__isnull=True).exists()
    if participant.status != ACTIVE_P or participant.left_at is not None:
        participant.status = ACTIVE_P
        participant.left_at = None
        participant.save(update_fields=["status", "left_at"])
    if not open_iv:
        ParticipantInterval.objects.create(participant=participant, started_at=when)


def deactivate(participant, when):
    """Drop a participant to pending and close any open interval.

    Closing the interval here (rather than leaving it to whoever re-promotes
    them) means the "gap" is anchored to the moment they actually dropped out,
    so messages sent in that gap are never visible to them even if they're
    re-promoted much later.
    """
    participant.intervals.filter(ended_at__isnull=True).update(ended_at=when)
    if participant.status != PENDING_P:
        participant.status = PENDING_P
        participant.save(update_fields=["status"])


def promote_participants(convo, when):
    """Promote every pending participant now connected to all current active
    members — one at a time, re-checking after each.

    This is *not* a maximal-clique search: it applies a simple event rule
    (does this pending person now connect to everyone currently active?) and
    re-derives the active set after every single promotion before considering
    the next pending person. That one-at-a-time-with-recheck shape is what
    keeps the invariant (active participants are always a full clique) from
    breaking — without it, two pending people who aren't connected to each
    other could both get admitted in the same pass because each was checked
    against the *pre-promotion* active set.
    """
    changed = True
    while changed:
        changed = False
        actives = active_participant_ids(convo)
        pending = convo.participants.filter(status=PENDING_P, left_at__isnull=True)
        for p in pending.select_related("user"):
            connected = connected_user_ids(p.user)
            if actives <= connected:  # connected to every active member
                activate(p, when)
                changed = True
                break  # re-derive actives before considering the next one


def must_connect_with(convo, user):
    """Active members ``user`` must still connect with to join (drives the
    locked pending panel + the 'connect with X & Y' prompt)."""
    connected = connected_user_ids(user)
    missing_ids = active_participant_ids(convo) - connected - {user.id}
    return list(User.objects.filter(id__in=missing_ids, is_active=True))


def visible_messages_for(convo, user):
    """Messages ``user`` may see: those whose ``created_at`` falls in one of
    their access intervals. Empty for a pending/never-joined participant —
    dropping to pending and later being re-promoted must never resurrect the
    messages sent while they were out."""
    intervals = ParticipantInterval.objects.filter(
        participant__conversation=convo, participant__user=user
    ).values_list("started_at", "ended_at")
    window = Q(pk__in=[])
    for started_at, ended_at in intervals:
        span = Q(created_at__gte=started_at)
        if ended_at is not None:
            span &= Q(created_at__lt=ended_at)
        window |= span
    return convo.messages.filter(window).select_related("sender")


def group_role(user, group_id):
    """The user's role in a group if they're an **active** member, else None.

    The single source of truth for "am I in this group, and as what" — every
    group view keys off it so member/admin gates can't drift. Returns
    ``"admin"``/``"member"`` or ``None`` (not a member, or only invited).
    """
    return (
        GroupMembership.objects.filter(
            group_id=group_id, user=user, status=ACTIVE
        )
        .values_list("role", flat=True)
        .first()
    )


def is_group_member(user, group_id):
    return group_role(user, group_id) is not None


def is_group_admin(user, group_id):
    return group_role(user, group_id) == ADMIN


def can_add_to_group(inviter, invitee):
    """Whether ``inviter`` may invite ``invitee`` into a group.

    Invitations are connection-gated exactly like messaging: the invitee must be
    one of the inviter's connections, both accounts active, neither blocking the
    other. This keeps the app's "no cold contact from strangers" rule at the
    point of entry — you can only pull in people *you* already have a
    relationship with — and is *literally* the messaging gate (both accounts
    active, mutually connected, neither blocking) so the two entry points to the
    same person can't drift apart.
    """
    return can_message(inviter, invitee)


def decorate_conversations(conversations, user):
    """Attach the per-viewer fields the conversation list serializer needs, in a
    fixed number of queries (no N+1 across the page).

    For each conversation, sets ``.other`` (the other participant), attaches the
    latest message as ``._last_message`` (or ``None``), and ``.unread_count``
    (messages you didn't send, newer than your read marker, not deleted).
    ``conversations`` must already have ``user_a``/``user_b`` selected.
    """
    conversations = list(conversations)
    for convo in conversations:
        convo.other = convo.other_participant(user)
    ids = [c.id for c in conversations]
    if not ids:
        return conversations

    # Latest message per conversation, in one query (Postgres DISTINCT ON).
    latest = (
        Message.objects.filter(conversation_id__in=ids)
        .order_by("conversation_id", "-created_at", "-id")
        .distinct("conversation_id")
        .select_related("sender")
    )
    last_by_convo = {m.conversation_id: m for m in latest}

    # Unread-per-conversation in one query: count each viewer-unseen message
    # (not yours, not deleted, newer than your read marker — or all of them if
    # you've never opened the thread), grouped by conversation.
    read_at = ConversationRead.objects.filter(
        conversation_id=OuterRef("conversation_id"), user=user
    ).values("last_read_at")[:1]
    unread_rows = (
        Message.objects.filter(conversation_id__in=ids, deleted_at__isnull=True)
        .exclude(sender=user)
        .annotate(read_at=Subquery(read_at))
        .filter(Q(read_at__isnull=True) | Q(created_at__gt=F("read_at")))
        .values("conversation_id")
        .annotate(n=Count("id"))
    )
    unread_by_convo = {r["conversation_id"]: r["n"] for r in unread_rows}

    for convo in conversations:
        convo._last_message = last_by_convo.get(convo.id)
        convo.unread_count = unread_by_convo.get(convo.id, 0)
    return conversations


def visible_posts(user, author=None, connected_ids=None, group=None):
    """The posts ``user`` is allowed to see on a timeline, newest-first.

    Private-by-default, in one place so the feed, a profile, and a group timeline
    can't drift: a post is visible only if ``user`` wrote it or is **connected**
    with its author, and only if that author is still active (a deactivated/banned
    member disappears from feeds too, not just from the people list). Pass
    ``author`` to narrow to a single person's posts (the profile page). Pass
    ``connected_ids`` when the caller already computed the connected set, to avoid
    recomputing it.

    ``group`` picks the timeline, and the connection gate above applies to both:

    - ``None`` (default) — **personal** posts (``group IS NULL``): the home feed
      and profiles. Group posts deliberately never surface here (the home feed
      means "my connections", not "every group I'm in").
    - a group (id or instance) — that group's timeline. Membership is gated by
      the *caller* (see ``GroupPostsView``); this still prunes to the viewer's
      connections, so inside a group you only ever see posts by members you're
      connected with — never a co-member you don't know (a block, which severs
      the connection, hides them here for free too).
    """
    if connected_ids is None:
        connected_ids = connected_user_ids(user)
    qs = (
        Post.objects.filter(
            Q(author=user) | Q(author__in=connected_ids),
            author__is_active=True,
        )
        # select_related("group") so the serializer's group label doesn't fire a
        # query per group post; a post can carry several photos, so prefetch
        # those too rather than one query per post.
        .select_related("author", "group")
        .prefetch_related("images")
    )
    qs = qs.filter(group__isnull=True) if group is None else qs.filter(group=group)
    if author is not None:
        qs = qs.filter(author=author)
    return qs


def feed_posts(user, include_groups=False):
    """The home feed's posts, newest-first.

    By default this is exactly ``visible_posts`` — your personal posts plus your
    connections' (no group posts). With ``include_groups`` the viewer has opted
    in to *also* see posts from groups they're an active member of, merged into
    the same strictly-chronological stream (no ranking — the merge is by time
    only, so the no-algorithm rule holds). Two gates apply to those group posts,
    exactly as on the group timeline itself: you must be an active member of the
    group, **and** be connected with the post's (active) author — so opting in
    never surfaces a co-member you aren't connected with, and a block (which
    severs the connection) keeps their posts out of your feed here too.
    """
    connected_ids = connected_user_ids(user)
    if not include_groups:
        return visible_posts(user, connected_ids=connected_ids)

    group_ids = GroupMembership.objects.filter(
        user=user, status=ACTIVE
    ).values_list("group_id", flat=True)
    return (
        Post.objects.filter(
            Q(author=user) | Q(author__in=connected_ids),
            author__is_active=True,
        )
        .filter(Q(group__isnull=True) | Q(group_id__in=group_ids))
        .select_related("author", "group")
        .prefetch_related("images")
    )


def connection_status_annotation(user):
    """Annotate a User queryset with ``connection_status`` — the requesting
    user's relationship to each row, driving the Connect button:

    - ``"connected"``  — an accepted connection (either direction),
    - ``"requested"``  — you sent a request, awaiting their approval,
    - ``"incoming"``   — they sent a request, awaiting *your* approval,
    - ``"none"``       — no connection.
    """
    accepted = Connection.objects.filter(
        Q(requester=user, requestee=OuterRef("pk"))
        | Q(requester=OuterRef("pk"), requestee=user),
        status=ACCEPTED,
    )
    outgoing = Connection.objects.filter(
        requester=user, requestee=OuterRef("pk"), status=PENDING
    )
    incoming = Connection.objects.filter(
        requester=OuterRef("pk"), requestee=user, status=PENDING
    )
    return Case(
        When(Exists(accepted), then=Value("connected")),
        When(Exists(outgoing), then=Value("requested")),
        When(Exists(incoming), then=Value("incoming")),
        default=Value("none"),
    )


def build_visible_comment_tree(comments, visible_author_ids):
    """Turn a flat list of a post's comments into the nested tree a viewer may
    see, pruning whole subtrees rooted at an author they can't see.

    ``visible_author_ids`` is the set of authors the viewer may see: themselves
    plus their (active) connections. Visibility rule (issue #12): a comment shows
    only if its author is in that set. Crucially, if a comment is hidden,
    everything **below** it is hidden too — even a reply from someone the viewer
    *is* connected with — so they never see half a conversation with invisible
    participants, and strangers can't be surfaced second-hand through a thread.

    Note the caller is expected to have already dropped comments by deactivated
    authors from ``comments`` (see ``PostCommentsView``); those then take their
    subtrees with them here too, since an orphaned reply is never reached from a
    root.

    Each surviving comment gets a ``_visible_children`` list of its visible
    replies (read by the serializer). ``comments`` is assumed to arrive in the
    model's ``created_at, id`` order, which we preserve within each sibling set.
    """
    children = defaultdict(list)
    for comment in comments:
        children[comment.parent_id].append(comment)

    def build(parent_id):
        nodes = []
        for comment in children.get(parent_id, []):
            if comment.author_id not in visible_author_ids:
                # Prune this node AND its whole subtree: don't recurse into it.
                continue
            comment._visible_children = build(comment.id)
            nodes.append(comment)
        return nodes

    return build(None)


@api_view(["GET"])
@permission_classes([AllowAny])
def hello(request):
    """Phase 0 smoke-test endpoint.

    Proves the frontend can reach the backend and the backend is alive.
    Returns a tiny JSON payload; no database or auth involved.
    """
    return Response(
        {
            "message": "Hello from the TimeLine backend 👋",
            "service": "backend",
            "time": timezone.now().isoformat(),
        }
    )


class FeedView(generics.ListAPIView):
    """The home timeline: your own posts plus everyone you're connected with.

    Strictly newest-first (Post's default ordering) — no ranking, ever. This is
    the whole point of TimeLine (see docs/SHARED.md). Paginated.

    ``?include_groups=1`` opts in to merging posts from groups you're a member of
    into the same chronological stream (still time-ordered — see ``feed_posts``).
    """

    serializer_class = PostSerializer

    def get_queryset(self):
        include_groups = parse_bool(
            self.request.query_params.get("include_groups")
        )
        return feed_posts(self.request.user, include_groups=include_groups)


class PostCreateView(generics.CreateAPIView):
    """Create a post as the logged-in user, optionally with photos.

    Accepts JSON (text only) or multipart (text + repeated ``images`` files).
    Every uploaded file is validated + downscaled + metadata-stripped by
    ``api.imaging.process_image`` *before* anything is written, so a bad file
    400s without creating a half-post, and no EXIF/GPS reaches storage. A post
    must have text or at least one photo.

    An optional ``group`` id posts into that group's timeline instead of the
    personal one — but only if the author is an active member of it (403
    otherwise, 404 if the group is unknown). No ``group`` is the original
    personal-post behaviour, unchanged.
    """

    serializer_class = PostSerializer
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        # Optional group target: you can only post into a group you belong to.
        group = None
        group_id = request.data.get("group")
        if group_id:
            # 404 (not 403) for both an unknown group and one you're not a member
            # of, so posting can't be used to probe which private groups exist —
            # the same non-member-gets-404 discipline as every other group
            # endpoint (see the phase doc's privacy note).
            group = get_object_or_404(Group, pk=group_id)
            if not is_group_member(request.user, group.id):
                raise NotFound()

        files = request.FILES.getlist("images")
        text = serializer.validated_data.get("text", "")
        if not text and not files:
            raise ValidationError(
                {"detail": "A post needs some text or at least one photo."}
            )
        if len(files) > MAX_IMAGES_PER_POST:
            raise ValidationError(
                {"images": f"A post can have at most {MAX_IMAGES_PER_POST} photos."}
            )

        # Process every file up front: if any is invalid we bail here (400)
        # before creating the post, so there's never an orphaned text row.
        processed = [
            process_image(
                f, max_edge=POST_IMAGE_MAX_EDGE, thumb_edge=POST_THUMB_EDGE
            )
            for f in files
        ]

        with transaction.atomic():
            # Author comes from the session, never the request body; group is the
            # membership-checked target above (or None for a personal post).
            post = serializer.save(author=request.user, group=group)
            for item in processed:
                image = PostImage(
                    post=post, width=item["width"], height=item["height"]
                )
                image.image.save(
                    f"image{item['ext']}", item["image"], save=False
                )
                image.thumbnail.save(
                    f"thumb{item['ext']}", item["thumbnail"], save=False
                )
                image.save()

        # Re-serialize so the response carries the created images (with URLs).
        out = self.get_serializer(post)
        headers = self.get_success_headers(out.data)
        return Response(
            out.data, status=status.HTTP_201_CREATED, headers=headers
        )


class UserPostsView(generics.ListAPIView):
    """One person's own posts, newest-first — drives the profile page.

    Private-by-default: you only see a user's posts if it's you, or you're
    connected. Otherwise the list is empty (the profile page explains why and
    offers a Connect button).
    """

    serializer_class = PostSerializer

    def get_queryset(self):
        # 404 for an unknown/inactive user rather than a silently empty list;
        # visible_posts then applies the shared private-by-default gate (returns
        # their posts if we're allowed to see them, otherwise nothing).
        author = get_object_or_404(User, pk=self.kwargs["pk"], is_active=True)
        return visible_posts(self.request.user, author=author)


class UserListView(generics.ListAPIView):
    """People to connect with: every other active member, with your status."""

    serializer_class = UserListSerializer

    def get_queryset(self):
        user = self.request.user
        return (
            User.objects.filter(is_active=True)
            .exclude(pk=user.pk)
            .annotate(connection_status=connection_status_annotation(user))
            .order_by("first_name", "last_name", "email")
        )


class UserDetailView(generics.RetrieveAPIView):
    """A single member's public details (for the profile header)."""

    serializer_class = UserListSerializer

    def get_queryset(self):
        user = self.request.user
        return User.objects.filter(is_active=True).annotate(
            connection_status=connection_status_annotation(user),
            # Whether *you* have blocked this person, so the profile can offer
            # Unblock and hide the Message button. (A block severs any
            # connection, so "connected" already implies "not blocked".)
            is_blocked=Exists(
                Block.objects.filter(
                    blocker=user, blocked=OuterRef("pk")
                )
            ),
        )


class ConnectView(APIView):
    """Request a connection (POST) or disconnect / cancel a request (DELETE)
    with the user at ``/users/<pk>/connect/``.

    Accounts are private: POST creates a **pending** request that the other
    person must approve before either of you sees the other's posts — it grants
    nothing on its own. **Except** when they've *already* requested you: then the
    mutual intent is clear, so POST accepts the existing request instead of
    creating a competing row (which the one-row-per-pair constraint would reject
    anyway). Both verbs are idempotent. You can't connect with yourself (400) or
    a non-existent/inactive user (404). DELETE removes the row whatever its
    status, so it cancels a pending request or ends an accepted connection.
    """

    def _target(self, pk):
        return get_object_or_404(User, pk=pk, is_active=True)

    def _existing(self, user, target):
        return Connection.objects.filter(
            Q(requester=user, requestee=target)
            | Q(requester=target, requestee=user)
        ).first()

    def post(self, request, pk):
        target = self._target(pk)
        if target == request.user:
            return Response(
                {"detail": "You can't connect with yourself."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # A block in either direction bars (re)connecting — the explicit cut is
        # meant to stick until the blocker lifts it (Phase 5).
        if is_blocked_between(request.user, target):
            return Response(
                {"detail": "You can't connect with this person."},
                status=status.HTTP_403_FORBIDDEN,
            )
        existing = self._existing(request.user, target)
        if existing is None:
            try:
                # Own savepoint so a lost race rolls back just this insert, not
                # the whole request transaction (which ATOMIC_REQUESTS may wrap).
                with transaction.atomic():
                    Connection.objects.create(
                        requester=request.user, requestee=target
                    )
            except IntegrityError:
                # A reciprocal request landed between our read and our write;
                # the one-row-per-pair constraint rejected this insert. Re-read
                # and fall through to resolve it (their pending row → accept).
                existing = self._existing(request.user, target)
                if existing is None:
                    raise
            else:
                return Response(
                    {
                        "detail": "Request sent.",
                        "connection_status": "requested",
                    },
                    status=status.HTTP_201_CREATED,
                )
        if existing.status == ACCEPTED:
            return Response(
                {
                    "detail": "Already connected.",
                    "connection_status": "connected",
                },
                status=status.HTTP_200_OK,
            )
        # A pending request already exists between the two of you.
        if existing.requestee_id == request.user.id:
            # They asked you first — approving it connects you both now.
            existing.status = ACCEPTED
            existing.save(update_fields=["status"])
            return Response(
                {"detail": "Connected.", "connection_status": "connected"},
                status=status.HTTP_200_OK,
            )
        # You'd already requested them; nothing to do (idempotent).
        return Response(
            {
                "detail": "Request already sent.",
                "connection_status": "requested",
            },
            status=status.HTTP_200_OK,
        )

    def delete(self, request, pk):
        target = self._target(pk)
        Connection.objects.filter(
            Q(requester=request.user, requestee=target)
            | Q(requester=target, requestee=request.user)
        ).delete()
        return Response(
            {"detail": "Removed.", "connection_status": "none"},
            status=status.HTTP_200_OK,
        )


class ConnectionRequestListView(generics.ListAPIView):
    """Incoming connection requests: people who've asked to connect with *you*
    and are waiting on your approval."""

    serializer_class = ConnectionRequestSerializer

    def get_queryset(self):
        return (
            Connection.objects.filter(
                requestee=self.request.user, status=PENDING
            )
            .select_related("requester")
            .order_by("-created_at")
        )


class ConnectionRequestActionView(APIView):
    """Approve (make the connection mutual) or reject (delete the request) an
    incoming connection request. Wired to two URLs via ``.as_view(action=...)``:
    ``/connection-requests/<pk>/approve/`` and ``.../reject/``.

    Only the requestee may act on it: the row must have ``requestee == you`` and
    still be pending, else 404 (we don't reveal requests addressed to others).
    """

    # Set per-URL by as_view(action="approve"|"reject").
    action = None

    def post(self, request, pk):
        connection = get_object_or_404(
            Connection, pk=pk, requestee=request.user, status=PENDING
        )
        if self.action == "approve":
            connection.status = ACCEPTED
            connection.save(update_fields=["status"])
            return Response({"detail": "Approved."}, status=status.HTTP_200_OK)
        connection.delete()
        return Response({"detail": "Rejected."}, status=status.HTTP_200_OK)


class PostCommentsView(APIView):
    """The comment tree for a post (GET) and adding a comment/reply (POST) at
    ``/posts/<pk>/comments/``.

    One rule for both personal and group posts: you can reach a post's comments
    only if you can **see** the post, and the tree is then pruned to your
    connections — a not-connected author's comment and its whole subtree are
    omitted server-side, so hidden content never reaches the client. Concretely:

    - **Personal post** (no group): visible if you're its author or connected
      with them — else 404.
    - **Group post**: you must be an active **member** of the group *and* (as on
      the group timeline) connected with the post's author — else 404. Inside a
      group you only see comments from members you're connected with, matching
      the connection-gated timeline; a co-member you don't know (or have blocked)
      stays hidden.

    POST adds a comment, or a reply when ``parent`` is given; the author is taken
    from the session, never the body.
    """

    def _get_post_or_404(self, request, pk):
        """Return ``(post, connected_ids)`` the requester may see + comment on,
        or 404.

        The single visibility gate for both regimes: fetch via ``visible_posts``
        (author-or-connected, author active) scoped to the post's timeline, after
        a membership check for group posts. ``connected_ids`` is returned so GET
        can prune the tree without a second query.
        """
        post = get_object_or_404(Post.objects.select_related("author"), pk=pk)
        connected_ids = connected_user_ids(request.user)
        # Group posts gate on active membership first (404 for a non-member, so
        # the group's existence isn't leaked); visibility below then also prunes
        # to authors you're connected with.
        if post.group_id and not is_group_member(request.user, post.group_id):
            raise NotFound()
        visible = visible_posts(
            request.user,
            connected_ids=connected_ids,
            group=post.group_id or None,
        )
        if not visible.filter(pk=pk).exists():
            raise NotFound()
        return post, connected_ids

    def get(self, request, pk):
        post, connected_ids = self._get_post_or_404(request, pk)
        # Drop comments by deactivated (banned) authors before building the
        # tree, so a banned member's comments vanish just like their posts do —
        # and their replies go with them (an orphaned reply is never reached).
        comments = list(
            post.comments.select_related("author").filter(
                author__is_active=True
            )
        )
        # Prune to the viewer's connections (plus themselves) — the same rule for
        # personal and group posts.
        visible_author_ids = connected_ids | {request.user.id}
        tree = build_visible_comment_tree(comments, visible_author_ids)
        data = CommentSerializer(
            tree, many=True, context={"request": request}
        ).data
        return Response(data)

    def post(self, request, pk):
        post, _connected_ids = self._get_post_or_404(request, pk)
        serializer = CommentCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        parent = serializer.validated_data.get("parent")
        if parent is not None and parent.post_id != post.id:
            raise ValidationError(
                {"parent": "You can only reply to a comment on this post."}
            )
        serializer.save(author=request.user, post=post)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


# --- Direct messaging (Phase 5) ------------------------------------------------


def user_conversations(user):
    """The conversations ``user`` participates in that should be shown to them,
    newest-activity first.

    Hides a conversation whose other participant is deactivated or blocked
    (either direction) — a block cuts the pair off from each other, so the thread
    disappears from both lists, consistent with the feed hiding a banned member.
    """
    blocked_ids = set(
        Block.objects.filter(Q(blocker=user) | Q(blocked=user)).values_list(
            "blocker_id", "blocked_id"
        )
    )
    # Flatten the (blocker, blocked) pairs into "everyone I'm blocked-with" —
    # the endpoint that isn't me in each pair.
    hidden = {
        blocker if blocker != user.id else blocked
        for blocker, blocked in blocked_ids
    }
    return (
        Conversation.objects.filter(Q(user_a=user) | Q(user_b=user))
        .filter(
            # The *other* participant must be active.
            Q(user_a=user, user_b__is_active=True)
            | Q(user_b=user, user_a__is_active=True)
        )
        .exclude(user_a_id__in=hidden)
        .exclude(user_b_id__in=hidden)
        .select_related("user_a", "user_b")
        .order_by("-updated_at", "-id")
    )


class ConversationListCreateView(generics.ListCreateAPIView):
    """List your conversations (GET) or open one with a connected person (POST).

    GET returns your threads most-recent-activity first, each with the other
    person, a last-message preview, and your unread count — time-ordered, never
    ranked. POST is **get-or-create**: body ``{ user_id }`` returns the existing
    1:1 thread with that person or makes a new one, but only if you *can* message
    them (mutually connected, both active, neither blocked) — otherwise 403, or
    404 for an unknown/inactive user.
    """

    serializer_class = ConversationSerializer

    def get_queryset(self):
        return user_conversations(self.request.user)

    def list(self, request, *args, **kwargs):
        queryset = self.get_queryset()
        page = self.paginate_queryset(queryset)
        source = page if page is not None else list(queryset)
        decorate_conversations(source, request.user)
        serializer = self.get_serializer(source, many=True)
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data)

    def create(self, request, *args, **kwargs):
        user_id = request.data.get("user_id")
        if user_id is None:
            raise ValidationError({"user_id": "This field is required."})
        other = get_object_or_404(User, pk=user_id, is_active=True)
        if other == request.user:
            raise ValidationError(
                {"user_id": "You can't message yourself."}
            )
        if not can_message(request.user, other):
            raise PermissionDenied(
                "You can only message people you're connected with."
            )

        a, b = sorted((request.user, other), key=lambda u: u.id)
        try:
            with transaction.atomic():
                convo, _created = Conversation.objects.get_or_create(
                    user_a=a, user_b=b
                )
        except IntegrityError:
            # A concurrent open created the row between our check and insert;
            # the one-per-pair constraint rejected ours — just fetch theirs.
            convo = Conversation.objects.get(
                Q(user_a=a, user_b=b) | Q(user_a=b, user_b=a)
            )

        decorate_conversations([convo], request.user)
        serializer = self.get_serializer(convo)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class ConversationDetailView(generics.RetrieveAPIView):
    """A single conversation (``GET /conversations/<pk>/``) — the other person,
    last-message preview, and your unread count.

    Drives the thread page's header (who you're talking to) so it's correct even
    on a cold page load/refresh, not only when arriving from the list.
    Participant-scoped, and hidden (404) if the pair is blocked either way."""

    serializer_class = ConversationSerializer

    def get_object(self):
        user = self.request.user
        convo = get_object_or_404(
            Conversation.objects.select_related("user_a", "user_b").filter(
                Q(user_a=user) | Q(user_b=user)
            ),
            pk=self.kwargs["pk"],
        )
        other = convo.other_participant(user)
        if is_blocked_between(user, other):
            raise NotFound()
        decorate_conversations([convo], user)
        # Whether new messages are still allowed (drives the composer). History
        # stays readable after a disconnect even when this is False.
        convo._can_message = can_message(user, other)
        return convo


class ConversationMessagesView(generics.ListAPIView):
    """The messages in a conversation (GET) and sending one (POST) at
    ``/conversations/<pk>/messages/``.

    You must be a participant, else 404 (we don't reveal a thread you're not in).
    A blocked pair can't see the thread at all (404). GET returns messages
    oldest-first, paginated. POST re-checks ``can_message`` — disconnecting or a
    block stops *future* messages even though the history stays visible — takes
    the sender from the session, bumps the conversation's activity time, and
    marks it read for you (you've clearly caught up).
    """

    serializer_class = MessageSerializer

    def _conversation(self):
        # Participant-scoped: only the two people in the thread can reach it, and
        # a block hides it from both. 404 otherwise (don't leak its existence).
        user = self.request.user
        convo = get_object_or_404(
            Conversation.objects.select_related("user_a", "user_b").filter(
                Q(user_a=user) | Q(user_b=user)
            ),
            pk=self.kwargs["pk"],
        )
        other = convo.other_participant(user)
        if is_blocked_between(user, other):
            raise NotFound()
        return convo, other

    def get_queryset(self):
        convo, _other = self._conversation()
        return convo.messages.select_related("sender")

    def post(self, request, pk):
        convo, other = self._conversation()
        if not can_message(request.user, other):
            raise PermissionDenied(
                "You can no longer message this person."
            )
        serializer = MessageCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        now = timezone.now()
        with transaction.atomic():
            message = Message.objects.create(
                conversation=convo,
                sender=request.user,
                text=serializer.validated_data["text"],
            )
            # Bump activity so the thread rises to the top of both lists.
            Conversation.objects.filter(pk=convo.pk).update(updated_at=now)
            # Sending implies you've read everything up to now.
            ConversationRead.objects.update_or_create(
                conversation=convo,
                user=request.user,
                defaults={"last_read_at": now},
            )
        out = MessageSerializer(message, context={"request": request})
        return Response(out.data, status=status.HTTP_201_CREATED)


class ConversationReadView(APIView):
    """Mark a conversation read up to now (``POST /conversations/<pk>/read/``),
    which clears your unread count for it. Participant-only (404 otherwise)."""

    def post(self, request, pk):
        user = request.user
        convo = get_object_or_404(
            Conversation.objects.filter(Q(user_a=user) | Q(user_b=user)),
            pk=pk,
        )
        ConversationRead.objects.update_or_create(
            conversation=convo,
            user=user,
            defaults={"last_read_at": timezone.now()},
        )
        return Response({"detail": "Marked read."}, status=status.HTTP_200_OK)


class MessageDeleteView(APIView):
    """Delete your own message
    (``DELETE /conversations/<pk>/messages/<message_id>/``).

    Soft delete (v1 scope): only the sender can delete, and only their own
    message. The row stays — blanked, with ``deleted_at`` set — so the thread
    still renders a "message deleted" placeholder in the right spot rather than
    silently reshuffling. 404 if it isn't your message or isn't in this thread.
    """

    def delete(self, request, pk, message_id):
        message = get_object_or_404(
            Message,
            pk=message_id,
            conversation_id=pk,
            sender=request.user,
        )
        if not message.is_deleted:
            message.text = ""
            message.deleted_at = timezone.now()
            message.save(update_fields=["text", "deleted_at"])
        return Response(
            {"detail": "Message deleted."}, status=status.HTTP_200_OK
        )


class UnreadMessageCountView(APIView):
    """Your total unread-message count across all conversations, for the nav
    badge (``GET /messages/unread-count/``). One query, mirrors the per-thread
    unread rule (not yours, not deleted, newer than your read marker), and
    ignores blocked/inactive threads via ``user_conversations``."""

    def get(self, request):
        user = request.user
        convo_ids = list(user_conversations(user).values_list("id", flat=True))
        if not convo_ids:
            return Response({"count": 0})
        read_at = ConversationRead.objects.filter(
            conversation_id=OuterRef("conversation_id"), user=user
        ).values("last_read_at")[:1]
        count = (
            Message.objects.filter(
                conversation_id__in=convo_ids, deleted_at__isnull=True
            )
            .exclude(sender=user)
            .annotate(read_at=Subquery(read_at))
            .filter(Q(read_at__isnull=True) | Q(created_at__gt=F("read_at")))
            .count()
        )
        return Response({"count": count})


class BlockView(APIView):
    """Block (POST) or unblock (DELETE) the user at ``/users/<pk>/block/``.

    Blocking is the strong, explicit cut: it hides your conversation from both
    of you, stops further messages, and bars (re)connecting — and it also removes
    any existing connection between you, so blocking someone disconnects them.
    Idempotent both ways. You can't block yourself (400) or an unknown/inactive
    user (404). DELETE lifts only *your* block; if they've also blocked you, that
    stays.
    """

    def post(self, request, pk):
        target = get_object_or_404(User, pk=pk, is_active=True)
        if target == request.user:
            return Response(
                {"detail": "You can't block yourself."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        with transaction.atomic():
            Block.objects.get_or_create(
                blocker=request.user, blocked=target
            )
            # Blocking severs any connection — you shouldn't stay "connected"
            # to someone you've blocked.
            Connection.objects.filter(
                Q(requester=request.user, requestee=target)
                | Q(requester=target, requestee=request.user)
            ).delete()
        return Response(
            {"detail": "Blocked.", "is_blocked": True},
            status=status.HTTP_200_OK,
        )

    def delete(self, request, pk):
        target = get_object_or_404(User, pk=pk)
        Block.objects.filter(blocker=request.user, blocked=target).delete()
        return Response(
            {"detail": "Unblocked.", "is_blocked": False},
            status=status.HTTP_200_OK,
        )


# --- Groups (Phase 6) ----------------------------------------------------------


def _active_admin_count(group_id):
    return GroupMembership.objects.filter(
        group_id=group_id, status=ACTIVE, role=ADMIN
    ).count()


def _member_group_or_404(user, pk):
    """Fetch a group the user is an **active** member of, or 404.

    404 (not 403) for a non-member so a private group's existence isn't leaked —
    the same discipline as a non-connection's profile. Stashes the caller's role
    on the instance as ``_your_role`` for the admin-gate checks and the response.
    """
    group = get_object_or_404(Group, pk=pk)
    role = group_role(user, group.id)
    if role is None:
        raise NotFound()
    group._your_role = role
    return group


def _attach_roles(groups, user):
    """Attach each group's ``_your_role`` for ``user`` in one query (no N+1)."""
    groups = list(groups)
    ids = [g.id for g in groups]
    roles = dict(
        GroupMembership.objects.filter(
            group_id__in=ids, user=user, status=ACTIVE
        ).values_list("group_id", "role")
    )
    for g in groups:
        g._your_role = roles.get(g.id)
    return groups


def parse_bool(value):
    """Coerce a request flag (query param or form field) to a bool.

    Accepts the common truthy spellings a browser or user might send; anything
    else (including ``None``) is False. One helper so every boolean flag in the
    API reads the same tokens instead of each endpoint inventing its own set.
    """
    return str(value).strip().lower() in ("1", "true", "on", "yes")


class GroupListCreateView(generics.ListCreateAPIView):
    """List the groups you're an active member of (GET) or create one (POST).

    GET is ordered by name (not "relevance" — the no-algorithm rule applies here
    too), each row carrying ``member_count`` and ``your_role``. POST creates the
    group and makes you its first member as an **admin**, atomically; accepts an
    optional multipart ``avatar`` (validated + downscaled + EXIF-stripped).
    """

    serializer_class = GroupSerializer
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        user = self.request.user
        # Filter via Exists (a subquery, no join) so the member_count Count has
        # the memberships table to itself and can't double-count.
        mine = GroupMembership.objects.filter(
            group=OuterRef("pk"), user=user, status=ACTIVE
        )
        return (
            Group.objects.filter(Exists(mine))
            .annotate(
                member_count=Count(
                    "memberships", filter=Q(memberships__status=ACTIVE)
                )
            )
            .order_by("name", "id")
        )

    def list(self, request, *args, **kwargs):
        queryset = self.get_queryset()
        page = self.paginate_queryset(queryset)
        source = page if page is not None else list(queryset)
        _attach_roles(source, request.user)
        serializer = self.get_serializer(source, many=True)
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        avatar_file = request.FILES.get("avatar")
        processed = process_avatar(avatar_file) if avatar_file else None

        with transaction.atomic():
            group = Group.objects.create(
                name=serializer.validated_data["name"],
                description=serializer.validated_data.get("description", ""),
                creator=request.user,
            )
            if processed is not None:
                save_avatar(group, processed)
                group.save(update_fields=["avatar", "avatar_thumb"])
            # The creator is the group's first member, and its admin.
            GroupMembership.objects.create(
                group=group, user=request.user, role=ADMIN, status=ACTIVE
            )

        group.member_count = 1
        group._your_role = ADMIN
        out = self.get_serializer(group)
        return Response(out.data, status=status.HTTP_201_CREATED)


class GroupDetailView(APIView):
    """A single group: read (GET, members), edit (PATCH, admins), delete
    (DELETE, admins) at ``/groups/<pk>/``.

    Non-members get 404 everywhere (don't leak a private group's existence); a
    member who isn't an admin gets 403 on PATCH/DELETE.
    """

    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def _serialize(self, group, request):
        group.member_count = group.active_member_count()
        return GroupSerializer(group, context={"request": request}).data

    def get(self, request, pk):
        group = _member_group_or_404(request.user, pk)
        return Response(self._serialize(group, request))

    def patch(self, request, pk):
        group = _member_group_or_404(request.user, pk)
        if group._your_role != ADMIN:
            raise PermissionDenied("Only an admin can edit this group.")
        serializer = GroupSerializer(
            group,
            data=request.data,
            partial=True,
            context={"request": request},
        )
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        update_fields = []
        if "name" in data:
            group.name = data["name"]
            update_fields.append("name")
        if "description" in data:
            group.description = data["description"]
            update_fields.append("description")

        avatar_file = request.FILES.get("avatar")
        if avatar_file is not None:
            save_avatar(group, process_avatar(avatar_file))
            update_fields += ["avatar", "avatar_thumb"]
        elif parse_bool(request.data.get("remove_avatar")):
            clear_avatar(group)
            update_fields += ["avatar", "avatar_thumb"]

        if update_fields:
            group.save(update_fields=list(dict.fromkeys(update_fields)))
        return Response(self._serialize(group, request))

    def delete(self, request, pk):
        group = _member_group_or_404(request.user, pk)
        if group._your_role != ADMIN:
            raise PermissionDenied("Only an admin can delete this group.")
        # Cascades to memberships and the group's posts (and their photos +
        # comments) via the FKs.
        group.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class GroupPostsView(generics.ListAPIView):
    """A group's timeline (``GET /groups/<pk>/posts/``): its posts, newest-first,
    paginated. Members only — a non-member (or unknown group) gets 404, so a
    private group's contents and existence stay hidden.

    Within the group the same connection gate as everywhere else applies (via
    ``visible_posts``): you see posts by members you're connected with, not by
    co-members you don't know — and never by a deactivated author."""

    serializer_class = PostSerializer

    def get_queryset(self):
        pk = self.kwargs["pk"]
        if not is_group_member(self.request.user, pk):
            raise NotFound()
        return visible_posts(self.request.user, group=pk)


class GroupMembersView(APIView):
    """List a group's members (GET) or invite someone (POST) at
    ``/groups/<pk>/members/``.

    Members only (404 otherwise). **Any active member** may invite — but only
    one of their own connections (``can_add_to_group``), so no stranger is pulled
    into a shared space. The invite lands as a pending row the invitee accepts
    from their invites inbox (consent-first).
    """

    def get(self, request, pk):
        if not is_group_member(request.user, pk):
            raise NotFound()
        members = (
            GroupMembership.objects.filter(
                group_id=pk, status=ACTIVE, user__is_active=True
            )
            .select_related("user")
            # Admins first, then by name — a stable, non-ranked order.
            .order_by(
                "role",
                "user__first_name",
                "user__last_name",
                "user__email",
            )
        )
        return Response(
            GroupMemberSerializer(
                members, many=True, context={"request": request}
            ).data
        )

    def post(self, request, pk):
        group = get_object_or_404(Group, pk=pk)
        if not is_group_member(request.user, group.id):
            raise NotFound()

        user_id = request.data.get("user_id")
        if not user_id:
            raise ValidationError({"user_id": "This field is required."})
        invitee = get_object_or_404(User, pk=user_id, is_active=True)
        if invitee == request.user:
            raise ValidationError({"user_id": "You're already in this group."})

        # Report an existing membership/invite *before* the connection gate:
        # co-members needn't be connected, so an already-in member who isn't your
        # connection should hear "already a member", not a misleading "you're not
        # connected".
        existing = GroupMembership.objects.filter(
            group=group, user=invitee
        ).first()
        if existing is not None:
            detail = (
                "They're already a member."
                if existing.status == ACTIVE
                else "They've already been invited."
            )
            raise ValidationError({"user_id": detail})

        if not can_add_to_group(request.user, invitee):
            raise PermissionDenied(
                "You can only invite people you're connected with."
            )
        try:
            with transaction.atomic():
                GroupMembership.objects.create(
                    group=group,
                    user=invitee,
                    role=MEMBER,
                    status=INVITED,
                    invited_by=request.user,
                )
        except IntegrityError:
            # A concurrent invite won the race; the one-row-per-pair constraint
            # rejected ours.
            raise ValidationError(
                {"user_id": "They've already been invited."}
            ) from None
        return Response(
            {"detail": "Invitation sent."}, status=status.HTTP_201_CREATED
        )


class GroupMemberDetailView(APIView):
    """Remove a member, or leave the group yourself
    (``DELETE /groups/<pk>/members/<user_id>/``).

    You can always remove **yourself** (leave); removing **someone else** is
    admin-only. The last-admin guardrail applies either way: an admin can't leave
    or be removed while they're the only admin — promote someone first — so a
    group is never orphaned.
    """

    def delete(self, request, pk, user_id):
        group = get_object_or_404(Group, pk=pk)
        my_role = group_role(request.user, group.id)
        if my_role is None:
            raise NotFound()

        is_self = user_id == request.user.id
        if not is_self and my_role != ADMIN:
            raise PermissionDenied("Only an admin can remove members.")

        target = get_object_or_404(
            GroupMembership, group=group, user_id=user_id, status=ACTIVE
        )
        if target.role == ADMIN and _active_admin_count(group.id) <= 1:
            raise ValidationError(
                {
                    "detail": (
                        "Promote another member to admin first — a group must "
                        "keep at least one admin."
                    )
                }
            )
        target.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class GroupMemberRoleView(APIView):
    """Promote/demote a member between admin and member
    (``POST /groups/<pk>/members/<user_id>/role/``), admin-only.

    Body ``{ role: "admin" | "member" }``. The last-admin guardrail blocks
    demoting the only admin.
    """

    def post(self, request, pk, user_id):
        group = get_object_or_404(Group, pk=pk)
        my_role = group_role(request.user, group.id)
        if my_role is None:
            raise NotFound()
        if my_role != ADMIN:
            raise PermissionDenied("Only an admin can change roles.")

        role = request.data.get("role")
        if role not in (ADMIN, MEMBER):
            raise ValidationError({"role": 'Must be "admin" or "member".'})

        target = get_object_or_404(
            GroupMembership, group=group, user_id=user_id, status=ACTIVE
        )
        if (
            target.role == ADMIN
            and role == MEMBER
            and _active_admin_count(group.id) <= 1
        ):
            raise ValidationError(
                {"detail": "A group must keep at least one admin."}
            )
        if target.role != role:
            target.role = role
            target.save(update_fields=["role"])
        return Response({"detail": "Role updated."}, status=status.HTTP_200_OK)


class GroupInviteListView(generics.ListAPIView):
    """Your pending group invitations (``GET /group-invites/``) — the ones
    awaiting *your* acceptance, newest-first. Mirrors the connection-requests
    inbox."""

    serializer_class = GroupInviteSerializer

    def get_queryset(self):
        return (
            GroupMembership.objects.filter(
                user=self.request.user, status=INVITED
            )
            .select_related("group", "invited_by")
            .order_by("-created_at")
        )


class GroupInviteActionView(APIView):
    """Accept (join the group) or reject (delete the invite) a group invitation.
    Wired to two URLs via ``.as_view(action=...)``:
    ``/group-invites/<pk>/accept/`` and ``.../reject/``.

    Only the invitee may act on it: the row must be theirs and still pending,
    else 404 (we don't reveal invites addressed to others).
    """

    action = None

    def post(self, request, pk):
        invite = get_object_or_404(
            GroupMembership, pk=pk, user=request.user, status=INVITED
        )
        if self.action == "accept":
            invite.status = ACTIVE
            invite.save(update_fields=["status"])
            return Response({"detail": "Joined."}, status=status.HTTP_200_OK)
        invite.delete()
        return Response({"detail": "Declined."}, status=status.HTTP_200_OK)
