"""Notification generation for the activity centre (Phase 8).

One explicit ``create_notification`` call is made from the view where a notifiable
action happens (a reply, a reaction, a connection request/accept, a group invite)
— deliberately *not* via Django signals, so the flow is easy to read, test, and
gate. This module is the single choke-point where the three cross-cutting rules
live, so no call site can forget one:

- **Never notify yourself** for your own action.
- **Respect the recipient's preferences** — a muted (mutable) kind produces no row
  at all, which also means no future push.
- **Never leak an action from someone the recipient can't see** — for the
  content kinds (reply/reaction) the actor must be connected with the recipient,
  mirroring the per-viewer pruning of the comment tree and reactions. (The
  request/invite kinds are exempt: a connection request necessarily comes from
  someone you're *not* yet connected with, and that's the whole point of it.)

The ``address_*`` helpers implement the "resolve-elsewhere" half of the unified
badge: when a connection request or group invite is dealt with on its own page,
its notification is marked addressed so the badge stops counting it.

``enqueue_message_pushes`` at the bottom is the odd one out and deliberately so:
a **message** buzzes a phone without ever creating a ``Notification`` row, because
messaging is not part of the activity centre (it has its own unread badge — see
docs/reference/messaging.md). It lives in this module anyway so that *every* rule
about what may reach someone's phone is readable in one file.
"""

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .models import (
    Connection,
    Notification,
    NotificationPreference,
    Participant,
    PushOutbox,
)

# The content kinds whose actor must be visible to (connected with) the recipient
# before we notify — so a not-connected replier/reactor on a group post never
# surfaces second-hand, exactly as the pruned comment/reaction views hide them.
# The event kinds (Phase 8b) belong here too: the actor is always the event's
# organiser, and an event is authored content visible only to the organiser's
# connections, so the "never leak an action from someone you can't see" rule
# lands the notification on precisely the audience that can see the event — no
# event-specific gating code needed. (Contrast ``group_invite``, exempt because
# it necessarily comes from a non-connection.)
_CONNECTION_GATED_KINDS = frozenset(
    {
        Notification.Kind.POST_REPLY,
        Notification.Kind.COMMENT_REPLY,
        Notification.Kind.REACTION,
        Notification.Kind.EVENT_CREATED,
        Notification.Kind.POLL_OPENED,
        Notification.Kind.EVENT_SCHEDULED,
        Notification.Kind.EVENT_UPDATED,
        Notification.Kind.EVENT_CANCELLED,
    }
)

# Kinds that refresh an existing *unread* row rather than stacking a duplicate:
# a react/un-react/re-react, or repeated edits to one event within a short
# window, bump a single line to the top instead of filling the centre.
_DEDUP_KINDS = frozenset(
    {Notification.Kind.REACTION, Notification.Kind.EVENT_UPDATED}
)


def _are_connected(a_id, b_id):
    """Whether users ``a_id`` and ``b_id`` have an accepted (symmetric)
    connection. Queried against ``Connection`` directly (rather than importing
    ``views.connected_user_ids``) to keep this module free of a circular import;
    it's the same accepted-either-direction rule."""
    return (
        Connection.objects.filter(status=Connection.Status.ACCEPTED)
        .filter(
            Q(requester_id=a_id, requestee_id=b_id)
            | Q(requester_id=b_id, requestee_id=a_id)
        )
        .exists()
    )


