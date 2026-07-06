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
    process_image,
)
from .models import (
    Block,
    Comment,
    Connection,
    Conversation,
    ConversationRead,
    Message,
    Post,
    PostImage,
)
from .serializers import (
    CommentCreateSerializer,
    CommentSerializer,
    ConnectionRequestSerializer,
    ConversationSerializer,
    MessageCreateSerializer,
    MessageSerializer,
    PostSerializer,
    UserListSerializer,
)

User = get_user_model()

ACCEPTED = Connection.Status.ACCEPTED
PENDING = Connection.Status.PENDING


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


def visible_posts(user, author=None, connected_ids=None):
    """The posts ``user`` is allowed to see, newest-first.

    Private-by-default, in one place so the feed and a profile can't drift: a
    post is visible only if ``user`` wrote it or is **connected** with its
    author, and only if that author is still active (a deactivated/banned member
    disappears from feeds too, not just from the people list). Pass ``author``
    to narrow to a single person's posts (the profile page) — the same rule then
    yields their posts if allowed, or nothing if not. Pass ``connected_ids`` when
    the caller already computed the connected set, to avoid recomputing it.
    """
    if connected_ids is None:
        connected_ids = connected_user_ids(user)
    qs = (
        Post.objects.filter(
            Q(author=user) | Q(author__in=connected_ids),
            author__is_active=True,
        )
        .select_related("author")
        # A post can carry several photos; prefetch so rendering the feed
        # doesn't fire one query per post for its images.
        .prefetch_related("images")
    )
    if author is not None:
        qs = qs.filter(author=author)
    return qs


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
    """

    serializer_class = PostSerializer

    def get_queryset(self):
        return visible_posts(self.request.user)


class PostCreateView(generics.CreateAPIView):
    """Create a post as the logged-in user, optionally with photos.

    Accepts JSON (text only) or multipart (text + repeated ``images`` files).
    Every uploaded file is validated + downscaled + metadata-stripped by
    ``api.imaging.process_image`` *before* anything is written, so a bad file
    400s without creating a half-post, and no EXIF/GPS reaches storage. A post
    must have text or at least one photo.
    """

    serializer_class = PostSerializer
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

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
            # Author comes from the session, never the request body.
            post = serializer.save(author=request.user)
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

    You must be able to *see* the post (be its author or connected with them) —
    otherwise 404, same as the profile gate. GET returns the tree already pruned
    to what you may see (a not-connected author's comment and its whole subtree
    are omitted server-side, so hidden content never reaches the client). POST
    adds a comment, or a reply when ``parent`` is given; the author is taken
    from the session, never the body.
    """

    def _post(self, request, pk, connected_ids=None):
        # Reuse the shared visibility gate: 404 if you can't see this post.
        return get_object_or_404(
            visible_posts(request.user, connected_ids=connected_ids), pk=pk
        )

    def get(self, request, pk):
        # Compute the connected set once and reuse it for both the post gate and
        # the comment prune, instead of querying it twice.
        connected_ids = connected_user_ids(request.user)
        post = self._post(request, pk, connected_ids=connected_ids)
        # Drop comments by deactivated (banned) authors before building the
        # tree, so a banned member's comments vanish just like their posts do —
        # and their replies go with them (an orphaned reply is never reached).
        comments = list(
            post.comments.select_related("author").filter(
                author__is_active=True
            )
        )
        visible_author_ids = connected_ids | {request.user.id}
        tree = build_visible_comment_tree(comments, visible_author_ids)
        data = CommentSerializer(
            tree, many=True, context={"request": request}
        ).data
        return Response(data)

    def post(self, request, pk):
        post = self._post(request, pk)
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
    # Flatten the (blocker, blocked) pairs into "everyone I'm blocked-with".
    hidden = {a if a != user.id else b for pair in blocked_ids for a, b in [pair]}
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
