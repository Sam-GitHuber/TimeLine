"""Grandfather already-approved members past the new email-verification gate.

Issue #73 makes a verified email a login requirement. But sign-up already created
an allauth ``EmailAddress`` (``verified=False``) for every existing member, so
without this the change would lock out the current, already-approved friends and
family the moment it deploys.

They've already cleared the *human* gate (the maintainer approved them), which is
the stronger check — so we mark the addresses of all currently-active accounts as
verified. Accounts still pending approval (``is_active=False``) are left
unverified: if one is approved later it'll go through verification, self-serving a
fresh code via the resend endpoint. The maintainer's ``createsuperuser`` account
has no ``EmailAddress`` row at all and is unaffected (and exempt by the login
check).
"""

from django.db import migrations


def verify_active_members(apps, schema_editor):
    EmailAddress = apps.get_model("account", "EmailAddress")
    EmailAddress.objects.filter(user__is_active=True).update(verified=True)


def noop_reverse(apps, schema_editor):
    # Irreversible in practice (we can't tell which rows we flipped), but a no-op
    # reverse lets the migration be unapplied without error.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0004_emailverificationcode"),
        # We touch allauth's EmailAddress table, so its schema must exist first.
        ("account", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(verify_active_members, noop_reverse),
    ]