def create_notification(recipient, actor, kind, *, post=None, comment=None,
                        group=None, connection=None, event=None):
    """Create (and return) a notification, or return ``None`` if it's suppressed.

    Suppressed when: the recipient is the actor (no self-notifications); the
    recipient has muted this (mutable) kind; or it's a connection-gated content
    kind and the actor isn't someone the recipient may see. For the ``reaction``
    and ``event_updated`` kinds an existing *unread* notification for the same
    (recipient, actor, target) is refreshed instead of stacking a duplicate — a
    react/un-react/re-react, or repeated edits to one event, bumps one row to the
    top rather than filling the centre with near-identical lines.
    """
    if actor is not None and actor.id == recipient.id:
        return None

    if kind in Notification.MUTABLE_KINDS:
        pref = NotificationPreference.objects.filter(
            user=recipient, kind=kind
        ).first()
        if pref is not None and not pref.enabled:
            return None

    if kind in _CONNECTION_GATED_KINDS:
        # actor is never None for these kinds, and never the recipient (skipped
        # above), so this is a plain "are we connected" check.
        if actor is None or not _are_connected(recipient.id, actor.id):
            return None

    if kind in _DEDUP_KINDS:
        existing = Notification.objects.filter(
            recipient=recipient,
            actor=actor,
            kind=kind,
            post=post,
            comment=comment,
            event=event,
            seen_at__isnull=True,
        ).first()
        if existing is not None:
            # auto_now_add only sets created_at on insert; assigning it on an
            # update is honoured, so this bumps the row to the top of the list.
            existing.created_at = timezone.now()
            existing.save(update_fields=["created_at"])
            return existing

    # Atomic because the two rows are one fact: ATOMIC_REQUESTS is off, so
    # without this a failure between them would leave a notification that can
    # never be pushed (nothing re-scans for un-enqueued notifications).
    with transaction.atomic():
        notification = Notification.objects.create(
            recipient=recipient,
            actor=actor,
            kind=kind,
            post=post,
            comment=comment,
            group=group,
            connection=connection,
            event=event,
        )
        # Queue a push for the same event (Phase 9, Milestone D). Only new rows
        # get one: the _DEDUP_KINDS path above returns early, so a re-reaction
        # or a second edit to one event refreshes a still-unread notification
        # without buzzing the phone again for something the recipient was
        # already told about. Enqueue only — the send happens out-of-band, see
        # PushOutbox.
        PushOutbox.objects.create(
            notification=notification, recipient=recipient
        )
    return notification


def enqueue_message_pushes(message):
    """Queue a push for everyone who should be told about ``message``.

    Returns the ``PushOutbox`` rows created (mostly for tests to assert on).
    Called from the message-create view inside its transaction, so a failed send
    can't leave a message that was never announced — and, like every other push,
    only a *row* is written here; the network call happens out-of-band in
    ``manage.py send_pushes``.

    **Who gets one.** Every participant who is ``active``, hasn't left, is still
    an active account, hasn't muted the thread, and — the subtle one — for whom
    this message is actually *visible*: their ``ParticipantInterval`` must span
    the message's ``created_at``. That last rule is why this can't just be "the
    other members": someone sitting at ``pending`` (invited but not yet connected
    to everyone), or in the gap between two intervals, cannot read the message in
    the thread, so buzzing them would announce content the app would then refuse
    to show. The interval test is one ``filter()`` call on purpose — split across
    two, Django would join the interval table twice and let *different* intervals
    satisfy the start and end halves, which would let a gap member through.

    The sender is excluded by the same query rather than by a special case: they
    are simply not someone the message is news to.

    **Mute is checked here, not at send time**, matching how a muted
    notification kind never reaches the outbox either — one gate, at enqueue,
    with nothing to keep in sync. The cost is that muting is not retroactive: a
    push already queued still goes out. That's a second or two of exposure on a
    timer-driven queue, and the alternative (re-checking at send) means two
    places to get wrong.

    **Coalescing.** If a recipient already has an *unsent* push queued for this
    conversation, we don't add another. A burst of ten messages should buzz a
    phone once and leave the unread badge to carry the count; without this, the
    outbox would faithfully deliver ten separate buzzes, which is the single
    fastest way to make someone turn notifications off.

    **@mentions are the one exception to mute** (Phase 9b M8). Naming someone is
    how you get their attention, so a mention reaches them even in a thread they
    silenced — but that is, unavoidably, a way to punch through a quiet somebody
    deliberately asked for, so it's **opt-out per user**: a
    ``NotificationPreference`` row for the ``mention`` kind with ``enabled=False``
    turns the override off. Be precise about what that setting is: it governs
    *only* whether a mention beats mute. A mention in an unmuted thread notifies
    either way (it comes through the ordinary path above), and a muted thread with
    the setting off stays completely silent. Every other rule still applies to a
    mention — you must be active, not left, and the message must fall inside your
    interval — because a mention can't make a message readable that isn't.

    **A conversation with no ``Participant`` rows produces nothing.** Those are
    legacy direct threads predating Phase 6a (migration ``0009`` backfilled the
    real ones; only threads built straight off the model, as Phase 5's tests do,
    still lack them). Silence is the right failure here — the alternative is
    guessing at visibility without the interval data that decides it.
    """
    convo_id = message.conversation_id
    when = message.created_at

    # Everyone who could read this message: active, present, and with an interval
    # spanning it. Mute is *not* filtered here any more — it's applied below, so
    # the mention exception can be carved out of one audience rather than
    # assembled from two queries that could disagree about visibility.
    audience = (
        Participant.objects.filter(
            conversation_id=convo_id,
            left_at__isnull=True,
            status=Participant.Status.ACTIVE,
            user__is_active=True,
        )
        .exclude(user_id=message.sender_id)
        .filter(
            # One filter() → one join → one interval row must satisfy both
            # halves. See the docstring.
            Q(intervals__started_at__lte=when)
            & (
                Q(intervals__ended_at__isnull=True)
                | Q(intervals__ended_at__gt=when)
            )
        )
    )
    recipient_ids = set(
        audience.filter(muted_at__isnull=True)
        .values_list("user_id", flat=True)
        .distinct()
    )
    recipient_ids |= _mentioned_despite_mute(message, audience)
    if not recipient_ids:
        return []

    already_queued = set(
        PushOutbox.objects.filter(
            sent_at__isnull=True,
            message__conversation_id=convo_id,
            recipient_id__in=recipient_ids,
        ).values_list("recipient_id", flat=True)
    )
    outstanding = recipient_ids - already_queued
    if not outstanding:
        return []

    return PushOutbox.objects.bulk_create(
        [
            PushOutbox(message=message, recipient_id=user_id)
            for user_id in sorted(outstanding)
        ]
    )


