"""Put two conditional invariants in the database, after repairing any breaches (#209).

Both were "checked in the view, not the DB, because the rule is conditional" —
and conditional is exactly what a partial unique index is for:

* **One open ``ParticipantInterval`` per participant.** ``activate()`` read
  ``exists()`` and then inserted, so two promotion paths running at once could
  both open one. Visibility survived duplicates (``visible_messages_for`` ORs the
  spans) but ``attach_read_receipts`` keys a dict by participant and silently kept
  whichever row came last, computing read receipts from the wrong start.
* **One open ``Poll`` per built-in dimension per event.** The create and re-open
  views had the same read-then-write, and two live date polls on one event make
  the tally meaningless.

Repair before constraining, because ``AddConstraint`` fails outright on existing
breaches — and a migration that refuses to apply on the live box is worse than
the bug. The two repairs differ deliberately:

* A **duplicate open interval starts later than the one we keep and has no end,
  so its span is a subset** of the kept span. Deleting it removes no access at
  all, and leaves one row where the model now allows one. Keeping the *earliest*
  start is what makes that true, so that is the one that survives.
* A **duplicate open poll is deleted by nobody** — it may hold real votes. So the
  later ones are *closed* instead, which is what an organiser would have done by
  hand and is the state the index allows. The earliest-created poll stays open,
  since that is the one members have been voting in.

Neither is reversed: which row was the duplicate isn't recoverable afterwards,
and restoring it would only recreate a state the schema no longer permits.

Repair and ``AddConstraint`` share one transaction (Django wraps a migration on
Postgres), so the window where a repaired row sits in front of no index doesn't
exist. Each index is built with the ordinary ``ACCESS EXCLUSIVE`` lock rather
than ``CONCURRENTLY``: at this scale both tables are small enough that the lock
is measured in milliseconds, and the deploy restarts the app anyway.
"""

from django.conf import settings
from django.db import migrations, models


def close_duplicate_open_intervals(ParticipantInterval):
    """Delete all but the earliest open interval of each participant."""
    open_ivs = ParticipantInterval.objects.filter(ended_at__isnull=True)
    seen = set()
    doomed = []
    for pk, participant_id in open_ivs.order_by(
        "participant_id", "started_at", "id"
    ).values_list("id", "participant_id"):
        if participant_id in seen:
            doomed.append(pk)
        else:
            seen.add(participant_id)
    if doomed:
        ParticipantInterval.objects.filter(id__in=doomed).delete()


def close_duplicate_open_polls(Poll):
    """Close all but the earliest open poll of each (event, built-in dimension)."""
    open_polls = Poll.objects.filter(status="open").exclude(dimension="custom")
    seen = set()
    doomed = []
    for pk, event_id, dimension in open_polls.order_by(
        "event_id", "dimension", "created_at", "id"
    ).values_list("id", "event_id", "dimension"):
        key = (event_id, dimension)
        if key in seen:
            doomed.append(pk)
        else:
            seen.add(key)
    if doomed:
        Poll.objects.filter(id__in=doomed).update(status="closed")


def forwards(apps, schema_editor):
    close_duplicate_open_intervals(apps.get_model("api", "ParticipantInterval"))
    close_duplicate_open_polls(apps.get_model("api", "Poll"))


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0037_rejoin_left_direct_chats"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]
    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="participantinterval",
            constraint=models.UniqueConstraint(
                condition=models.Q(("ended_at__isnull", True)),
                fields=("participant",),
                name="one_open_interval_per_participant",
            ),
        ),
        migrations.AddConstraint(
            model_name="poll",
            constraint=models.UniqueConstraint(
                condition=models.Q(
                    ("status", "open"), models.Q(("dimension", "custom"), _negated=True)
                ),
                fields=("event", "dimension"),
                name="one_open_poll_per_event_dimension",
            ),
        ),
    ]
