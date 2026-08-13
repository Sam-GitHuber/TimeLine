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
        # Someone commented on your event. Gated like every other content kind:
        # the commenter has to be someone you may see. It can't actually fire
        # otherwise — an event's audience *is* the organiser's connections, so a
        # commenter is connected to the organiser by construction — but the gate
        # is the cheap half of a belt-and-braces pair, and leaving a content kind
        # out of this set is exactly the kind of omission nobody notices until
        # the audience rule changes underneath it.
        Notification.Kind.EVENT_COMMENT,
        # Someone added photos to an event you're going to. This is the one
        # event kind where the gate does **real** work rather than belt-and-
        # braces: its recipients are the event's going/maybe RSVPs, and two
        # people in an event's audience are connected to the *organiser* without
        # necessarily being connected to each other. The album prunes on the
        # uploader for exactly that reason (see ``EventPhoto``), so notifying
        # someone about photos they will not be shown would be a dangling
        # deep-link at best and a leak of who was at the event at worst. Putting
        # the kind in this set makes the recipient filter the same one line of
        # code every other content kind uses.
        Notification.Kind.EVENT_PHOTOS,
    }
)

# --- Android notification channels (Phase 10) -------------------------------
#
# Android 8+ files every notification into a **channel**, and the channel — not
# the app — owns whether it makes a sound, shows a heads-up banner, or lights
# the LED. A user tunes them individually in system settings, which is the point:
# "let messages interrupt me but keep reactions quiet" is a thing they can decide
# without us building a screen for it.
#
# The grouping mirrors the **per-type preferences**, so the OS-level control and
# the in-app one tell the same story instead of contradicting each other. It is
# deliberately *not* one channel per kind: the six kinds filed under ``events``
# would be six separate switches, and that's a wall nobody reads.
#
# Two things make this fussier than it looks:
#
# 1. **The ids must match the app's** (``CHANNELS`` in mobile/src/push.ts). An
#    Android push naming a channel that doesn't exist on the device does not
#    fall back to a default — it is **dropped silently**, which looks exactly
#    like push being broken. Pinned by a test on each side, the same belt-and-
#    braces as ``MESSAGE_CATEGORY``.
# 2. **A channel's settings are immutable once created on a device.** Changing an
#    importance here does nothing to anyone who already has the app; only a new
#    channel id takes effect. So these are chosen to be lived with, and the
#    importances live in the app (which creates the channels), not here.
_KIND_CHANNELS = {
    Notification.Kind.POST_REPLY: "replies",
    Notification.Kind.COMMENT_REPLY: "replies",
    # **"replies", not "events".** The channel groups by what the notification
    # *is* to the person receiving it, and this one is "somebody answered
    # something you made" — the same thing a reply to your post is. The five
    # `events` kinds are the organiser broadcasting to everyone else (a poll
    # opened, a date set); filing a comment on your own event beside them would
    # mean quietening those also quietened people talking to you.
    Notification.Kind.EVENT_COMMENT: "replies",
    Notification.Kind.REACTION: "reactions",
    Notification.Kind.CONNECTION_REQUEST: "social",
    Notification.Kind.CONNECTION_ACCEPTED: "social",
    Notification.Kind.GROUP_INVITE: "social",
    Notification.Kind.EVENT_CREATED: "events",
    Notification.Kind.POLL_OPENED: "events",
    Notification.Kind.EVENT_SCHEDULED: "events",
    Notification.Kind.EVENT_UPDATED: "events",
    Notification.Kind.EVENT_CANCELLED: "events",
    # **"events", not "replies"** — the opposite call from ``EVENT_COMMENT``
    # directly above, by the same rule. Photos going up is an announcement
    # *about the event* to everyone who was there, not somebody answering you,
    # so it belongs with the organiser's broadcasts. (The actor being the
    # uploader rather than the organiser is a gating question, not a channel
    # one: the channel groups by what the notification is to the person getting
    # it.)
    Notification.Kind.EVENT_PHOTOS: "events",
    # A mention rides the messaging surface but keeps its own channel, matching
    # its own preference: being named is the one thing that should still reach
    # you in a chat you've otherwise quietened.
    Notification.Kind.MENTION: "mentions",
}

# The kind a *message* push carries. It has no ``Notification`` row, so it isn't
# in the map above (see ``enqueue_message_pushes``).
MESSAGE_CHANNEL = "messages"