def _mentioned_despite_mute(message, audience):
    """The user ids this message *mentions* who have muted the thread but still
    want mentions to reach them (Phase 9b M8).

    Carved out of the same ``audience`` queryset the unmuted recipients come
    from, so a mention can never route around visibility: someone in an interval
    gap, or sitting at ``pending``, isn't in that set and so can't be reached by
    being named. It's the same reason the mute filter moved out of the base query
    rather than this being a second query of its own.

    The preference is read the same way ``create_notification`` reads one —
    **absence means enabled** — so the override is on until someone turns it off.
    """
    mentioned_ids = set(message.mentions.values_list("user_id", flat=True))
    if not mentioned_ids:
        return set()

    opted_out = set(
        NotificationPreference.objects.filter(
            user_id__in=mentioned_ids,
            kind=Notification.Kind.MENTION,
            enabled=False,
        ).values_list("user_id", flat=True)
    )
    return set(
        audience.filter(
            muted_at__isnull=False,
            user_id__in=mentioned_ids - opted_out,
        )
        .values_list("user_id", flat=True)
        .distinct()
    )


def address_connection_request(recipient, connection):
    """Mark ``recipient``'s unaddressed ``connection_request`` notification for
    ``connection`` as addressed — called when they approve it on the People page
    (a reject deletes the Connection row, which cascades the notification away)."""
    Notification.objects.filter(
        recipient=recipient,
        connection=connection,
        kind=Notification.Kind.CONNECTION_REQUEST,
        addressed_at__isnull=True,
    ).update(addressed_at=timezone.now())


def address_group_invite(recipient, group):
    """Mark ``recipient``'s unaddressed ``group_invite`` notification(s) for
    ``group`` as addressed — called when they accept *or* reject the invite.

    Needed on reject too: rejecting deletes the ``GroupMembership`` row, but the
    notification's target is the ``Group`` (which lives on), so without this the
    badge would keep counting an invite the user has already dealt with.
    """
    Notification.objects.filter(
        recipient=recipient,
        group=group,
        kind=Notification.Kind.GROUP_INVITE,
        addressed_at__isnull=True,
    ).update(addressed_at=timezone.now())
