from collections import defaultdict

from django.conf import settings as dj_settings
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
from django.utils.dateparse import parse_date, parse_time
from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import (
    MethodNotAllowed,
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
    Event,
    EventRSVP,
    Group,
    GroupMembership,
    Message,
    Notification,
    NotificationPreference,
    Participant,
    ParticipantInterval,
    Poll,
    PollOption,
    PollVote,
    Post,
    PostCommentRead,
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
    EventWriteSerializer,
    FinaliseSerializer,
    GroupInviteSerializer,
    GroupMemberSerializer,
    GroupSerializer,
    MessageCreateSerializer,
    MessageSerializer,
    NotificationPreferencesSerializer,
    NotificationSerializer,
    PollCreateSerializer,
    PollEditSerializer,
    PostSerializer,
    ReportCreateSerializer,
    RSVPWriteSerializer,
    UserListSerializer,
    build_rsvp_summary,
    serialize_event,
    serialize_poll,
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

    Computed once per request (not per post) and **memoised**, so the whole
    feed's reaction pruning costs one connections query — and the comment-count
    pass (``CommentCountMixin``) reuses the very same set (it's exactly the
    comment tree's visible-author set) rather than firing its own.
    """

    def visible_reactor_ids(self):
        """This viewer's visible-reactor set, computed once per request."""
        if not hasattr(self, "_visible_reactor_ids"):
            self._visible_reactor_ids = visible_reactor_ids(self.request.user)
        return self._visible_reactor_ids

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["visible_reactor_ids"] = self.visible_reactor_ids()
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


def visible_events(user, group, connected_ids=None):
    """The events in ``group`` that ``user`` is allowed to see (Phase 8b).

    The app's one connection gate applied to events — the *same* rule as
    ``visible_posts``, but keyed on the event's ``organiser`` instead of a post's
    author: you see an event iff its organiser is you or one of your connections,
    and the organiser is still active. Group **membership** is gated by the caller
    (as with ``visible_posts``); this applies only the connection prune, so each
    member sees a *partial* set of a group's events — their connections' events
    under a shared label — exactly as they see a partial set of its posts.

    A block deletes the ``Connection`` row (see ``BlockView``), so a blocked
    organiser's events fall out of ``connected_ids`` for free — no separate block
    check needed. Cancelled events stay visible (RSVP'd members need the
    tombstone); the caller's ``window`` decides upcoming/past/all.
    """
    if connected_ids is None:
        connected_ids = connected_user_ids(user)
    visible_organiser_ids = set(connected_ids) | {user.id}
    return (
        Event.objects.filter(
            group=group,
            organiser_id__in=visible_organiser_ids,
            organiser__is_active=True,
        )
        .select_related("organiser", "group")
    )


def can_view_event(user, event, connected_ids=None):
    """Whether ``user`` may see ``event`` — the yes/no form of ``visible_events``,
    in one place so the detail/vote/RSVP views can't drift from the list.

    Two gates, mirroring the group timeline: active **membership** of the event's
    group, **and** a connection to its (active) organiser (or being the organiser).
    A member not connected to the organiser gets a 404 — the event doesn't exist
    for them, exactly like one of the organiser's posts.
    """
    if not is_group_member(user, event.group_id):
        return False
    if not event.organiser.is_active:
        return False
    if connected_ids is None:
        connected_ids = connected_user_ids(user)
    return event.organiser_id == user.id or event.organiser_id in connected_ids


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


def comment_counts_for_posts(posts, viewer, visible_author_ids=None):
    """``{post_id: {"total": int, "new": int}}`` for a page of posts (issue #63).

    ``total`` is how many comments ``viewer`` would see if they expanded the
    thread; ``new`` is how many of those they haven't seen yet. Both honour the
    *exact* same pruning as the comment tree itself (``build_visible_comment_tree``)
    — a comment from a not-connected or deactivated author, and its whole subtree,
    is excluded — so the number next to *Comments* always matches what actually
    opens. (A plain ``COUNT`` can't do this: subtree pruning at arbitrary depth
    isn't expressible in one SQL filter, and a naive author-filtered count would
    over-count a connected author's reply that sits under a hidden parent.)

    Cost is bounded and independent of page size: **one** query loads every
    comment on the page's posts, one loads this viewer's last-seen markers, and
    the trees are built in Python — no per-post query. Fine at family scale
    (mirrors why the tree prune itself runs in Python, see the comment view).

    "New" = a visible comment authored by *someone else* with ``created_at`` after
    the viewer's ``PostCommentRead.last_seen_at`` for that post; a missing marker
    (thread never opened) makes every such comment new. Your own comments never
    count as new — you've self-evidently seen them — matching how ``ConversationRead``
    excludes your own messages from an unread count.

    ``visible_author_ids`` is the viewer's connections plus themselves (exactly
    ``visible_reactor_ids``); pass it in when the caller already has it — the
    post-serving views do, via ``ReactionContextMixin`` — to skip recomputing the
    connections query.
    """
    post_ids = [p.id for p in posts]
    if not post_ids:
        return {}

    if visible_author_ids is None:
        visible_author_ids = connected_user_ids(viewer) | {viewer.id}

    # One query for all comments on the page. Drop deactivated authors up front,
    # exactly as PostCommentsView does, so a banned author's comment takes its
    # subtree with it here too. Only the fields the tree walk needs.
    comments_by_post = defaultdict(list)
    for comment in (
        Comment.objects.filter(post_id__in=post_ids, author__is_active=True)
        .only("id", "post_id", "parent_id", "author_id", "created_at")
    ):
        comments_by_post[comment.post_id].append(comment)

    # One query for this viewer's last-seen markers across the page.
    last_seen = dict(
        PostCommentRead.objects.filter(
            user=viewer, post_id__in=post_ids
        ).values_list("post_id", "last_seen_at")
    )

    def walk(nodes, seen_at):
        total = new = 0
        for node in nodes:
            total += 1
            if node.author_id != viewer.id and (
                seen_at is None or node.created_at > seen_at
            ):
                new += 1
            sub_total, sub_new = walk(node._visible_children, seen_at)
            total += sub_total
            new += sub_new
        return total, new

    counts = {}
    for post_id in post_ids:
        tree = build_visible_comment_tree(
            comments_by_post.get(post_id, []), visible_author_ids
        )
        total, new = walk(tree, last_seen.get(post_id))
        counts[post_id] = {"total": total, "new": new}
    return counts


class CommentCountMixin:
    """Attach ``comment_count`` / ``new_comment_count`` to a *page* of posts in
    one pass (issue #63), so a post-list endpoint carries the counts without
    firing a query per post.

    Computes the counts for exactly the paginated page (not the whole queryset),
    stashes them on the instance, and hands them to the serializer via context.
    Mixed into the feed, profile, and group timelines — every list that renders
    ``PostSerializer``. Combine with ``ReactionContextMixin`` (all three do) so
    the count pass reuses its memoised visible-author set instead of firing its
    own connections query.
    """

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["comment_counts"] = getattr(self, "_comment_counts", {})
        return context

    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        posts = page if page is not None else list(queryset)
        # Reuse ReactionContextMixin's memoised set when present, so total/new
        # counts don't recompute the connections query the reaction pruning
        # already ran this request.
        get_visible = getattr(self, "visible_reactor_ids", None)
        visible_author_ids = get_visible() if get_visible else None
        self._comment_counts = comment_counts_for_posts(
            posts, request.user, visible_author_ids=visible_author_ids
        )
        serializer = self.get_serializer(posts, many=True)
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data)


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


class FeedView(CommentCountMixin, ReactionContextMixin, generics.ListAPIView):
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


class PostDetailView(ReactionContextMixin, generics.RetrieveUpdateDestroyAPIView):
    """A single post by id (``GET``), plus owner-only edit (``PATCH``) and delete
    (``DELETE``) — all on ``/api/posts/<pk>/``.

    **GET** backs the ``/p/:id`` permalink page, which a notification deep-links to
    so you can open a thread straight to the reply you were notified about — even
    one 20 replies deep, or on a post that isn't on the first page of any feed.
    Fetching the post by id (rather than hoping it's already loaded in some list)
    is the only way that's reliable.

    Same private-by-default gate as every other post surface: ``can_view_post``
    (connection gate, plus active membership for a group post). A post you can't
    see is a 404 — existence isn't leaked, matching the feed/comments/reactions.
    The comment *tree* still comes from ``PostCommentsView``; this returns just the
    post (with its pruned reaction summary, via ``ReactionContextMixin``).

    **Edit / delete (issue #62)** are owner-only and share the same route:

    - **PATCH** updates the post's **text** (v1 scope — adding/removing photos is
      deliberately out of scope) and stamps ``edited_at`` so the feed can show a
      quiet "· edited" marker. Silently changing content others have already read
      would be a trust problem, so the marker isn't optional.
    - **DELETE** removes the post; the model's CASCADE relations take its images,
      comments (and replies), reactions, reports and notifications with it.

    The mutation gate mirrors ``GroupDetailView``: a post you can't see is a 404
    (existence hidden), a post you *can* see but don't own is a 403 — the owner
    check never leaks a hidden post's existence. ``PUT`` is disallowed (405); a
    partial ``PATCH`` is the only edit shape (text is the sole writable field).
    """

    serializer_class = PostSerializer

    def get_serializer_context(self):
        # The permalink (and a PATCH response) render PostSerializer too, so they
        # need the comment counts (issue #63). Both GET and PATCH/DELETE go
        # through _fetch_post, which stashes the single post's counts here.
        context = super().get_serializer_context()
        context["comment_counts"] = getattr(self, "_comment_counts", {})
        return context

    def _fetch_post(self):
        post = get_object_or_404(
            Post.objects.select_related("author", "group").prefetch_related(
                "images", "reactions"
            ),
            pk=self.kwargs["pk"],
        )
        self._comment_counts = comment_counts_for_posts(
            [post], self.request.user, visible_author_ids=self.visible_reactor_ids()
        )
        return post

    def get_object(self):
        post = self._fetch_post()
        if not can_view_post(self.request.user, post):
            raise NotFound()
        return post

    def _owned_object(self):
        """The post, gated for a mutation.

        The author may always edit or delete **their own** post — even a group
        post they've since left the group of (their content stays theirs to
        remove; gating on ``can_view_post`` would 404 them out of their own
        post). For anyone else the same existence-hiding wall as GET applies: a
        post you can't see is 404 (no leak), one you can see but don't own is 403.
        """
        post = self._fetch_post()
        if post.author_id == self.request.user.id:
            return post
        if not can_view_post(self.request.user, post):
            raise NotFound()
        raise PermissionDenied("You can only edit or delete your own posts.")

    def put(self, request, *args, **kwargs):
        # Only a partial text edit is supported — text is the sole writable field,
        # so a full-replace PUT has no meaning here.
        raise MethodNotAllowed("PUT")

    def patch(self, request, *args, **kwargs):
        post = self._owned_object()
        serializer = self.get_serializer(post, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        new_text = serializer.validated_data.get("text", post.text)
        # A no-op save (text unchanged, or an empty body) must NOT mark the post
        # "edited" — the marker means the content really changed. Return the post
        # as-is without stamping.
        if new_text == post.text:
            return Response(self.get_serializer(post).data)
        # Text-only edit: the post must still have text or at least one photo,
        # mirroring the create rule (a post can't be emptied to nothing).
        if not new_text and not post.images.exists():
            raise ValidationError(
                {"detail": "A post needs some text or at least one photo."}
            )
        # edited_at is read-only from the body; stamp it here on a real edit.
        serializer.save(edited_at=timezone.now())
        return Response(serializer.data)

    def delete(self, request, *args, **kwargs):
        post = self._owned_object()
        post.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class UserPostsView(CommentCountMixin, ReactionContextMixin, generics.ListAPIView):
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
        # Opening the thread is the "seen" event (issue #63): stamp the viewer's
        # last-seen marker to now, which clears the post's "N new" count on their
        # next feed load. Consistent with how opening a conversation clears its
        # unread badge — seen is thread-level, not per-comment. Cheap upsert; the
        # GET already fires only on a deliberate open, so no extra round-trip.
        now = timezone.now()
        try:
            PostCommentRead.objects.update_or_create(
                post=post,
                user=request.user,
                defaults={"last_seen_at": now},
            )
        except IntegrityError:
            # Two near-simultaneous opens (double-click / duplicate tab) can both
            # miss the row and race to INSERT; the loser hits the unique (post,
            # user) constraint. Fall back to a plain UPDATE of the row the winner
            # just created — the timestamps are within milliseconds either way.
            PostCommentRead.objects.filter(post=post, user=request.user).update(
                last_seen_at=now
            )
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


class GroupPostsView(CommentCountMixin, ReactionContextMixin, generics.ListAPIView):
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
            # An event's visibility gate hangs off a *present* organiser (Phase
            # 8b), so a departing member's events can't linger — cancel them.
            cancel_events_on_departure(user_id, group.id)
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
            "actor", "post", "post__author", "comment", "comment__post", "group",
            "event",
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


# ---------------------------------------------------------------------------
# Phase 8b — group events, polls, RSVPs, calendars
#
# Two gates apply throughout, mirroring the group timeline: **membership** gates
# the group's event endpoints (a non-member 404s), and each **individual event is
# connection-gated to its organiser** (``can_view_event`` / ``visible_events``) —
# an event you're not connected to the organiser of is a 404, exactly like one of
# their posts. Managing an event (polls, edits, finalise) is the organiser's;
# cancel/hard-delete is the organiser or a group admin.
# ---------------------------------------------------------------------------

# Aliases so call sites read as names, not string literals (like ACTIVE/ADMIN).
EV_PLANNING = Event.Status.PLANNING
EV_SCHEDULED = Event.Status.SCHEDULED
EV_CANCELLED = Event.Status.CANCELLED
POLL_OPEN = Poll.Status.OPEN
POLL_CLOSED = Poll.Status.CLOSED
DIM_DATE = Poll.Dimension.DATE
DIM_TIME = Poll.Dimension.TIME
DIM_LOCATION = Poll.Dimension.LOCATION
DIM_CUSTOM = Poll.Dimension.CUSTOM
GOING = EventRSVP.Response.GOING
MAYBE = EventRSVP.Response.MAYBE
DECLINED = EventRSVP.Response.DECLINED

# A generous cap on how many events one window of the group-events list returns,
# so the (unpaginated) endpoint can't grow unbounded with a group's whole history.
# Upcoming/planning events are naturally few; the cap mainly bounds the "past"
# window, whose recap cards interleave with the (separately-paginated) posts feed.
EVENTS_LIST_CAP = 200

_DEFAULT_POLL_QUESTION = {
    DIM_DATE: "Which date works?",
    DIM_TIME: "What time?",
    DIM_LOCATION: "Where should we meet?",
}


def _event_or_404(user, pk):
    """Fetch an event the user may see, or 404 (membership + organiser-connection
    gate via ``can_view_event``). Light fetch — used for permission checks and
    mutations; the response is re-serialised from a prefetched query afterwards."""
    event = get_object_or_404(
        Event.objects.select_related("organiser", "group"), pk=pk
    )
    if not can_view_event(user, event):
        raise NotFound()
    return event


def _event_detail_qs():
    """Everything ``serialize_event(detail=True)`` reads, prefetched — no N+1 over
    an event's polls, options, votes, or RSVPs."""
    return Event.objects.select_related("organiser", "group").prefetch_related(
        "polls__options__votes__voter", "rsvps__user"
    )


def _event_response(event_id, request, status_code=status.HTTP_200_OK):
    """Serialise an event freshly (post-mutation) into a detail Response."""
    event = _event_detail_qs().get(pk=event_id)
    visible_ids = visible_reactor_ids(request.user)
    is_admin = is_group_admin(request.user, event.group_id)
    data = serialize_event(
        event, viewer=request.user, visible_ids=visible_ids, request=request,
        is_group_admin=is_admin,
    )
    return Response(data, status=status_code)


def _poll_response(poll_id, request, status_code=status.HTTP_200_OK):
    poll = (
        Poll.objects.select_related("event", "event__group")
        .prefetch_related("options__votes__voter")
        .get(pk=poll_id)
    )
    data = serialize_poll(
        poll, visible_ids=visible_reactor_ids(request.user),
        me_id=request.user.id, request=request,
    )
    return Response(data, status=status_code)


def _event_audience(event):
    """Active members of the event's group other than the organiser — the
    superset the notification choke-point then prunes to *organiser-connections*.
    We don't gate here: ``create_notification`` already drops anyone not connected
    to the actor (the organiser), so this stays "no new gating code"."""
    return (
        User.objects.filter(
            group_memberships__group_id=event.group_id,
            group_memberships__status=ACTIVE,
            is_active=True,
        )
        .exclude(id=event.organiser_id)
        .distinct()
    )


def _event_rsvp_audience(event, responses):
    """Members who RSVP'd with one of ``responses`` (going/maybe), other than the
    organiser — the recipients of ``event_updated`` / ``event_cancelled``."""
    return (
        User.objects.filter(
            event_rsvps__event=event,
            event_rsvps__response__in=responses,
            is_active=True,
        )
        .exclude(id=event.organiser_id)
        .distinct()
    )


def _notify_event(event, kind, recipients):
    """Fire one event notification per recipient with the organiser as actor.
    The choke-point suppresses self-notifications, muted kinds, and (crucially)
    any recipient not connected to the organiser — so the row only reaches the
    audience that can see the event."""
    for recipient in recipients:
        notifications.create_notification(
            recipient, event.organiser, kind, event=event
        )


def _recompute_event_status(event):
    """An event is ``scheduled`` once it has a date, else ``planning``. Never
    touches a cancelled event (cancel is terminal in v1)."""
    if event.status == EV_CANCELLED:
        return
    event.status = EV_SCHEDULED if event.event_date is not None else EV_PLANNING


def _event_is_over(event, today):
    """Whether an event belongs in the **past** region — it has finished
    (``is_past``), or it's a **cancelled** tombstone whose date has already gone
    by. A cancelled *future* event stays in the upcoming region as a dimmed
    tombstone until its date passes; a *planning* (date-less) event is never
    over."""
    if event.is_past:
        return True
    return (
        event.status == EV_CANCELLED
        and event.event_date is not None
        and event.event_date < today
    )


def _event_sort_key(event):
    """Chronological sort key. Date-less ("being planned") events have no slot in
    time, so they sort **after** all dated events (the tuple's first element keeps
    the two groups apart, so a datetime is never compared against the placeholder)."""
    start = event.starts_at
    return (1, "") if start is None else (0, start)


def cancel_events_on_departure(user_id, group_id):
    """Cancel the events a departing member organises in a group (Phase 8b).

    Called when someone **leaves or is removed from** a group: an event's
    visibility hangs off a present organiser, so it can't linger anchored to a
    non-member. Soft-cancel (tombstone + notify going/maybe RSVPs) rather than
    delete, so anyone who'd RSVP'd learns the plan is off — the same courtesy as
    an explicit cancel. (Account **deletion** doesn't come through here: the
    ``organiser`` FK is CASCADE, so the events simply go with the account. An
    admin "adopting" an orphaned event onto themselves is a future extension.)
    """
    events = list(
        Event.objects.filter(group_id=group_id, organiser_id=user_id)
        .exclude(status=EV_CANCELLED)
        .select_related("organiser", "group")
    )
    for event in events:
        event.status = EV_CANCELLED
        event.save(update_fields=["status", "updated_at"])
        _notify_event(
            event, Notification.Kind.EVENT_CANCELLED,
            _event_rsvp_audience(event, [GOING, MAYBE]),
        )


class GroupEventsView(APIView):
    """List a group's events you can see (GET) or plan one (POST) at
    ``/groups/<gid>/events/``.

    GET — members only (404 otherwise); each event further pruned to those
    organised by someone you're connected with (``visible_events``). ``window``
    is ``upcoming`` (default), ``past``, or ``all``. The split keys off
    ``is_past`` (a *timed* event moves to ``past`` the moment its time passes, an
    all-day event once its day ends — see ``_event_is_over``), **not** the raw
    date, so an event earlier today doesn't linger in ``upcoming`` until midnight.
    Time-ordered, never ranked. POST — **any active member** may create an event
    (low-friction, like posting); it starts in ``planning`` with the creator as
    organiser, and notifies the organiser's connections in the group.
    """

    def get(self, request, gid):
        if not is_group_member(request.user, gid):
            raise NotFound()
        connected = connected_user_ids(request.user)
        window = request.query_params.get("window", "upcoming")
        today = timezone.localdate()
        base = visible_events(
            request.user, gid, connected_ids=connected
        ).prefetch_related("polls__options__votes__voter", "rsvps__user")
        # Narrow to a DB superset of the window and **cap** it, so the response
        # can't grow with a group's whole event history. is_past is a per-event
        # property (tz-aware, all-day vs timed), so the exact prune then happens
        # in Python over the capped rows, and the final ordering respects the time.
        if window == "past":
            rows = base.filter(event_date__lte=today).order_by(
                "-event_date", "-id"
            )[:EVENTS_LIST_CAP]
            events = sorted(
                (e for e in rows if _event_is_over(e, today)),
                key=_event_sort_key, reverse=True,
            )
        elif window == "all":
            rows = base.order_by("-event_date", "-id")[:EVENTS_LIST_CAP]
            events = sorted(rows, key=_event_sort_key)
        else:  # upcoming — everything not yet over (incl. date-less planning)
            rows = base.filter(
                Q(event_date__isnull=True) | Q(event_date__gte=today)
            ).order_by("event_date", "id")[:EVENTS_LIST_CAP]
            events = sorted(
                (e for e in rows if not _event_is_over(e, today)),
                key=_event_sort_key,
            )
        visible_ids = set(connected) | {request.user.id}
        is_admin = is_group_admin(request.user, gid)
        data = [
            serialize_event(
                e, viewer=request.user, visible_ids=visible_ids,
                request=request, is_group_admin=is_admin, detail=False,
            )
            for e in events
        ]
        return Response(data)

    def post(self, request, gid):
        if not is_group_member(request.user, gid):
            raise NotFound()
        s = EventWriteSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        data = s.validated_data
        event = Event.objects.create(
            group_id=gid,
            organiser=request.user,
            title=data["title"],
            description=data.get("description", ""),
            location_url=data.get("location_url", ""),
            location_note=data.get("location_note", ""),
            end_time=data.get("end_time"),
            timezone=data.get("timezone") or dj_settings.TIME_ZONE,
            status=EV_PLANNING,
        )
        _notify_event(event, Notification.Kind.EVENT_CREATED, _event_audience(event))
        return _event_response(event.id, request, status.HTTP_201_CREATED)


class EventDetailView(APIView):
    """A single event: read (GET), edit fields (PATCH, organiser), hard-delete
    (DELETE, organiser or group admin) at ``/events/<pk>/``.

    404 for anyone who can't see the event (non-member, or not connected to the
    organiser). PATCH covers the organiser-authored *non-scheduling* fields
    (title, description, location link/note, timezone, end time); the date, start
    time, and location name are set through ``finalise`` so the advisory-poll rule
    and the status recompute stay in one place.
    """

    def get(self, request, pk):
        event = _event_or_404(request.user, pk)
        return _event_response(event.id, request)

    def patch(self, request, pk):
        event = _event_or_404(request.user, pk)
        if event.organiser_id != request.user.id:
            raise PermissionDenied("Only the organiser can edit this event.")
        s = EventWriteSerializer(event, data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        for field, value in s.validated_data.items():
            setattr(event, field, value)
        event.save()
        return _event_response(event.id, request)

    def delete(self, request, pk):
        event = _event_or_404(request.user, pk)
        if not (
            event.organiser_id == request.user.id
            or is_group_admin(request.user, event.group_id)
        ):
            raise PermissionDenied(
                "Only the organiser or a group admin can delete this event."
            )
        event.delete()  # cascades to polls, options, votes, RSVPs, notifications
        return Response(status=status.HTTP_204_NO_CONTENT)


class EventCancelView(APIView):
    """Soft-cancel an event (``POST /events/<pk>/cancel/``) — organiser or a group
    admin. Keeps the row as a tombstone (honest history, and RSVP'd members are
    notified) rather than deleting it. Notifies everyone who RSVP'd going/maybe."""

    def post(self, request, pk):
        event = _event_or_404(request.user, pk)
        if not (
            event.organiser_id == request.user.id
            or is_group_admin(request.user, event.group_id)
        ):
            raise PermissionDenied(
                "Only the organiser or a group admin can cancel this event."
            )
        if event.status != EV_CANCELLED:
            event.status = EV_CANCELLED
            event.save()
            _notify_event(
                event, Notification.Kind.EVENT_CANCELLED,
                _event_rsvp_audience(event, [GOING, MAYBE]),
            )
        return _event_response(event.id, request)


class EventRSVPView(APIView):
    """Upsert your RSVP (``PUT /events/<pk>/rsvp/``) — any member who can see the
    event. One RSVP per person; a new response replaces the old."""

    def put(self, request, pk):
        event = _event_or_404(request.user, pk)
        s = RSVPWriteSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        data = s.validated_data
        EventRSVP.objects.update_or_create(
            event=event,
            user=request.user,
            defaults={
                "response": data["response"],
                "guests": data.get("guests", 0),
                "note": data.get("note", ""),
            },
        )
        return _event_response(event.id, request)


class EventRSVPListView(APIView):
    """The event's RSVPs (``GET /events/<pk>/rsvps/``): **complete counts** plus
    **connection-gated named lists** (decision 2 — the tally is honest, the names
    are only those you're connected with)."""

    def get(self, request, pk):
        event = _event_or_404(request.user, pk)
        event = _event_detail_qs().get(pk=event.id)
        summary = build_rsvp_summary(
            event, visible_ids=visible_reactor_ids(request.user),
            me_id=request.user.id, request=request, named=True,
        )
        return Response(summary)


def _build_option_kwargs(dimension, opt, order):
    """Turn one validated poll-option dict into ``PollOption`` kwargs for the
    dimension, filling a sensible ``label`` from the value when blank. Raises a
    ``ValidationError`` if the typed value the dimension needs is missing."""
    label = (opt.get("label") or "").strip()
    if dimension == DIM_DATE:
        value = opt.get("date_value")
        if value is None:
            raise ValidationError("Each date option needs a date.")
        return {"date_value": value, "label": label or value.isoformat(), "order": order}
    if dimension == DIM_TIME:
        value = opt.get("time_value")
        if value is None:
            raise ValidationError("Each time option needs a time.")
        return {"time_value": value, "label": label or value.strftime("%H:%M"), "order": order}
    # location / custom — free text
    text = (opt.get("text_value") or "").strip() or label
    if not text:
        raise ValidationError("Each option needs a label.")
    return {"text_value": text, "label": label or text, "order": order}


class EventPollsView(APIView):
    """Open a poll on an event (``POST /events/<pk>/polls/``) — organiser only.

    Enforces **at most one open poll per built-in dimension** (you can't run two
    date polls at once); ``custom`` polls have no such cap. ``allow_multiple``
    defaults to true for date/time ("pick every option you can do") and false for
    a single-choice location/custom. Notifies the organiser's connections."""

    def post(self, request, pk):
        event = _event_or_404(request.user, pk)
        if event.organiser_id != request.user.id:
            raise PermissionDenied("Only the organiser can open a poll.")
        s = PollCreateSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        data = s.validated_data
        dimension = data["dimension"]
        question = (data.get("question") or "").strip()
        if dimension == DIM_CUSTOM:
            if not question:
                raise ValidationError("A custom poll needs a question.")
        else:
            if event.polls.filter(dimension=dimension, status=POLL_OPEN).exists():
                raise ValidationError(
                    "There's already an open poll for that. Close it first."
                )
            question = question or _DEFAULT_POLL_QUESTION[dimension]
        allow_multiple = data.get("allow_multiple")
        if allow_multiple is None:
            allow_multiple = dimension in (DIM_DATE, DIM_TIME)

        option_kwargs = [
            _build_option_kwargs(dimension, opt, i)
            for i, opt in enumerate(data["options"])
        ]
        with transaction.atomic():
            poll = Poll.objects.create(
                event=event,
                dimension=dimension,
                question=question,
                allow_multiple=allow_multiple,
                closes_at=data.get("closes_at"),
                created_by=request.user,
            )
            PollOption.objects.bulk_create(
                [PollOption(poll=poll, **kw) for kw in option_kwargs]
            )
        _notify_event(event, Notification.Kind.POLL_OPENED, _event_audience(event))
        return _poll_response(poll.id, request, status.HTTP_201_CREATED)


def _poll_or_404(user, pk):
    """Fetch a poll whose event the user may see, or 404."""
    poll = get_object_or_404(
        Poll.objects.select_related("event", "event__organiser", "event__group"),
        pk=pk,
    )
    if not can_view_event(user, poll.event):
        raise NotFound()
    return poll


class PollDetailView(APIView):
    """A poll's detail (``GET``), typo-fix edit (``PATCH``), or removal
    (``DELETE``) — the last two organiser-only."""

    def get(self, request, pk):
        poll = _poll_or_404(request.user, pk)
        return _poll_response(poll.id, request)

    def patch(self, request, pk):
        """Fix a poll's mistakes (``PATCH /polls/<pk>/``) — organiser only.

        Editable: the ``question``, ``allow_multiple`` (pick-one vs pick-any),
        and the ``options`` — the same fields, and the same "at least two", as
        opening a poll. When ``options`` is given it's the **full desired set**:
        an entry with an ``id`` rewrites that existing option, an entry without
        one is a new option, and any existing option missing from the set is
        removed — so the edit form is the create form pre-filled. **A poll locks
        the moment its first vote lands** — editing a voted poll is refused with
        a 409, because rewriting or dropping an option someone already voted for
        would silently redefine their vote (the integrity guard behind the
        honest-coordination-number rule); reconciling the set is only safe
        *because* of that zero-votes guard. Never re-notifies: a fix isn't a new
        poll."""
        poll = _poll_or_404(request.user, pk)
        if poll.event.organiser_id != request.user.id:
            raise PermissionDenied("Only the organiser can edit a poll.")
        if PollVote.objects.filter(option__poll=poll).exists():
            return Response(
                {"detail": "This poll has votes and can no longer be edited."},
                status=status.HTTP_409_CONFLICT,
            )
        s = PollEditSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        data = s.validated_data
        with transaction.atomic():
            poll_fields = []
            if "question" in data:
                poll.question = data["question"]
                poll_fields.append("question")
            if "allow_multiple" in data:
                poll.allow_multiple = data["allow_multiple"]
                poll_fields.append("allow_multiple")
            if poll_fields:
                poll.save(update_fields=poll_fields)
            if "options" in data:
                self._reconcile_options(poll, data["options"])
        return _poll_response(poll.id, request)

    @staticmethod
    def _reconcile_options(poll, submitted):
        """Make the poll's options match ``submitted`` (the full desired set):
        rewrite entries carrying an ``id``, create id-less ones, and delete any
        existing option the set dropped. Safe only under the zero-votes guard the
        caller has already checked (no cast vote can be redefined or orphaned)."""
        if len(submitted) < 2:
            raise ValidationError({"options": "A poll needs at least two options."})
        by_id = {o.id: o for o in poll.options.all()}
        seen_ids = set()
        to_update, to_create = [], []
        for order, opt in enumerate(submitted):
            # Reuse the create-time normalisation: it validates the value the
            # dimension needs and re-derives the label, keeping labels in sync
            # exactly as on create.
            kwargs = _build_option_kwargs(poll.dimension, opt, order)
            oid = opt.get("id")
            if oid is not None:
                existing = by_id.get(oid)
                if existing is None:
                    raise ValidationError(
                        {"options": "An option doesn't belong to this poll."}
                    )
                if oid in seen_ids:
                    # The same option twice would collapse into one row while the
                    # min-two check (on submitted length) still passed — leaving
                    # the poll with fewer real options than it should have.
                    raise ValidationError(
                        {"options": "An option is listed more than once."}
                    )
                for field, value in kwargs.items():
                    setattr(existing, field, value)
                to_update.append(existing)
                seen_ids.add(oid)
            else:
                to_create.append(PollOption(poll=poll, **kwargs))
        stale_ids = [oid for oid in by_id if oid not in seen_ids]
        if stale_ids:
            PollOption.objects.filter(id__in=stale_ids).delete()
        if to_update:
            PollOption.objects.bulk_update(
                to_update,
                ["label", "date_value", "time_value", "text_value", "order"],
            )
        if to_create:
            PollOption.objects.bulk_create(to_create)

    def delete(self, request, pk):
        poll = _poll_or_404(request.user, pk)
        if poll.event.organiser_id != request.user.id:
            raise PermissionDenied("Only the organiser can remove a poll.")
        poll.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class PollVoteView(APIView):
    """Cast/replace your votes on a poll (``PUT /polls/<pk>/vote/``).

    Any member who can see the event may vote, but only while the poll is
    ``open`` (a closed poll 403s) and before any ``closes_at`` soft deadline. The
    body is ``{option_ids: [...]}`` — your full selection: it **replaces** your
    previous votes on this poll (so a single-choice poll swaps, a multi-choice
    poll re-sets). An empty list clears your vote.
    """

    def put(self, request, pk):
        poll = _poll_or_404(request.user, pk)
        if poll.status != POLL_OPEN:
            raise PermissionDenied("This poll is closed.")
        if poll.closes_at is not None and poll.closes_at < timezone.now():
            raise PermissionDenied("Voting has closed for this poll.")
        option_ids = request.data.get("option_ids", [])
        if not isinstance(option_ids, list):
            raise ValidationError({"option_ids": "Expected a list of option ids."})
        valid_ids = set(
            poll.options.values_list("id", flat=True)
        )
        # De-dupe while preserving order: a client that repeats an id ("[5, 5]")
        # would otherwise create two identical votes and trip the (option, voter)
        # unique constraint — a 500 instead of a harmless single vote.
        chosen = []
        seen = set()
        for oid in option_ids:
            if oid not in valid_ids:
                raise ValidationError(
                    {"option_ids": "An option doesn't belong to this poll."}
                )
            if oid not in seen:
                seen.add(oid)
                chosen.append(oid)
        if not poll.allow_multiple and len(chosen) > 1:
            raise ValidationError(
                {"option_ids": "This poll only allows one choice."}
            )
        with transaction.atomic():
            PollVote.objects.filter(
                option__poll=poll, voter=request.user
            ).delete()
            PollVote.objects.bulk_create(
                [PollVote(option_id=oid, voter=request.user) for oid in chosen]
            )
        return _poll_response(poll.id, request)


class PollCloseView(APIView):
    """Close a poll without deciding (``POST /polls/<pk>/close/``) — organiser.
    Closing freezes the tally; it does **not** finalise (polls are advisory —
    ``finalise`` is the separate, explicit decision)."""

    def post(self, request, pk):
        poll = _poll_or_404(request.user, pk)
        if poll.event.organiser_id != request.user.id:
            raise PermissionDenied("Only the organiser can close a poll.")
        if poll.status != POLL_CLOSED:
            poll.status = POLL_CLOSED
            poll.save(update_fields=["status"])
        return _poll_response(poll.id, request)


class PollReopenView(APIView):
    """Re-open a closed poll (``POST /polls/<pk>/reopen/``) — organiser only.

    The inverse of close, for when a poll was shut early. Re-opening a built-in
    poll re-checks the **one-open-poll-per-built-in-dimension** rule (you can't
    have two live date polls) — even if the dimension itself is already set, a
    second *open* poll for it is refused. It does not un-finalise anything;
    voting simply resumes on the tally.

    Any elapsed ``closes_at`` soft deadline is **cleared** on re-open: otherwise
    the poll would read ``open`` yet ``PollVoteView`` would keep 403-ing every
    vote (it independently refuses votes past ``closes_at``), so re-opening would
    silently fail to restore voting."""

    def post(self, request, pk):
        poll = _poll_or_404(request.user, pk)
        if poll.event.organiser_id != request.user.id:
            raise PermissionDenied("Only the organiser can re-open a poll.")
        if poll.status != POLL_OPEN:
            if poll.dimension != DIM_CUSTOM and poll.event.polls.filter(
                dimension=poll.dimension, status=POLL_OPEN
            ).exclude(pk=poll.pk).exists():
                raise ValidationError(
                    "There's already an open poll for that. Close it first."
                )
            poll.status = POLL_OPEN
            update_fields = ["status"]
            if poll.closes_at is not None and poll.closes_at < timezone.now():
                poll.closes_at = None
                update_fields.append("closes_at")
            poll.save(update_fields=update_fields)
        return _poll_response(poll.id, request)


class EventFinaliseView(APIView):
    """Finalise a dimension (``POST /events/<pk>/finalise/``) — organiser only.

    **The decision, not the poll.** The organiser sets a value on a dimension —
    for a built-in this writes the structured field (``event_date`` /
    ``start_time`` / ``location_name``), recomputes ``status``, and (by default)
    closes the related open poll; for ``custom`` it pins a winning option. The
    written value **need not** be a poll option (decision 3 — "actually, let's do
    Friday"). Setting a date for the first time flips the event to ``scheduled``
    and notifies the organiser's connections; a later change to an
    already-scheduled event notifies those who RSVP'd going/maybe.
    """

    def post(self, request, pk):
        event = _event_or_404(request.user, pk)
        if event.organiser_id != request.user.id:
            raise PermissionDenied("Only the organiser can finalise a decision.")
        s = FinaliseSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        data = s.validated_data
        dimension = data["dimension"]
        raw_value = (data.get("value") or "").strip()
        close_poll = data.get("close_poll", True)
        was_scheduled = event.status == EV_SCHEDULED

        with transaction.atomic():
            if dimension == DIM_CUSTOM:
                self._finalise_custom(event, data, close_poll)
                # A pinned custom outcome is informational — no status change,
                # no structured notification (matches the notifications table,
                # which only covers date/time/location changes).
                return _event_response(event.id, request)

            self._finalise_builtin(event, dimension, raw_value)
            _recompute_event_status(event)
            event.save()
            if close_poll:
                event.polls.filter(
                    dimension=dimension, status=POLL_OPEN
                ).update(status=POLL_CLOSED)

        newly_scheduled = event.status == EV_SCHEDULED and not was_scheduled
        if newly_scheduled:
            _notify_event(
                event, Notification.Kind.EVENT_SCHEDULED, _event_audience(event)
            )
        elif was_scheduled:
            _notify_event(
                event, Notification.Kind.EVENT_UPDATED,
                _event_rsvp_audience(event, [GOING, MAYBE]),
            )
        return _event_response(event.id, request)

    def _finalise_builtin(self, event, dimension, raw_value):
        if dimension == DIM_DATE:
            value = parse_date(raw_value)
            if value is None:
                raise ValidationError({"value": "Expected a date (YYYY-MM-DD)."})
            event.event_date = value
        elif dimension == DIM_TIME:
            if raw_value:
                value = parse_time(raw_value)
                if value is None:
                    raise ValidationError({"value": "Expected a time (HH:MM)."})
                event.start_time = value
            else:
                # An explicit empty value clears the time (back to all-day).
                event.start_time = None
        elif dimension == DIM_LOCATION:
            event.location_name = raw_value

    def _finalise_custom(self, event, data, close_poll):
        option_id = data.get("option_id")
        if option_id is None:
            raise ValidationError(
                {"option_id": "Pick an option to pin as the decision."}
            )
        option = get_object_or_404(
            PollOption, pk=option_id, poll__event=event,
            poll__dimension=DIM_CUSTOM,
        )
        poll = option.poll
        poll.decided_option = option
        if close_poll:
            poll.status = POLL_CLOSED
        poll.save(update_fields=["decided_option", "status"])


class GroupCalendarView(APIView):
    """One group's dated events in a window (``GET /groups/<gid>/calendar/?from=&to=``)
    for the month grid — members only, connection-gated, chronological."""

    def get(self, request, gid):
        if not is_group_member(request.user, gid):
            raise NotFound()
        connected = connected_user_ids(request.user)
        qs = (
            visible_events(request.user, gid, connected_ids=connected)
            .filter(event_date__isnull=False)
            .prefetch_related("polls__options__votes__voter", "rsvps__user")
        )
        qs = _apply_calendar_window(qs, request)
        visible_ids = set(connected) | {request.user.id}
        is_admin = is_group_admin(request.user, gid)
        data = [
            serialize_event(
                e, viewer=request.user, visible_ids=visible_ids,
                request=request, is_group_admin=is_admin, detail=False,
            )
            for e in qs.order_by("event_date", "start_time", "id")
        ]
        return Response(data)


class PersonalCalendarView(APIView):
    """The personal calendar (``GET /calendar/?from=&to=``): a **pure time-merge**
    of the dated events you can see across **every group you're an active member
    of** — connected to the organiser, no ranking (the same discipline as the
    ``include_groups`` feed toggle). Each event carries its group label."""

    def get(self, request):
        connected = connected_user_ids(request.user)
        group_ids = GroupMembership.objects.filter(
            user=request.user, status=ACTIVE
        ).values_list("group_id", flat=True)
        visible_organisers = set(connected) | {request.user.id}
        qs = (
            Event.objects.filter(
                group_id__in=list(group_ids),
                organiser_id__in=visible_organisers,
                organiser__is_active=True,
                event_date__isnull=False,
            )
            .select_related("organiser", "group")
            .prefetch_related("polls__options__votes__voter", "rsvps__user")
        )
        qs = _apply_calendar_window(qs, request)
        data = [
            serialize_event(
                e, viewer=request.user, visible_ids=visible_organisers,
                request=request, detail=False,
            )
            for e in qs.order_by("event_date", "start_time", "id")
        ]
        return Response(data)


def _apply_calendar_window(qs, request):
    """Clamp a calendar queryset to the optional ``from``/``to`` date params."""
    frm = parse_date(request.query_params.get("from", "") or "")
    to = parse_date(request.query_params.get("to", "") or "")
    if frm is not None:
        qs = qs.filter(event_date__gte=frm)
    if to is not None:
        qs = qs.filter(event_date__lte=to)
    return qs
