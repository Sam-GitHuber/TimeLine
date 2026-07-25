"""Message push notifications (issue #118).

Two changes, one feature:

- ``Participant.muted_at`` — a per-person mute for a conversation's pushes.
- ``PushOutbox`` learns a second target: a ``Message`` instead of a
  ``Notification``, so a message can buzz a phone without creating an
  activity-centre row (messaging keeps its own unread badge).

``recipient`` is added in the usual three steps — nullable, backfilled from the
notification each existing row already points at, then made non-null — because
adding a non-null FK to a table with rows in it is otherwise impossible.
"""

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def backfill_recipient(apps, schema_editor):
    """Every pre-existing outbox row is a notification row, so its recipient is
    the notification's. Done with an UPDATE ... FROM rather than a Python loop:
    the queue is small but this runs inside the deploy's migrate step, and there
    is no reason to make it row-by-row."""
    PushOutbox = apps.get_model("api", "PushOutbox")
    Notification = apps.get_model("api", "Notification")
    PushOutbox.objects.filter(recipient__isnull=True).update(
        recipient_id=models.Subquery(
            Notification.objects.filter(
                pk=models.OuterRef("notification_id")
            ).values("recipient_id")[:1]
        )
    )


def drop_recipient(apps, schema_editor):
    """Reverse of the backfill: nothing to undo — the column goes away with the
    RemoveField that the AddField reverses into. Present so the migration is
    reversible rather than one-way."""


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0020_pushreceipt"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="participant",
            name="muted_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="pushoutbox",
            name="notification",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="push",
                to="api.notification",
            ),
        ),
        migrations.AddField(
            model_name="pushoutbox",
            name="message",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="pushes",
                to="api.message",
            ),
        ),
        # --- recipient, in three steps ---
        migrations.AddField(
            model_name="pushoutbox",
            name="recipient",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="queued_pushes",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.RunPython(backfill_recipient, drop_recipient),
        migrations.AlterField(
            model_name="pushoutbox",
            name="recipient",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="queued_pushes",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        # --- guardrails, added last so the backfill isn't fighting them ---
        migrations.AddConstraint(
            model_name="pushoutbox",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(("message__isnull", True), ("notification__isnull", False)),
                    models.Q(("message__isnull", False), ("notification__isnull", True)),
                    _connector="OR",
                ),
                name="push_outbox_exactly_one_target",
            ),
        ),
        migrations.AddConstraint(
            model_name="pushoutbox",
            constraint=models.UniqueConstraint(
                fields=("message", "recipient"),
                name="unique_message_push_per_recipient",
            ),
        ),
        migrations.AddIndex(
            model_name="pushoutbox",
            index=models.Index(
                fields=["recipient", "sent_at"], name="api_pushout_recipie_9b864d_idx"
            ),
        ),
    ]
