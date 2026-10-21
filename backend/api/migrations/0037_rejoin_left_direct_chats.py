"""Undo every 1:1 "leave" — they never left, and the server now says so (#210).

Until #210, ``POST /conversations/<id>/leave/`` accepted a direct thread and
tombstoned the leaver's ``Participant`` row (``left_at`` set, status dropped to
pending, interval closed). The thread nonetheless stayed listed and fully
readable — ``_viewer_participant_status`` falls back to the legacy
``user_a``/``user_b`` pair — so the only lasting effect was that **pushes for
that chat stopped for good**, because ``enqueue_message_pushes`` needs a live
active row. Both conversation lists offered that Leave on every row, so real
people did this.

The endpoint now refuses a 1:1, which stops new rows getting stuck but repairs
none of the old ones: the only thing that would is reopening the chat through
``POST /conversations/ {user_id}`` (``_ensure_direct_participants`` → ``activate``),
and opening it from the list doesn't go that way. So restore each such row to
what ``_ensure_direct_participants`` would give it: active, not left, with an open
interval from the conversation's start — the same full-history window the thread
already showed them through the fallback, so nothing they can see changes.

Only the leave endpoint ever tombstoned a direct row (removing someone from a
group only touches that group's chats), so every row this matches is one.

Not reversed: which rows were tombstoned is not recoverable afterwards, and
putting them back would only restore a state the server no longer allows.
"""

from django.db import migrations


def rejoin_left_direct_chats(Participant, ParticipantInterval):
    stuck = Participant.objects.filter(
        conversation__kind="direct", left_at__isnull=False
    ).select_related("conversation")
    for p in stuck.iterator():
        p.left_at = None
        p.status = "active"
        p.save(update_fields=["left_at", "status"])
        if not ParticipantInterval.objects.filter(
            participant=p, ended_at__isnull=True
        ).exists():
            ParticipantInterval.objects.create(
                participant=p, started_at=p.conversation.created_at
            )


def forwards(apps, schema_editor):
    rejoin_left_direct_chats(
        apps.get_model("api", "Participant"),
        apps.get_model("api", "ParticipantInterval"),
    )


class Migration(migrations.Migration):
    dependencies = [("api", "0036_event_reminders")]
    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