# A mention arrives as a *message* push too — ``Kind.MENTION`` exists only so the
# preference has a home and never creates a ``Notification`` row. So the sender
# picks this explicitly (see ``send_pushes._payload``); reaching it through
# ``channel_for_kind`` is impossible, and leaving it that way made the channel an
# inert switch in Android settings.
MENTION_CHANNEL = _KIND_CHANNELS[Notification.Kind.MENTION]

# Where anything unrecognised goes. A kind added later without a channel still
# gets delivered — quietly wrong beats silently dropped — and a test enumerating
# ``Notification.Kind`` fails so it doesn't stay that way.
DEFAULT_CHANNEL = "social"

# Every channel the app creates, and so every value we may put on the wire.
# The app holds the matching list (``CHANNELS`` in mobile/src/push.ts); a test
# on each side pins the set, because the two can only be kept in step by saying
# so twice.
ANDROID_CHANNELS = frozenset(_KIND_CHANNELS.values()) | {MESSAGE_CHANNEL}


def channel_for_kind(kind):
    """The Android notification channel a push of this ``kind`` belongs in."""
    if kind == "message":
        return MESSAGE_CHANNEL
    return _KIND_CHANNELS.get(kind, DEFAULT_CHANNEL)


# Kinds that refresh an existing *unread* row rather than stacking a duplicate:
# a react/un-react/re-react, repeated edits to one event, or several batches of
# photos added to one album, bump a single line to the top instead of filling
# the centre. Photos belong here for the plainest possible reason — people
# upload in batches. You take out your phone at the end of the evening, send
# eight, notice four more, send those: that's one thing that happened, and the
# ``PushOutbox`` row is only written for genuinely new notifications, so it's
# also one buzz rather than two.
_DEDUP_KINDS = frozenset(
    {
        Notification.Kind.REACTION,
        Notification.Kind.EVENT_UPDATED,
        Notification.Kind.EVENT_PHOTOS,
    }
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


def _connected_ids(user_id):
    """Every user id ``user_id`` has an accepted connection with — the set form
    of ``_are_connected``, for the bulk path below. Same rule, same table, one
    query instead of one ``EXISTS`` per candidate recipient; and, like
    ``_are_connected``, spelled out here rather than imported from ``views`` to
    keep this module import-cycle-free."""
    pairs = (
        Connection.objects.filter(status=Connection.Status.ACCEPTED)
        .filter(Q(requester_id=user_id) | Q(requestee_id=user_id))
        .values_list("requester_id", "requestee_id")
    )
    return {
        requestee if requester == user_id else requester
        for requester, requestee in pairs
    }


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


def create_notifications(recipients, actor, kind, *, post=None, comment=None,
                         group=None, connection=None, event=None,
                         connected_ids=None):
    """``create_notification`` for a whole audience at once, in a **bounded**
    number of queries. Returns the notifications created or refreshed.

    Every rule above is applied here, unchanged — no self-notification, muted
    kinds dropped, ``_CONNECTION_GATED_KINDS`` enforced, ``_DEDUP_KINDS``
    refreshing an existing *unread* row instead of stacking a second one, and a
    ``PushOutbox`` row only for genuinely new notifications. The difference is
    purely how they're evaluated: **set-wise instead of per recipient**.

    **Why this exists.** The one-at-a-time version costs about seven statements
    per recipient (preference, connection ``EXISTS``, dedup, ``BEGIN``, two
    inserts, ``COMMIT``), and a broadcast to thirty people measured at 211. That
    is fine for the one-off notifications the rest of the app fires, and not fine
    for a fan-out that runs in the same request as an image upload on a single
    worker. Here the same rules cost one preferences query, one connections
    query, one dedup query, and one insert per table.

    ``connected_ids`` lets a caller that has already computed the **actor's**
    connection set — the event views all have it, they need it for the
    visibility gate — hand it over rather than making this scan ``Connection``
    a second time in one request. Pass the *actor's* set or nothing; passing
    anyone else's would silently widen the gate.
    """
    ids = {r.id for r in recipients if actor is None or r.id != actor.id}
    if not ids:
        return []

    if kind in Notification.MUTABLE_KINDS:
        # Absence means enabled, exactly as the single-row path reads it, so we
        # ask only for the rows that say "off".
        ids -= set(
            NotificationPreference.objects.filter(
                user_id__in=ids, kind=kind, enabled=False
            ).values_list("user_id", flat=True)
        )

    if kind in _CONNECTION_GATED_KINDS:
        if actor is None:
            return []
        if connected_ids is None:
            connected_ids = _connected_ids(actor.id)
        ids &= set(connected_ids)

    if not ids:
        return []

    refreshed = []
    if kind in _DEDUP_KINDS:
        # One query for everyone's still-unread row instead of one each. The
        # queryset keeps ``Notification``'s newest-first ordering, so taking the
        # first row seen per recipient is the same row ``.first()`` picked.
        for existing in Notification.objects.filter(
            recipient_id__in=ids,
            actor=actor,
            kind=kind,
            post=post,
            comment=comment,
            event=event,
            seen_at__isnull=True,
        ):
            if existing.recipient_id in ids:
                ids.discard(existing.recipient_id)
                refreshed.append(existing)
        if refreshed:
            now = timezone.now()
            for existing in refreshed:
                existing.created_at = now
            # ``auto_now_add`` only fires on insert, so assigning ``created_at``
            # is honoured — this bumps the rows to the top of the list, as the
            # single-row path does with ``save(update_fields=…)``.
            Notification.objects.filter(
                pk__in=[n.pk for n in refreshed]
            ).update(created_at=now)

    if not ids:
        return refreshed

    # Atomic for the same reason the single-row path is: the notification and
    # its outbox row are one fact, and nothing re-scans for un-enqueued
    # notifications, so a failure between them would be a push that never goes.
    with transaction.atomic():
        created = Notification.objects.bulk_create(
            [
                Notification(
                    recipient_id=user_id,
                    actor=actor,
                    kind=kind,
                    post=post,
                    comment=comment,
                    group=group,
                    connection=connection,
                    event=event,
                )
                # Sorted so the insert order is stable and a test can read it.
                for user_id in sorted(ids)
            ]
        )
        PushOutbox.objects.bulk_create(
            [
                PushOutbox(notification=n, recipient_id=n.recipient_id)
                for n in created
            ]
        )
    return refreshed + created


# How much of a message a **preview** may put on a lock screen (Phase 10b).
# Defined here rather than in the extension's Swift so there is one number, on
# the side that can be tested — and so shortening it later doesn't need an app
# release. Generous enough that most messages arrive whole, short enough that a
# long one can't fill a stranger's screen over someone's shoulder.
PREVIEW_TEXT_LIMIT = 120


def message_push_body(message, recipient_id, *, preview=False):
    """The line a **message** push shows, for one recipient.

    The single implementation of message push wording, shared by the sender
    (``manage.py send_pushes``, which calls it contentless) and the preview
    endpoint (which calls it with ``preview=True``). They must agree: the
    preview *replaces* the body the sender composed, on the same notification,
    and two copies of this phrasing would drift the moment either grew a branch.

    **Contentless mode is the wire body**, and the rule it follows is the one
    the whole push design rests on: name the person, never quote them. It
    travels through Expo and Apple/Google, so it says who and what medium and
    nothing else.

    **Preview mode is device-side**, composed for a body that will be swapped in
    by the notification extension after the push has arrived over TLS. Only here
    may the message's own text appear, truncated to ``PREVIEW_TEXT_LIMIT``.

    The four branches are the same in both modes, which is the point — a preview
    is the ordinary body with the text appended, not a separate format:

    - **mentioned** first, because being named is *why* the push exists whenever
      the thread is muted, and a silenced chat that suddenly buzzes owes an
      explanation.
    - **a photo** next: knowing a picture is waiting is often the whole reason to
      open the app, and "sent a photo" is no more revealing than "sent a
      message". Said whenever there's an attachment, caption or not.
    - **a named group** qualifies either of those, and stands alone otherwise,
      because "New message from Ada" is ambiguous when Ada is in four of your
      chats. An untitled group falls back to the neutral phrasing rather than
      inventing a name — and a 1:1 must never render a trailing "in ".
    - otherwise the plain line.

    The plain branch is the one place the two modes differ in *shape*: contentless
    it reads "New message from Ada", which does not extend into "New message from
    Ada: hello". With text to show, the sender's name alone is the natural
    prefix.

    A photo with **no caption** is why this can't return its ingredients for
    someone else to assemble: ``text`` is empty on those, and a caller
    concatenating fields would put a title over a blank line — strictly worse
    than "Ada sent a photo".
    """
    sender = message.sender.display_name
    convo = message.conversation
    photo = message.attachments.exists()
    mentioned = any(
        mention.user_id == recipient_id for mention in message.mentions.all()
    )
    named_group = convo.kind == convo.Kind.GROUP and convo.title
    suffix = f" in {convo.title}" if named_group else ""

    if mentioned:
        line = f"{sender} mentioned you{suffix}"
    elif photo:
        line = f"{sender} sent a photo{suffix}"
    elif named_group:
        line = f"{sender} in {convo.title}"
    elif preview:
        line = sender
    else:
        return f"New message from {sender}"

    if not preview:
        return line

    text = (message.text or "").strip()
    if not text:
        # An uncaptioned photo, and the one case where a preview says exactly
        # what the contentless body would have. There is nothing to quote.
        return line
    if len(text) > PREVIEW_TEXT_LIMIT:
        text = text[:PREVIEW_TEXT_LIMIT].rstrip() + "…"
    return f"{line}: {text}"


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

    stale = PushOutbox.objects.filter(
        sent_at__isnull=True,
        message__conversation_id=convo_id,
        recipient_id__in=recipient_ids,
    )
    already_queued = set(stale.values_list("recipient_id", flat=True))
    if already_queued:
        # **Re-point the queued row at the message that just arrived.** Without
        # this, coalescing leaves the row aimed at the *first* message of the
        # burst, and everything the sender reads off it is then read off the
        # wrong message — which is a live bug, not merely an inefficiency:
        #
        # - The wording comes from that message, so an @mention arriving
        #   mid-burst is phrased as a plain message **and filed on the messages
        #   channel instead of the mentions one**, defeating the exact scenario
        #   the separate channel exists for. ``Kind.MENTION`` never creates a
        #   ``Notification`` row, so a mention always rides this path.
        # - ``_should_drop`` compares the read marker against that message's
        #   timestamp, so a burst whose first message was already read is binned
        #   entirely — including the later ones that weren't.
        # - With previews (Phase 10b) it would also show the oldest unread
        #   message rather than the newest, which is the wrong way round.
        #
        # Cheap and safe: the row is unsent by definition here, and the push it
        # will send is about the conversation either way. The one thing that
        # *doesn't* change is the count of buzzes — a burst still buzzes once,
        # which is the whole point of coalescing.
        stale.update(message=message)
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


def see_post_notifications(recipient, post):
    """Mark ``recipient``'s unread notifications about ``post`` — the post itself
    or any comment on it — as seen, because they've opened the post or its
    thread directly (issue #192's cousin: "I read the reply, why is the badge
    still counting it?").

    This is the content half of "resolve-elsewhere": the ``address_*`` helpers
    above stop the badge counting a request/invite dealt with on its own page,
    and this stops it counting a reply/reaction whose target you've gone and
    read without ever touching the bell or the push. Only **seen** is set — the
    row keeps its not-yet-addressed emphasis in the activity centre, exactly as
    if the bell had been opened, because seen is what the badge counts.

    Matched on the target FKs rather than on kinds: anything pointing at this
    post (or a comment on it) is news you have now, by definition, seen.
    """
    Notification.objects.filter(
        Q(post=post) | Q(comment__post=post),
        recipient=recipient,
        seen_at__isnull=True,
    ).update(seen_at=timezone.now())


def see_event_notifications(recipient, event):
    """Mark ``recipient``'s unread notifications about ``event`` — the event
    itself **or any comment on it** — as seen when they open it. The same
    viewing-is-seeing rule as ``see_post_notifications``, and now matched the
    same way: on the target FKs rather than on kinds, because anything pointing
    at this event is news you have by definition now seen.

    The ``comment__event`` half arrived with event comments. Without it, opening
    an event and reading the reply to your comment on it left the badge counting
    that reply — the exact complaint ``see_post_notifications`` exists to answer,
    reintroduced one target along. Two kinds reach here through a comment: an
    ``event_comment`` on your event and a ``comment_reply`` beneath you, plus a
    ``reaction`` on a comment of yours.
    """
    Notification.objects.filter(
        Q(event=event) | Q(comment__event=event),
        recipient=recipient,
        seen_at__isnull=True,
    ).update(seen_at=timezone.now())


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
