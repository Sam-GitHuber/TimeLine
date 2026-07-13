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
"""

from django.db.models import Q
from django.utils import timezone

from .models import Connection, Notification, NotificationPreference

# The content kinds whose actor must be visible to (connected with) the recipient
# before we notify — so a not-connected replier/reactor on a group post never
# surfaces second-hand, exactly as the pruned comment/reaction views hide them.
_CONNECTION_GATED_KINDS = frozenset(
    {
        Notification.Kind.POST_REPLY,
        Notification.Kind.COMMENT_REPLY,
        Notification.Kind.REACTION,
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


def create_notification(recipient, actor, kind, *, post=None, comment=None,
                        group=None, connection=None):
    """Create (and return) a notification, or return ``None`` if it's suppressed.

    Suppressed when: the recipient is the actor (no self-notifications); the
    recipient has muted this (mutable) kind; or it's a connection-gated content
    kind and the actor isn't someone the recipient may see. For the ``reaction``
    kind an existing *unread* notification for the same (recipient, actor, target)
    is refreshed instead of stacking a duplicate — a react/un-react/re-react (or
    a second emoji on the same post) bumps one row to the top rather than filling
    the centre with near-identical lines.
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

    if kind == Notification.Kind.REACTION:
        existing = Notification.objects.filter(
            recipient=recipient,
            actor=actor,
            kind=kind,
            post=post,
            comment=comment,
            seen_at__isnull=True,
        ).first()
        if existing is not None:
            # auto_now_add only sets created_at on insert; assigning it on an
            # update is honoured, so this bumps the row to the top of the list.
            existing.created_at = timezone.now()
            existing.save(update_fields=["created_at"])
            return existing

    return Notification.objects.create(
        recipient=recipient,
        actor=actor,
        kind=kind,
        post=post,
        comment=comment,
        group=group,
        connection=connection,
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
