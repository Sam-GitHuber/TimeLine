"""Phase 3a: rework the one-way Follow into a symmetric Connection, and add
threaded Comments.

Hand-written (not ``makemigrations``) because the model/field renames need to be
sequenced around a data step: the new "one row per unordered pair" unique
constraint would reject any A→B + B→A duplicate that exists today, so we dedupe
before adding it. Converting keeps existing (test) data rather than wiping it.
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.db.models.functions import Greatest, Least


def dedupe_connection_pairs(apps, schema_editor):
    """Collapse any pair that exists in both directions to a single row.

    Under the old one-way model you could have both A→B and B→A. A connection is
    symmetric, so those are the *same* relationship and the new unique
    constraint forbids the second row. We keep one row per unordered pair,
    preferring an ``accepted`` row over a ``pending`` one (an already-mutual
    connection outranks a still-pending request). Runs on real data only — a
    fresh test database has no rows, so this is a no-op there.
    """
    Connection = apps.get_model("api", "Connection")
    seen = set()
    to_delete = []
    # "accepted" sorts before "pending" alphabetically, so ascending status
    # order visits accepted rows first — those become the kept row for a pair.
    for row in Connection.objects.order_by("status", "id"):
        pair = frozenset((row.requester_id, row.requestee_id))
        if pair in seen:
            to_delete.append(row.id)
        else:
            seen.add(pair)
    Connection.objects.filter(id__in=to_delete).delete()


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("api", "0003_alter_post_options"),
    ]

    operations = [
        # 1. Drop the old constraints first, while the fields are still named
        #    follower/followee, so nothing references soon-to-be-renamed fields.
        migrations.RemoveConstraint(model_name="follow", name="unique_follow"),
        migrations.RemoveConstraint(model_name="follow", name="no_self_follow"),
        # 2. Rename the fields, then the model (table api_follow → api_connection).
        migrations.RenameField(
            model_name="follow", old_name="follower", new_name="requester"
        ),
        migrations.RenameField(
            model_name="follow", old_name="followee", new_name="requestee"
        ),
        migrations.RenameModel(old_name="Follow", new_name="Connection"),
        # 3. Update the reverse accessors to match the new model.
        migrations.AlterField(
            model_name="connection",
            name="requester",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="connections_requested",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="connection",
            name="requestee",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="connections_received",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        # 4. Dedupe reverse-direction pairs BEFORE adding the unique constraint.
        migrations.RunPython(
            dedupe_connection_pairs, migrations.RunPython.noop
        ),
        # 5. Add the symmetric guardrails: one row per unordered pair, no self.
        migrations.AddConstraint(
            model_name="connection",
            constraint=models.UniqueConstraint(
                Least("requester_id", "requestee_id"),
                Greatest("requester_id", "requestee_id"),
                name="unique_connection_pair",
            ),
        ),
        migrations.AddConstraint(
            model_name="connection",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("requester", models.F("requestee")), _negated=True
                ),
                name="no_self_connection",
            ),
        ),
        # 6. The new threaded comment tree.
        migrations.CreateModel(
            name="Comment",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("text", models.TextField()),
                (
                    "created_at",
                    models.DateTimeField(auto_now_add=True, db_index=True),
                ),
                (
                    "author",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="comments",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "parent",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="replies",
                        to="api.comment",
                    ),
                ),
                (
                    "post",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="comments",
                        to="api.post",
                    ),
                ),
            ],
            options={
                "ordering": ["created_at", "id"],
            },
        ),
    ]
