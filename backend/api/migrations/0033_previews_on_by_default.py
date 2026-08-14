"""Message previews default on, and every device already registered follows.

Phase 10b, revised 2026-08-14 after the first build reached a real handset.

The field shipped as ``default=False`` on the reasoning that quietly rendering
people's messages on their lock screens isn't ours to do on their behalf. That
turned out to be **answered by iOS rather than by us**: *Settings →
Notifications → Show Previews* defaults to *When Unlocked* on any Face ID
iPhone, so the OS already withholds a notification's content until its owner is
looking at the phone. We supply the words; Apple decides when it is safe to
reveal them. WhatsApp and Signal both default this on for the same reason.

**Why existing rows are flipped too, rather than left where they are.** A
`default=` only governs rows created *afterwards*, so without the data migration
below the setting would mean different things depending on when a phone happened
to first register — and nobody, including the person holding it, could tell
which. Registration doesn't correct it either: re-registering your own device
deliberately preserves your choice, so an old row would keep its `False`
forever, indistinguishable from a deliberate opt-out.

Safe to do here because the feature has never been released: the only rows are
the maintainer's own internal-testing devices, and no build in anyone else's
hands can act on the flag. **This is not a precedent** — flipping a privacy
default under people who have made a choice is a different act, and would need
telling them rather than a migration.

Reversible in both directions, so a rollback restores the old default. The
reverse deliberately does *not* set every row back to `False`: by then a choice
someone made would be indistinguishable from a value this migration wrote.
"""

from django.db import migrations, models


def previews_on(apps, schema_editor):
    DevicePushToken = apps.get_model("api", "DevicePushToken")
    DevicePushToken.objects.filter(show_previews=False).update(show_previews=True)


def noop(apps, schema_editor):
    """Nothing to undo. See the module docstring."""


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0032_devicepushtoken_preview_token_hash_and_more"),
    ]

    operations = [
        migrations.AlterField(
            model_name="devicepushtoken",
            name="show_previews",
            field=models.BooleanField(default=True),
        ),
        migrations.RunPython(previews_on, noop),
    ]
