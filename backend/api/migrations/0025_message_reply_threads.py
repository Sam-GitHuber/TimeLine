"""Reply threads on messages (Phase 9b M3) — two nullable self-FKs on ``Message``.

Fully additive: both columns are ``NULL`` on every existing row, which is the
correct value for them (a message sent before this migration answers nothing and
belongs to no thread). Nothing is rewritten and nothing can fail to migrate.

``reply_to`` is the message answered; ``thread_root`` is the head of the thread,
denormalised in ``Message.save`` so a reply-to-a-reply joins the existing thread
rather than nesting. Both are ``SET_NULL`` — hard-deleting a quoted message must
orphan its replies, never take them with it.
"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0024_message_reactions"),
    ]

    operations = [
        migrations.AddField(
            model_name="message",
            name="reply_to",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="replies",
                to="api.message",
            ),
        ),
        migrations.AddField(
            model_name="message",
            name="thread_root",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="thread_messages",
                to="api.message",
            ),
        ),
    ]
