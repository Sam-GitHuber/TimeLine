from collections import defaultdict

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import (
    Case,
    Count,
    Exists,
    OuterRef,
    Q,
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
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from . import notifications
from .emoji import (
    MAX_REACTIONS_PER_USER_PER_TARGET,
    InvalidEmoji,
    normalise_emoji,
)
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
    Comment,
    Connection,
    Conversation,
    ConversationRead,
    Group,
    GroupMembership,
    Message,
    Notification,
    NotificationPreference,
    Participant,
    ParticipantInterval,
    Post,
    PostImage,
    Reaction,
    Report,
)
from .serializers import (
    AuthorSerializer,
    CommentCreateSerializer,
    CommentSerializer,
    ConnectionRequestSerializer,
    ConversationSerializer,
    GroupInviteSerializer,
    GroupMemberSerializer,
    GroupSerializer,
    MessageCreateSerializer,
    MessageSerializer,
    NotificationPreferencesSerializer,
    NotificationSerializer,
    PostSerializer,
    ReportCreateSerializer,
    UserListSerializer,
    summarise_reactions,
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


def visible_reactor_ids(user):
    """The set of user ids whose reactions (and comments) ``user`` may see —
    themselves plus their connections (Phase 7b).

    This is exactly the comment tree's ``visible_author_ids``: reactions prune to
    the same boundary as comments, so a reaction by someone the viewer isn't
    connected with is never counted and can't leak a stranger. Group membership
    gates *access* to a post; it does not widen this set (you still only see
    reactions from members you're connected with — mirroring group comments).
    """
    return connected_user_ids(user) | {user.id}


class ReactionContextMixin:
    """Adds ``visible_reactor_ids`` to serializer context so ``PostSerializer``
    can build its pruned reaction summary. Mixed into the post-serving views.

    Computed once per request (not per post), so the whole feed's reaction
    pruning costs one extra connections query, not N.
    """

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["visible_reactor_ids"] = visible_reactor_ids(self.request.user)
        return context


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
    stay fully mutually-connected. Excludes anyone who has left, and anyone
    whose account is deactivated: a disabled account can no longer connect to
    anyone, so counting it toward the clique would strand pending invitees
    forever (they can never satisfy a ``must_connect_with`` that includes a
    deactivated member, which ``must_connect_with`` itself already filters out)."""
    return set(
        convo.participants.filter(
            status=ACTIVE_P, left_at__isnull=True, user__is_active=True
        ).values_list("user_id", flat=True)
    )


def participant_user_ids(convo):
    """Everyone still attached to ``convo`` — active or pending, not left."""
    return set(
        convo.participants.filter(left_at__isnull=True).values_list("user_id", flat=True)
    )


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


def _shared_active_chats(u1, u2):
    """Group chats where both ``u1`` and ``u2`` are currently active
    participants — the chats a disconnect/block between them would touch.

    Restricted to ``kind=GROUP`` on purpose: a direct 1:1 also has both people
    as active participants (see ``_ensure_direct_participants`` / the ``0009``
    backfill), but direct threads never use the pending/clique mechanism — their
    composer gate is ``can_message`` and their history must stay readable after
    a disconnect (the Phase 5 rule). Without this filter a disconnect would sweep
    the pair's own DM into ``sever_shared_chats``, dropping the initiator to
    ``pending`` in their own 1:1 — locking them out of their message history
    (``get_queryset`` 403s a non-active viewer) and showing the group
    "connect to join" panel on a direct thread."""
    return Conversation.objects.filter(
        kind=Conversation.Kind.GROUP,
        participants__user=u1, participants__status=ACTIVE_P, participants__left_at__isnull=True
    ).filter(
        participants__user=u2, participants__status=ACTIVE_P, participants__left_at__isnull=True
    ).distinct()


def sever_shared_chats(initiator, other, when):
    """Drop the ``initiator`` to pending in every chat both are active in.

    Only closes the initiator's interval here — it does *not* re-run
    ``promote_participants`` itself. The caller must do that only after the
    ``Connection`` row between initiator and other has actually been deleted:
    if promotion ran first (or the Connection were still intact), the
    initiator would still show up in ``connected_user_ids(initiator)`` as
    connected to ``other`` and would be immediately re-promoted, defeating the
    whole point of severing. Returns the affected conversations so the caller
    can re-settle promotion afterwards (for the other, still-connected
    participants, not the initiator).
    """
    convos = list(_shared_active_chats(initiator, other))
    for convo in convos:
        p = convo.participants.get(user=initiator)
        deactivate(p, when)
    return convos


def promote_shared_chats(u1, u2, when):
    """After u1↔u2 become connected, promote eligible pendings in every chat they
    both belong to."""
    shared = Conversation.objects.filter(
        participants__user=u1, participants__left_at__isnull=True
    ).filter(
        participants__user=u2, participants__left_at__isnull=True
    ).distinct()
    for convo in shared:
        promote_participants(convo, when)


def must_connect_with(convo, user):
    """Active members ``user`` must still connect with to join (drives the
    locked pending panel + the 'connect with X & Y' prompt)."""
    connected = connected_user_ids(user)
    missing_ids = active_participant_ids(convo) - connected - {user.id}
    return list(User.objects.filter(id__in=missing_ids, is_active=True))


def _viewer_participant_status(convo, user):
    """``user``'s membership state in ``convo`` — ``"active"``/``"pending"`` —
    or ``None`` if they aren't in it at all.

    Reads the ``Participant`` row when there is one: every group chat (all
    members get one) and every 1:1 opened since ``_create_direct`` started
    creating them (see ``_ensure_direct_participants``). Falls back to the
    legacy ``user_a``/``user_b`` pair — implicitly ``"active"`` — for a direct
    thread that predates Participant rows, or is built straight off the model
    (as Phase 5's test suite still does), so those keep behaving exactly as
    they did before Phase 6a.
    """
    row = Participant.objects.filter(
        conversation=convo, user=user, left_at__isnull=True
    ).first()
    if row is not None:
        return row.status
    if convo.kind == Conversation.Kind.DIRECT and user.id in (
        convo.user_a_id,
        convo.user_b_id,
    ):
        return ACTIVE_P
    return None


def _messages_for_viewer(convo, user):
    """The messages ``user`` may see in ``convo``: interval-clipped via
    ``visible_messages_for`` when they have a ``Participant`` row, else the
    full thread — a legacy/Participant-less direct conversation (see
    ``_viewer_participant_status``)."""
    if Participant.objects.filter(
        conversation=convo, user=user, left_at__isnull=True
    ).exists():
        return visible_messages_for(convo, user)
    return convo.messages.select_related("sender")


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


def unread_count_for(convo, user, read_at):
    """How many messages ``user`` hasn't read in ``convo``: those visible to
    them (interval-clipped via ``_messages_for_viewer``), not their own, not
    deleted, and newer than their read marker (all of them if ``read_at`` is
    ``None`` — they've never opened it). The single implementation of the
    unread rule, shared by the per-thread badge (``decorate_conversations``)
    and the nav-badge total (``UnreadMessageCountView``) so the two can't
    drift."""
    qs = (
        _messages_for_viewer(convo, user)
        .filter(deleted_at__isnull=True)
        .exclude(sender=user)
    )
    if read_at is not None:
        qs = qs.filter(created_at__gt=read_at)
    return qs.count()


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


def chat_display_for(convo):
    """The ``{id, name}`` dict for a group-scoped chat, else ``None`` — the
    ``group`` field the list/detail serializer renders. ``title``/``kind`` come
    straight off the model, so they aren't returned here."""
    if convo.group_id:
        return {"id": convo.group_id, "name": convo.group.name}
    return None


def _chat_label(convo, viewer):
    """A human label for a chat in the disconnect-impact warning: its title, or
    — for an untitled chat — a comma-joined list of the other active members'
    names, so the modal never renders a blank bullet. Mirrors the untitled-group
    fallback ``ConversationRow`` uses on the frontend."""
    if convo.title:
        return convo.title
    names = [
        p.user.display_name
        for p in convo.participants.filter(status=ACTIVE_P, left_at__isnull=True)
        .exclude(user=viewer)
        .select_related("user")
    ]
    return ", ".join(names) if names else "Group chat"


def decorate_conversations(conversations, user):
    """Attach the per-viewer fields the conversation list/detail serializer
    needs.

    For each conversation, sets: ``.my_status`` (your membership state —
    ``"active"``/``"pending"``, via ``_viewer_participant_status``),
    ``.participant_rows`` (active + pending members, not left, with users —
    what ``participants`` renders), ``.must_connect`` (the active members you
    still need to connect with, while pending — else ``[]``),
    ``._group_display`` (via ``chat_display_for``), and — for direct chats only
    — ``.other`` (backward-compatible with Phase 5). Also attaches the latest
    message as ``._last_message`` (or ``None``, one query for the whole page)
    and ``.unread_count`` (messages you didn't send, newer than your read
    marker, not deleted, clipped to your visible interval — a per-conversation
    query each; acceptable at family scale).
    """
    conversations = list(conversations)
    for convo in conversations:
        convo.my_status = _viewer_participant_status(convo, user)
        convo.participant_rows = list(
            convo.participants.filter(left_at__isnull=True)
            .select_related("user")
            .order_by("user__first_name", "user__last_name", "user__email")
        )
        convo.must_connect = (
            must_connect_with(convo, user) if convo.my_status == PENDING_P else []
        )
        convo._group_display = chat_display_for(convo)
        if convo.kind == Conversation.Kind.DIRECT:
            convo.other = convo.other_participant(user)

    ids = [c.id for c in conversations]
    if not ids:
        return conversations

    # Your read marker per conversation, in one query.
    read_at_by_convo = dict(
        ConversationRead.objects.filter(
            conversation_id__in=ids, user=user
        ).values_list("conversation_id", "last_read_at")
    )

    for convo in conversations:
        # The last-message preview must be drawn from what *this viewer* may
        # see, not the conversation's globally-latest message — otherwise a
        # pending (or since-severed) member, who is interval-clipped out of the
        # thread, would get the text of a message they can't read leaked into
        # their list/detail payload. Empty visible set → no preview.
        visible = _messages_for_viewer(convo, user)
        convo._last_message = visible.order_by("-created_at", "-id").first()
        convo.unread_count = unread_count_for(
            convo, user, read_at_by_convo.get(convo.id)
        )
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
        # ``reactions`` too, so the serializer's pruned reaction summary is built
        # from prefetched rows rather than a query per post.
        .prefetch_related("images", "reactions")
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
        .prefetch_related("images", "reactions")
    )


def can_view_post(user, post, connected_ids=None):
    """Whether ``user`` is allowed to *see* ``post`` — the same private-by-default
    gate the feed, profiles and the comments view apply, in one place so a caller
    that needs a yes/no (rather than a queryset) can't drift from it. A group post
    additionally requires active membership. Pass ``connected_ids`` if the caller
    already has it, to avoid recomputing.
    """
    if post.group_id and not is_group_member(user, post.group_id):
        return False
    return (
        visible_posts(user, connected_ids=connected_ids, group=post.group_id or None)
        .filter(pk=post.pk)
        .exists()
    )


def can_view_comment(user, comment, connected_ids=None):
    """Whether ``user`` can see ``comment``. Mirrors the pruned comment tree
    (``PostCommentsView``): the comment's post must be visible, the comment's
    author must be active, and — matching the connection-pruned tree — the author
    must be the viewer or one of their connections.
    """
    if connected_ids is None:
        connected_ids = connected_user_ids(user)
    if not comment.author.is_active:
        return False
    if comment.author_id != user.id and comment.author_id not in connected_ids:
        return False
    return can_view_post(user, comment.post, connected_ids=connected_ids)


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


@api_view(["GET"])
def media_auth(request):
    """Authorization gate for uploaded media (Phase 7 security hardening).

    Uploaded photos and avatars are real friends'/family's images, so they must
    not be world-readable. In production they're served straight off disk by
    Caddy (fast), but Caddy asks *this* endpoint first via ``forward_auth`` on
    every ``/media/`` request — we return 204 only for a logged-in, **active**
    account, and Caddy serves the file only on that 2xx. Anything else (no
    cookie, expired/invalid token, a since-deactivated account) is a non-2xx
    here, so Caddy denies the file. Net effect: a media URL that leaks off the
    site (referrer header, shared link, someone's browser history) is useless to
    a logged-out stranger, and a banned member's saved URLs stop resolving.

    This is *authentication* gating: any logged-in member may fetch any media
    whose UUID filename they already hold. Full per-author connection gating
    (checking the viewer is connected to the photo's author) is a heavier,
    deferred step — see docs/reference/feed-and-posts.md. The unguessable UUID filename
    (``api/imaging.py``) remains a second layer underneath this.

    Relies on the default auth (JWT-in-cookie) + ``IsAuthenticated`` permission;
    ``get_user`` in SimpleJWT already rejects an inactive user's token, so no
    extra active-check is needed here. It's a safe GET, so no CSRF applies.
    """
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["GET"])
@permission_classes([AllowAny])
def healthz(request):
    """Liveness/readiness probe for uptime monitoring (Phase 7).

    A tiny public endpoint the on-box healthcheck timer curls every few minutes
    (``deploy/healthcheck.sh``): a 200 means the whole serving path is alive —
    Caddy routed the request, gunicorn answered, and the database is reachable.
    We deliberately run a trivial ``SELECT 1`` because "Django process up but
    Postgres down" is a real outage the monitor must catch; a bare "return 200"
    would report healthy while the site was actually broken.

    On a DB error we return **503** (not 500) so the check reads as "temporarily
    unavailable" rather than a code bug. The body is intentionally minimal — this
    is unauthenticated, so it must not leak version strings, hostnames, or counts.
    """
    from django.db import connection

    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception:
        return Response(
            {"status": "unhealthy"},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    return Response({"status": "ok"})


class FeedView(ReactionContextMixin, generics.ListAPIView):
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


class PostCreateView(ReactionContextMixin, generics.CreateAPIView):
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
        # before creating the post, so there's never an orphaned text row. Name
        # the offending photo in the error — in a batch of 10 an opaque "too
        # large"/"not a valid image" leaves the user guessing which one to drop.
        processed = []
        for f in files:
            try:
                processed.append(
                    process_image(
                        f,
                        max_edge=POST_IMAGE_MAX_EDGE,
                        thumb_edge=POST_THUMB_EDGE,
                    )
                )
            except ValidationError as exc:
                detail = exc.detail
                msg = detail[0] if isinstance(detail, list) else detail
                raise ValidationError({"images": f"{f.name}: {msg}"}) from exc

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


class PostDetailView(ReactionContextMixin, generics.RetrieveAPIView):
    """A single post by id (``GET /api/posts/<pk>/``) — the permalink endpoint.

    Backs the ``/p/:id`` permalink page, which a notification deep-links to so you
    can open a thread straight to the reply you were notified about — even one 20
    replies deep, or on a post that isn't on the first page of any feed. Fetching
    the post by id (rather than hoping it's already loaded in some list) is the
    only way that's reliable.

    Same private-by-default gate as every other post surface: ``can_view_post``
    (connection gate, plus active membership for a group post). A post you can't
    see is a 404 — existence isn't leaked, matching the feed/comments/reactions.
    The comment *tree* still comes from ``PostCommentsView``; this returns just the
    post (with its pruned reaction summary, via ``ReactionContextMixin``).
    """

    serializer_class = PostSerializer

    def get_object(self):
        post = get_object_or_404(
            Post.objects.select_related("author", "group").prefetch_related(
                "images", "reactions"
            ),
            pk=self.kwargs["pk"],
        )
        if not can_view_post(self.request.user, post):
            raise NotFound()
        return post


class UserPostsView(ReactionContextMixin, generics.ListAPIView):
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
    """People, with your relationship to each. Two audiences share this list:

    - no filter — every other active member (the raw list the message/group
      pickers filter client-side for connections),
    - ``?filter=connected`` — only people you're accepted-connected with (the
      People hub's **Connections** tab),
    - ``?filter=discover`` — everyone you're *not* yet connected with (its
      **Discover** tab), so people already in Connections don't clutter the
      "find new people" view. Pending/incoming requests still show, so you can
      act on them there.

    Same serializer and pagination throughout; the filter just narrows the rows,
    so there's one endpoint to keep in step rather than three.
    """

    serializer_class = UserListSerializer

    def get_queryset(self):
        user = self.request.user
        qs = (
            User.objects.filter(is_active=True)
            .exclude(pk=user.pk)
            .annotate(connection_status=connection_status_annotation(user))
            .order_by("first_name", "last_name", "email")
        )
        filter_ = self.request.query_params.get("filter")
        if filter_ == "connected":
            qs = qs.filter(pk__in=connected_user_ids(user))
        elif filter_ == "discover":
            qs = qs.exclude(pk__in=connected_user_ids(user))
        return qs


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
                    connection = Connection.objects.create(
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
                # Notify the addressee that someone wants to connect (Phase 8).
                notifications.create_notification(
                    recipient=target,
                    actor=request.user,
                    kind=Notification.Kind.CONNECTION_REQUEST,
                    connection=connection,
                )
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
            promote_shared_chats(existing.requester, existing.requestee, timezone.now())
            # Approving here resolves *their* request notification to you, and
            # tells the requester you accepted (Phase 8).
            notifications.address_connection_request(request.user, existing)
            notifications.create_notification(
                recipient=existing.requester,
                actor=request.user,
                kind=Notification.Kind.CONNECTION_ACCEPTED,
                connection=existing,
            )
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
        now = timezone.now()
        with transaction.atomic():
            # Sever must run — and close the initiator's interval — before the
            # Connection row is gone; see sever_shared_chats' docstring for why
            # promotion is deferred until after the delete below.
            convos = sever_shared_chats(request.user, target, now)
            Connection.objects.filter(
                Q(requester=request.user, requestee=target)
                | Q(requester=target, requestee=request.user)
            ).delete()
            for convo in convos:
                promote_participants(convo, now)
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
            promote_shared_chats(connection.requester, connection.requestee, timezone.now())
            # Resolve the request notification we're acting on, and notify the
            # requester that we accepted (Phase 8). Rejecting instead deletes the
            # Connection, which cascade-deletes its request notification.
            notifications.address_connection_request(request.user, connection)
            notifications.create_notification(
                recipient=connection.requester,
                actor=request.user,
                kind=Notification.Kind.CONNECTION_ACCEPTED,
                connection=connection,
            )
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
            post.comments.select_related("author")
            .prefetch_related("reactions")
            .filter(author__is_active=True)
        )
        # Prune to the viewer's connections (plus themselves) — the same rule for
        # personal and group posts. Reactions on those comments prune to the very
        # same set, so it's passed straight into the serializer context.
        visible_author_ids = connected_ids | {request.user.id}
        tree = build_visible_comment_tree(comments, visible_author_ids)
        data = CommentSerializer(
            tree,
            many=True,
            context={
                "request": request,
                "visible_reactor_ids": visible_author_ids,
            },
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
        comment = serializer.save(author=request.user, post=post)
        # Notify the person being replied to (Phase 8). A top-level comment
        # notifies the post's author (post_reply); a reply notifies the parent
        # comment's author (comment_reply). create_notification handles the
        # self/mute/visibility rules and no-ops when they apply.
        if parent is None:
            notifications.create_notification(
                recipient=post.author,
                actor=request.user,
                kind=Notification.Kind.POST_REPLY,
                post=post,
            )
        else:
            notifications.create_notification(
                recipient=parent.author,
                actor=request.user,
                kind=Notification.Kind.COMMENT_REPLY,
                comment=comment,
            )
        return Response(serializer.data, status=status.HTTP_201_CREATED)


# --- Reactions (Phase 7b) ------------------------------------------------------


def _toggle_reaction(request, target_kwargs):
    """Add or remove the requesting user's emoji reaction on a target.

    ``target_kwargs`` is ``{"post": post}`` or ``{"comment": comment}`` — the
    caller has already checked the target is visible to the user. Re-adding an
    emoji you've already used removes it (the toggle). Adding a *new* emoji is
    capped per user per target to bound abuse. Returns the target's freshly
    aggregated, viewer-pruned reaction summary so the client can update in place.
    """
    raw = request.data.get("emoji", "")
    try:
        emoji = normalise_emoji(raw)
    except InvalidEmoji as exc:
        # Return a fixed, author-controlled message rather than the exception's
        # text. normalise_emoji only ever raises safe literals, but piping an
        # exception's string into an API response is the "information exposure
        # through an exception" pattern CodeQL flags — so we don't. `from exc`
        # still chains the original for server-side logs.
        raise ValidationError(
            {"emoji": "That's not a valid emoji."}
        ) from exc

    mine = Reaction.objects.filter(user=request.user, **target_kwargs)
    existing = mine.filter(emoji=emoji).first()
    if existing is not None:
        existing.delete()
    else:
        # Count distinct emoji I've put on this target (one row per emoji, by the
        # unique constraint) and refuse once the cap is hit.
        if mine.count() >= MAX_REACTIONS_PER_USER_PER_TARGET:
            raise ValidationError(
                {
                    "emoji": (
                        "You've reacted to this as many times as allowed "
                        f"({MAX_REACTIONS_PER_USER_PER_TARGET})."
                    )
                }
            )
        try:
            # Own savepoint so a lost race rolls back just this insert, not the
            # whole request transaction (which ATOMIC_REQUESTS may wrap).
            with transaction.atomic():
                Reaction.objects.create(
                    user=request.user, emoji=emoji, **target_kwargs
                )
        except IntegrityError:
            # A concurrent identical "add" (e.g. a double-click) landed the same
            # (user, target, emoji) row between our read and our write. Both
            # clicks wanted it added, so honour that: swallow the duplicate and
            # return the current summary rather than 500.
            pass
        # Notify the target's author that someone reacted (Phase 8) — only on an
        # *add*, never a removal. create_notification dedupes an unread reaction
        # notification per (recipient, actor, target), so react/un-react/re-react
        # or a second emoji bumps one row rather than stacking near-duplicates.
        reacted_target = target_kwargs.get("post") or target_kwargs.get("comment")
        notifications.create_notification(
            recipient=reacted_target.author,
            actor=request.user,
            kind=Notification.Kind.REACTION,
            **target_kwargs,
        )

    target = target_kwargs.get("post") or target_kwargs.get("comment")
    summary = summarise_reactions(
        target.reactions.all(), visible_reactor_ids(request.user), request.user.id
    )
    return Response({"reactions": summary})


def _reactors_grouped(request, target):
    """Who reacted to ``target``, grouped by emoji, pruned to people the viewer
    may see — so a not-connected reactor never appears.

    Returns ``[{emoji, count, users:[{id, display_name, avatar_thumb}]}]``,
    ordered by count (desc) then emoji, matching the embedded summary's order.
    """
    visible = visible_reactor_ids(request.user)
    rows = (
        target.reactions.filter(user_id__in=visible)
        .select_related("user")
        .order_by("created_at", "id")
    )
    grouped = {}
    for reaction in rows:
        grouped.setdefault(reaction.emoji, []).append(reaction.user)
    items = [
        {
            "emoji": emoji,
            "count": len(users),
            "users": AuthorSerializer(
                users, many=True, context={"request": request}
            ).data,
        }
        for emoji, users in grouped.items()
    ]
    items.sort(key=lambda item: (-item["count"], item["emoji"]))
    return Response(items)


class PostReactionView(APIView):
    """Toggle your emoji reaction on a post (POST ``/posts/<pk>/react/``) or list
    who reacted, grouped by emoji (GET ``/posts/<pk>/reactions/``).

    Both are gated by ``can_view_post`` — the same wall the feed and comments
    enforce — so you can't react to (or probe reactions on) a post you can't see;
    a non-visible post gets a 404, never leaking its existence.
    """

    def _get_post_or_404(self, request, pk):
        post = get_object_or_404(Post.objects.select_related("author"), pk=pk)
        if not can_view_post(request.user, post):
            raise NotFound()
        return post

    def post(self, request, pk):
        return _toggle_reaction(request, {"post": self._get_post_or_404(request, pk)})

    def get(self, request, pk):
        return _reactors_grouped(request, self._get_post_or_404(request, pk))


class CommentReactionView(APIView):
    """Toggle your emoji reaction on a comment/reply (POST
    ``/comments/<pk>/react/``) or list who reacted (GET
    ``/comments/<pk>/reactions/``). Gated by ``can_view_comment`` — the same
    connection-pruned visibility the comment tree uses.
    """

    def _get_comment_or_404(self, request, pk):
        comment = get_object_or_404(
            Comment.objects.select_related("author", "post"), pk=pk
        )
        if not can_view_comment(request.user, comment):
            raise NotFound()
        return comment

    def post(self, request, pk):
        return _toggle_reaction(
            request, {"comment": self._get_comment_or_404(request, pk)}
        )

    def get(self, request, pk):
        return _reactors_grouped(request, self._get_comment_or_404(request, pk))


# --- Direct messaging (Phase 5) ------------------------------------------------


def _blocked_with_ids(user):
    """Flatten ``user``'s ``Block`` rows (either direction) into the set of
    user ids they're blocked-with — the endpoint that isn't them in each
    pair."""
    blocked_ids = set(
        Block.objects.filter(Q(blocker=user) | Q(blocked=user)).values_list(
            "blocker_id", "blocked_id"
        )
    )
    return {
        blocker if blocker != user.id else blocked
        for blocker, blocked in blocked_ids
    }


def _conversation_visible(convo, user, blocked):
    """Whether ``convo`` should appear in ``user``'s list.

    Group chats are always visible — the Participant rows already gate
    membership, and a pending member is meant to see a locked row (see
    ``chat_display_for``/``.my_status``). A direct thread is hidden if the
    other party is deactivated or blocked either way — the Phase 5 rule,
    unchanged: a block cuts the pair off from each other so the thread
    disappears from both lists, consistent with the feed hiding a banned
    member.
    """
    if convo.kind != Conversation.Kind.DIRECT:
        return True
    other = convo.other_participant(user)
    if other is None or not other.is_active:
        return False
    return other.id not in blocked


def user_conversations(user):
    """The conversations ``user`` participates in that should be shown to
    them, newest-activity first.

    Participant-based: matches any conversation with a non-left
    ``Participant`` row for ``user`` — active *or* pending, so a pending group
    member still sees the locked chat in their list. Also matches the legacy
    ``user_a``/``user_b`` pair directly, so a direct thread that predates
    Participant rows (or is built straight off the model, as some tests still
    do) keeps showing up — every 1:1 opened through the API gets participant
    rows going forward (see ``_ensure_direct_participants``).
    ``_conversation_visible`` then applies the Phase 5 block/deactivation rule
    to the direct ones. Returns a plain list (not a queryset) — the caller
    paginates it directly.
    """
    blocked = _blocked_with_ids(user)
    participant_convo_ids = Participant.objects.filter(
        user=user, left_at__isnull=True
    ).values_list("conversation_id", flat=True)
    qs = (
        Conversation.objects.filter(
            Q(id__in=participant_convo_ids) | Q(user_a=user) | Q(user_b=user)
        )
        .select_related("user_a", "user_b", "group")
        .order_by("-updated_at", "-id")
    )
    return [c for c in qs if _conversation_visible(c, user, blocked)]


def _ensure_direct_participants(convo):
    """Give a direct conversation two active ``Participant`` rows + open
    intervals, idempotently — mirrors the ``0009`` backfill migration, so a 1:1
    opened via the API is immediately participant-complete (Task 4's
    ``_create_direct`` didn't wire this; the participant-based views need it
    for a freshly created thread to behave like a promoted group chat).

    Intervals always open at ``convo.created_at``, never "now": a 1:1's two
    participants have implicitly been in the thread since it was created —
    there's no pending/gap concept for direct chats. Using ``convo.created_at``
    is a no-op for a brand-new conversation (created_at ≈ now) but is essential
    for a pre-existing thread that never got Participant rows (e.g. one built
    directly off the model, as Phase 5's tests do, then re-opened via this
    view) — opening at "now" there would clip the whole prior history out of
    ``visible_messages_for`` for both participants.
    """
    for user_id in (convo.user_a_id, convo.user_b_id):
        if user_id is None:
            continue
        participant, _created = Participant.objects.get_or_create(
            conversation=convo, user_id=user_id, defaults={"status": ACTIVE_P},
        )
        activate(participant, convo.created_at)


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
        if "participant_ids" in request.data:
            return self._create_group(request)
        return self._create_direct(request)

    def _create_direct(self, request):
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
        # Idempotent: makes both sides active Participants with an open
        # interval, whether this is a brand-new thread or a pre-Task-4 one
        # that never got them.
        _ensure_direct_participants(convo)

        decorate_conversations([convo], request.user)
        serializer = self.get_serializer(convo)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    def _create_group(self, request):
        """Open a group chat: creator active, invitees pending then promoted
        per the clique rule (``promote_participants``).

        Connection-gated exactly like a 1:1 (``can_add_to_group`` — same gate
        as ``can_message``): every invitee must be one of the creator's
        connections, or this 403s. A ``group_id`` additionally scopes the chat
        to a Phase 6 ``Group`` — the caller must be a member (404, not leaking
        the group's existence, if not) and so must every invitee (400 — a
        validation error on the invite list, not a permission error, since the
        caller *can* message them, just not into this group).
        """
        ids = request.data.get("participant_ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"participant_ids": "Pick at least one connection."})
        title = (request.data.get("title") or "").strip()[:100]
        group_id = request.data.get("group_id")
        group = None
        if group_id is not None:
            group = get_object_or_404(Group, pk=group_id)
            if not is_group_member(request.user, group.id):
                raise NotFound()

        invitees = list(User.objects.filter(id__in=ids, is_active=True).exclude(id=request.user.id))
        if not invitees:
            # Every id was unknown/inactive/yourself — don't silently create a
            # "group chat of one" (the direct path 404s an unknown user; this is
            # the same guard for the multi-person path).
            raise ValidationError(
                {"participant_ids": "Pick at least one connection to start a chat."}
            )
        for invitee in invitees:
            if not can_add_to_group(request.user, invitee):
                raise PermissionDenied("You can only add people you're connected with.")
            if group is not None and not is_group_member(invitee, group.id):
                raise ValidationError({"participant_ids": f"{invitee.pk} isn't in this group."})

        now = timezone.now()
        with transaction.atomic():
            convo = Conversation.objects.create(
                kind=Conversation.Kind.GROUP, group=group, title=title,
                created_by=request.user, updated_at=now,
            )
            creator = Participant.objects.create(
                conversation=convo, user=request.user, status=ACTIVE_P,
            )
            activate(creator, now)
            for invitee in invitees:
                Participant.objects.create(
                    conversation=convo, user=invitee, status=PENDING_P,
                    invited_by=request.user,
                )
            promote_participants(convo, now)
        decorate_conversations([convo], request.user)
        return Response(self.get_serializer(convo).data, status=status.HTTP_201_CREATED)


class ConversationParticipantsView(APIView):
    """Add more people to an existing chat
    (``POST /conversations/<pk>/participants/`` body ``{user_ids: [...]}``).

    Any *active* member (not pending, not left) can invite more of their own
    connections — same gate as opening the chat (``can_add_to_group``), plus
    group membership for a group-scoped chat, consistent with
    ``_create_group``. New rows land pending, then ``promote_participants``
    runs the clique rule immediately, so an invitee connected to everyone
    already active goes straight in. ``get_or_create`` keeps re-adding an
    existing participant a no-op rather than a duplicate row.
    """

    def post(self, request, pk):
        convo = get_object_or_404(Conversation, pk=pk)
        me = convo.participants.filter(
            user=request.user, status=ACTIVE_P, left_at__isnull=True
        ).first()
        if me is None:
            raise PermissionDenied("Only an active member can add people.")
        ids = request.data.get("user_ids") or []
        invitees = list(User.objects.filter(id__in=ids, is_active=True).exclude(id=request.user.id))
        for invitee in invitees:
            if not can_add_to_group(request.user, invitee):
                raise PermissionDenied("You can only add people you're connected with.")
            if convo.group_id and not is_group_member(invitee, convo.group_id):
                raise ValidationError({"user_ids": f"{invitee.pk} isn't in this group."})
        now = timezone.now()
        with transaction.atomic():
            for invitee in invitees:
                participant, created = Participant.objects.get_or_create(
                    conversation=convo, user=invitee,
                    defaults={"status": PENDING_P, "invited_by": request.user},
                )
                if not created and participant.left_at is not None:
                    # They previously left/declined — re-adding must actually
                    # bring them back, not silently no-op on the tombstoned
                    # row get_or_create just found.
                    participant.left_at = None
                    participant.status = PENDING_P
                    participant.save(update_fields=["left_at", "status"])
            promote_participants(convo, now)
        return Response({"detail": "Added."}, status=status.HTTP_200_OK)


class ConversationLeaveView(APIView):
    """Leave (or decline) a chat (``POST /conversations/<pk>/leave/``).

    Works from either ``active`` or ``pending`` status — an active member
    leaving, or a pending invitee declining. Closes the participant's open
    access interval (see ``deactivate``), tombstones the row with
    ``left_at``, then re-runs ``promote_participants`` so anyone still
    pending gets re-checked against the (now smaller) active clique. 404 if
    the caller has no non-left participant row for this conversation —
    a chat you're not in shouldn't even reveal it exists.
    """

    def post(self, request, pk):
        p = get_object_or_404(
            Participant, conversation_id=pk, user=request.user, left_at__isnull=True
        )
        now = timezone.now()
        with transaction.atomic():
            deactivate(p, now)
            p.left_at = now
            p.save(update_fields=["left_at"])
            promote_participants(p.conversation, now)
        return Response({"detail": "Left the chat."}, status=status.HTTP_200_OK)


def _viewer_conversation_or_404(pk, user):
    """Fetch a conversation ``user`` is a member of (any status), or 404.

    Matches either a ``Participant`` row (any status, not left — every group
    chat, and every 1:1 opened since ``_ensure_direct_participants``) or the
    legacy ``user_a``/``user_b`` pair (a direct thread predating Participant
    rows). 404, not 403, for a non-member — a thread you're not in shouldn't
    even reveal it exists.
    """
    return get_object_or_404(
        Conversation.objects.select_related("user_a", "user_b", "group")
        .filter(
            Q(user_a=user)
            | Q(user_b=user)
            | Q(participants__user=user, participants__left_at__isnull=True)
        )
        .distinct(),
        pk=pk,
    )


class ConversationDetailView(generics.RetrieveAPIView):
    """A single conversation (``GET /conversations/<pk>/``) — the other person
    (direct) or the member list (group), last-message preview, your unread
    count, and ``my_status``/``must_connect_with`` (drives a group's locked
    pending panel).

    Drives the thread page's header so it's correct even on a cold page
    load/refresh, not only when arriving from the list. Participant-scoped —
    404 if you're not a member at all, or (direct only) if the pair is blocked
    either way.
    """

    serializer_class = ConversationSerializer

    def get_object(self):
        user = self.request.user
        convo = _viewer_conversation_or_404(self.kwargs["pk"], user)
        decorate_conversations([convo], user)
        if convo.my_status is None:
            raise NotFound()
        if convo.kind == Conversation.Kind.DIRECT:
            other = convo.other_participant(user)
            if is_blocked_between(user, other):
                raise NotFound()
            # Whether new messages are still allowed (drives the composer).
            # History stays readable after a disconnect even when this is
            # False.
            convo._can_message = can_message(user, other)
        else:
            # A pending group member can read the locked panel but not send.
            convo._can_message = convo.my_status == ACTIVE_P
        return convo


class ConversationMessagesView(generics.ListAPIView):
    """The messages in a conversation (GET) and sending one (POST) at
    ``/conversations/<pk>/messages/``.

    You must be a participant, else 404 (we don't reveal a thread you're not
    in). A blocked direct pair can't see the thread at all (404). A pending
    group member sees the thread exists (via the detail view) but can't read
    or send here — 403 — until they're promoted to active. GET returns
    messages oldest-first, paginated, clipped to your access interval(s) for a
    group chat. POST re-checks the send gate — disconnecting/a block (direct)
    or dropping to pending (group) stops *future* messages even though history
    stays visible — takes the sender from the session, bumps the
    conversation's activity time, and marks it read for you.
    """

    serializer_class = MessageSerializer

    def _conversation(self):
        user = self.request.user
        convo = _viewer_conversation_or_404(self.kwargs["pk"], user)
        my_status = _viewer_participant_status(convo, user)
        if my_status is None:
            raise NotFound()
        if convo.kind == Conversation.Kind.DIRECT:
            other = convo.other_participant(user)
            if is_blocked_between(user, other):
                raise NotFound()
        return convo, my_status

    def get_queryset(self):
        convo, my_status = self._conversation()
        if my_status != ACTIVE_P:
            raise PermissionDenied(
                "Connect with everyone to join this chat."
            )
        return _messages_for_viewer(convo, self.request.user)

    def post(self, request, pk):
        convo, my_status = self._conversation()
        if convo.kind == Conversation.Kind.DIRECT:
            other = convo.other_participant(request.user)
            if not can_message(request.user, other):
                raise PermissionDenied(
                    "You can no longer message this person."
                )
        elif my_status != ACTIVE_P:
            raise PermissionDenied(
                "Connect with everyone to join this chat."
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
    which clears your unread count for it. Participant-only (404 otherwise) —
    resolved via ``_viewer_conversation_or_404`` so this works for a group chat
    member (any non-left status) too, not just a legacy direct pair; a pending
    member marking read is harmless (they can't see any messages yet anyway,
    since ``visible_messages_for`` clips to their intervals)."""

    def post(self, request, pk):
        user = request.user
        convo = _viewer_conversation_or_404(pk, user)
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
    badge (``GET /messages/unread-count/``). Mirrors the per-thread unread
    rule (not yours, not deleted, newer than your read marker) applied to each
    conversation's interval-clipped visible set (a query per conversation —
    family scale, same trade-off ``decorate_conversations`` makes), and
    ignores blocked/inactive threads via ``user_conversations``."""

    def get(self, request):
        user = request.user
        conversations = user_conversations(user)
        if not conversations:
            return Response({"count": 0})
        read_at_by_convo = dict(
            ConversationRead.objects.filter(
                conversation_id__in=[c.id for c in conversations], user=user
            ).values_list("conversation_id", "last_read_at")
        )
        total = sum(
            unread_count_for(convo, user, read_at_by_convo.get(convo.id))
            for convo in conversations
        )
        return Response({"count": total})


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
        now = timezone.now()
        with transaction.atomic():
            Block.objects.get_or_create(
                blocker=request.user, blocked=target
            )
            # Sever before the Connection delete — see sever_shared_chats'
            # docstring for why promotion is deferred until after it.
            convos = sever_shared_chats(request.user, target, now)
            # Blocking severs any connection — you shouldn't stay "connected"
            # to someone you've blocked.
            Connection.objects.filter(
                Q(requester=request.user, requestee=target)
                | Q(requester=target, requestee=request.user)
            ).delete()
            for convo in convos:
                promote_participants(convo, now)
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


class DisconnectImpactView(APIView):
    """``GET /users/<pk>/disconnect-impact/`` — the chats a disconnect or
    block against this user would drop you out of, so the frontend can warn
    before the user confirms."""

    def get(self, request, pk):
        other = get_object_or_404(User, pk=pk)
        chats = _shared_active_chats(request.user, other)
        data = [
            {"id": c.id, "title": _chat_label(c, request.user), "kind": c.kind}
            for c in chats
        ]
        return Response({"chats": data})


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


class GroupPostsView(ReactionContextMixin, generics.ListAPIView):
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
        # Notify the invitee (Phase 8).
        notifications.create_notification(
            recipient=invitee,
            actor=request.user,
            kind=Notification.Kind.GROUP_INVITE,
            group=group,
        )
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

    Dropping the membership also drops the departing user from every chat
    scoped to this group: their participant row in each such ``Conversation``
    is deactivated and tombstoned with ``left_at`` (mirroring
    ``ConversationLeaveView``), then ``promote_participants`` re-runs for the
    others. Membership delete + chat departure happen in one transaction.
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
        with transaction.atomic():
            target.delete()
            now = timezone.now()
            for convo in Conversation.objects.filter(group_id=group.id):
                p = convo.participants.filter(user_id=user_id, left_at__isnull=True).first()
                if p is not None:
                    deactivate(p, now)
                    p.left_at = now
                    p.save(update_fields=["left_at"])
                    promote_participants(convo, now)
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
        # Either way the invite has been dealt with — address its notification so
        # the unified badge stops counting it (reject deletes the membership row
        # but the notification targets the Group, which lives on). (Phase 8.)
        notifications.address_group_invite(request.user, invite.group)
        if self.action == "accept":
            invite.status = ACTIVE
            invite.save(update_fields=["status"])
            return Response({"detail": "Joined."}, status=status.HTTP_200_OK)
        invite.delete()
        return Response({"detail": "Declined."}, status=status.HTTP_200_OK)


# --- Notifications / activity centre (Phase 8) --------------------------------


def _notifications_for(user):
    """A user's notifications, newest-first, with everything the serializer needs
    to render text + deep-link URLs prefetched (no N+1 over a page)."""
    return (
        Notification.objects.filter(recipient=user)
        .select_related(
            "actor", "post", "post__author", "comment", "comment__post", "group"
        )
        .order_by("-created_at", "-id")
    )


class NotificationListView(generics.ListAPIView):
    """Your notifications, newest-first, paginated (``GET /notifications/``).

    Scoped to ``request.user`` as recipient — you only ever see your own. Each
    item is the push-ready payload (see ``NotificationSerializer``). All target
    FKs cascade-delete, so a notification never outlives its target; there are no
    dead deep-links to filter here.
    """

    serializer_class = NotificationSerializer

    def get_queryset(self):
        return _notifications_for(self.request.user)


class NotificationUnreadCountView(APIView):
    """Your unread (not-yet-*seen*) notification count, for the nav bell badge
    (``GET /notifications/unread-count/``). Unread = ``seen_at IS NULL`` — opening
    the centre clears the badge even though the items stay in the list."""

    def get(self, request):
        count = Notification.objects.filter(
            recipient=request.user, seen_at__isnull=True
        ).count()
        return Response({"count": count})


class NotificationSeenView(APIView):
    """Mark your unread notifications **seen** (``POST /notifications/seen/``) —
    called when the activity centre is opened, clearing the badge while keeping
    every item in the list. Optional body ``{ids: [...]}`` scopes it to specific
    notifications; omit it to mark all currently-unread seen. Idempotent."""

    def post(self, request):
        qs = Notification.objects.filter(
            recipient=request.user, seen_at__isnull=True
        )
        ids = request.data.get("ids")
        if ids is not None:
            if not isinstance(ids, list):
                raise ValidationError({"ids": "Expected a list of ids."})
            qs = qs.filter(id__in=ids)
        updated = qs.update(seen_at=timezone.now())
        return Response({"updated": updated})


class NotificationAddressedView(APIView):
    """Mark one notification **addressed** (``POST /notifications/<pk>/addressed/``)
    — the dulled, dealt-with state — when the user clicks it through to its
    target. Marking addressed also implies seen (you can't act on what you
    haven't seen), so we set ``seen_at`` too if it wasn't already. 404 if the
    notification isn't yours. Idempotent."""

    def post(self, request, pk):
        notification = get_object_or_404(
            Notification, pk=pk, recipient=request.user
        )
        now = timezone.now()
        fields = []
        if notification.addressed_at is None:
            notification.addressed_at = now
            fields.append("addressed_at")
        if notification.seen_at is None:
            notification.seen_at = now
            fields.append("seen_at")
        if fields:
            notification.save(update_fields=fields)
        return Response({"detail": "Addressed."})


class NotificationPreferencesView(APIView):
    """Read (GET) or update (PATCH) your per-kind notification preferences at
    ``/notification-preferences/``.

    Presented as a flat ``{kind: bool}`` map over the **mutable** kinds only
    (reply/reaction) — the connection/invite kinds are always-on and never
    appear. Absence of a stored row means enabled; PATCH accepts a partial map
    and upserts. A muted kind stops new notifications (``create_notification``
    checks this), which also suppresses future push."""

    def get(self, request):
        return Response(
            NotificationPreferencesSerializer().to_representation(request.user)
        )

    def patch(self, request):
        serializer = NotificationPreferencesSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        for kind, enabled in serializer.validated_data.items():
            NotificationPreference.objects.update_or_create(
                user=request.user, kind=kind, defaults={"enabled": enabled}
            )
        # Return the full, freshly-merged map so the client has the source of truth.
        return Response(
            NotificationPreferencesSerializer().to_representation(request.user)
        )


# --- Content reports (Phase 7 — takedown path) ---------------------------------


class ReportCreateView(generics.CreateAPIView):
    """Flag a post or comment for the maintainer (``POST /api/reports/``).

    Any logged-in member can raise a report; the reporter is the session user
    (never the body). The report just records the flag — the maintainer reviews
    it in the Django admin (where the reported post/comment is moderatable) and
    removes the content if warranted.

    Two guards beyond the serializer's xor/length checks:

    - **You can only report content you can see.** Without this the endpoint
      would confirm which post/comment ids exist (a 201-vs-400 oracle) for
      content you have no relationship to — a hole in the same private-by-default
      wall the feed and comments enforce. A non-visible target gets the same 404
      it gets everywhere else, so existence isn't leaked either way.
    - **One flag per (reporter, target).** A repeat/double-click returns your
      existing report (200) instead of stacking duplicates in the queue; the
      model's unique constraints are the race-proof backstop.

    Returns 201 with the created report, or 200 with the existing one.
    """

    serializer_class = ReportCreateSerializer

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        post = serializer.validated_data.get("post")
        comment = serializer.validated_data.get("comment")

        connected_ids = connected_user_ids(request.user)
        if post is not None and not can_view_post(
            request.user, post, connected_ids
        ):
            raise NotFound()
        if comment is not None and not can_view_comment(
            request.user, comment, connected_ids
        ):
            raise NotFound()

        # Idempotent: already flagged this item? Return that report, don't stack a
        # duplicate. (The unique constraint still guards against a concurrent race
        # slipping past this check.)
        existing = Report.objects.filter(
            reporter=request.user, post=post, comment=comment
        ).first()
        if existing is not None:
            data = self.get_serializer(existing).data
            return Response(data, status=status.HTTP_200_OK)

        serializer.save(reporter=request.user)
        headers = self.get_success_headers(serializer.data)
        return Response(
            serializer.data, status=status.HTTP_201_CREATED, headers=headers
        )


# --- Account deletion (Phase 7 — delete-my-data path) --------------------------


def delete_account(user):
    """Hard-delete ``user`` and everything of theirs, safely and in one txn.

    "Delete my data" for real (UK GDPR erasure): the account and its posts,
    comments, messages, connections, memberships, blocks and reports all go.
    Three things a naive ``user.delete()`` gets wrong, handled here:

    1. **Media files.** The cascade drops ``PostImage``/avatar *rows* but leaves
       the actual JPEGs on disk/in storage. We gather them up front and delete
       them **on commit** — file deletes aren't transactional, so doing them only
       once the rows are certainly gone means a rolled-back delete can't leave the
       account intact but its images vanished.
    2. **Last-admin groups.** A group outlives its members (``Group.creator`` is
       SET_NULL, admin memberships CASCADE), so deleting a group's *only* admin
       would leave it ungovernable. If other active members remain, we promote
       the longest-standing one to admin before leaving.
    3. **Emptied groups.** A group the user was the sole active member of becomes
       memberless — dead space — so we delete it (and its avatar files) outright.

    Everything runs in a transaction: either the account and all its traces go,
    or nothing does.
    """
    my_active_memberships = list(
        GroupMembership.objects.filter(
            user=user, status=ACTIVE
        ).select_related("group")
    )

    # Gather every storage file to remove. We capture the FieldFiles now (they
    # hold the storage + path) but only delete them after the transaction commits
    # — see docstring point 1. An already-removed file just no-ops.
    files_to_delete = [user.avatar, user.avatar_thumb]
    for img in PostImage.objects.filter(post__author=user):
        files_to_delete.append(img.image)
        files_to_delete.append(img.thumbnail)

    with transaction.atomic():
        groups_to_delete = []
        for m in my_active_memberships:
            others = GroupMembership.objects.filter(
                group_id=m.group_id, status=ACTIVE
            ).exclude(user=user)
            if not others.exists():
                # The user is this group's only active member — it dies with them.
                groups_to_delete.append(m.group_id)
                continue
            # Sole admin of a group others are still in → hand the keys over to
            # the longest-standing remaining member so the group stays governable.
            if m.role == ADMIN and _active_admin_count(m.group_id) <= 1:
                heir = others.order_by("created_at", "id").first()
                heir.role = ADMIN
                heir.save(update_fields=["role"])

        # Delete the account. Cascades: posts (+ image rows), comments, sent
        # messages, 1:1 conversations, chat participations, connections, blocks,
        # read markers, group memberships, reports made.
        user.delete()

        # Now-memberless groups: remove them (capturing their avatar files for the
        # same on-commit sweep). Their posts — all by the departed sole member —
        # and those posts' image files are already accounted for above.
        for group in Group.objects.filter(id__in=groups_to_delete):
            files_to_delete.append(group.avatar)
            files_to_delete.append(group.avatar_thumb)
            group.delete()

        # Only once the whole delete has committed do we touch storage.
        def _remove_files(files=files_to_delete):
            for f in files:
                if f:
                    f.delete(save=False)

        transaction.on_commit(_remove_files)


class DeleteAccountView(APIView):
    """Delete your own account and all your data (``POST /api/account/delete/``).

    Irreversible, so it's **password-reconfirmed**: the body must carry the
    caller's current ``password``. This guards against a one-click mistake or an
    unattended/hijacked session doing something unrecoverable — the same reason a
    bank asks again before a transfer. On success everything is torn down (see
    ``delete_account``) and 204 is returned; the client then clears its session.

    Rate-limited per user (``account_delete`` scope): the password re-check is a
    guessing oracle of the same shape as password change, so it gets the same
    treatment — a burst of wrong-password attempts is cut off with a 429.
    """

    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "account_delete"

    def post(self, request):
        password = request.data.get("password", "")
        if not request.user.check_password(password):
            raise ValidationError(
                {"password": ["Password is incorrect."]}
            )
        delete_account(request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)
