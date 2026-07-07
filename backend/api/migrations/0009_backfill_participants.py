from django.db import migrations

from api.migrations._backfill import backfill


def forwards(apps, schema_editor):
    backfill(
        apps.get_model("api", "Conversation"),
        apps.get_model("api", "Participant"),
        apps.get_model("api", "ParticipantInterval"),
    )


def backwards(apps, schema_editor):
    apps.get_model("api", "Participant").objects.all().delete()


class Migration(migrations.Migration):
    dependencies = [("api", "0008_group_messaging")]
    operations = [migrations.RunPython(forwards, backwards)]
