"""Reactions on messages (Phase 9b M2) — widen ``Reaction`` rather than adding a
parallel model.

**Additive despite the ``RemoveConstraint``.** The old two-way check is dropped
and replaced with the three-way one, but every existing row has
``message = NULL`` and so already satisfies the replacement — no data is
rewritten and nothing can fail to migrate. The window between the two operations
is inside one transaction.
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0023_message_edited_at"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="reaction",
            name="reaction_targets_post_xor_comment",
        ),
        migrations.AddField(
            model_name="reaction",
            name="message",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="reactions",
                to="api.message",
            ),
        ),
        migrations.AddConstraint(
            model_name="reaction",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(
                        ("comment__isnull", True),
                        ("message__isnull", True),
                        ("post__isnull", False),
                    ),
                    models.Q(
                        ("comment__isnull", False),
                        ("message__isnull", True),
                        ("post__isnull", True),
                    ),
                    models.Q(
                        ("comment__isnull", True),
                        ("message__isnull", False),
                        ("post__isnull", True),
                    ),
                    _connector="OR",
                ),
                name="reaction_targets_exactly_one",
            ),
        ),
        migrations.AddConstraint(
            model_name="reaction",
            constraint=models.UniqueConstraint(
                condition=models.Q(("message__isnull", False)),
                fields=("user", "message", "emoji"),
                name="unique_user_message_emoji",
            ),
        ),
    ]
