"""Create (or reset) the isolated App Review demo account for TestFlight.

External TestFlight — and any future App Store review — needs a working login for
Apple's reviewer, because the app is login-only and sign-ups are admin-approved,
so a reviewer *cannot* self-register. This command makes one stable review
account that:

- **logs straight in** — ``is_active=True`` plus a password, and (deliberately)
  no allauth ``EmailAddress`` row, so it skips the verified-email gate exactly the
  way ``seed_demo``'s accounts do. The login serializer only blocks an *unverified*
  address when a row exists; out-of-band accounts have none (see
  ``accounts/serializers.py`` ``CustomLoginSerializer``).
- **is walled off from real data** — it is connected only to one dedicated demo
  companion (a ``review-buddy@example.com`` account this command also creates),
  never to real friends/family, so the reviewer never sees anyone's real private
  posts. This matters: the reviewer logs in as a *real* user of the app, so an
  account wired into the real graph would expose family data to Apple.
- **exercises the App-Review-critical safety features** — the companion is
  connected and has a post, so the reviewer can reach **Report** (the post's ⋯
  menu) and **Block** (the companion's profile), which App Review checks for on
  any social app.

**Prod-safe and idempotent.** It touches only the two fixed sentinel emails below
— deleting and recreating just those rows on each run — so it never wipes real
data, and re-running is a clean reset *and* a password rotation. This is the key
difference from ``seed_demo`` (which rebuilds a whole demo world and must never
run on prod): this command is *designed* to run on the live box.

Usage (on the server, from the repo root):

    docker compose exec backend python manage.py create_review_account
    # or choose the password yourself:
    docker compose exec backend python manage.py create_review_account --password 'S0me-Strong-Pass'

It prints the email + password to paste into App Store Connect → your app →
TestFlight → Test Information → "Sign-in required".
"""

import secrets

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

from api.models import Connection, Post

User = get_user_model()

# Fixed sentinel accounts this command owns. Only these two rows are ever
# touched, which is what makes re-running safe on the live box.
REVIEW_EMAIL = "appreview@your-timeline.net"
BUDDY_EMAIL = "review-buddy@example.com"


class Command(BaseCommand):
    help = "Create/reset the isolated App Review demo account for TestFlight."

    def add_arguments(self, parser):
        parser.add_argument(
            "--password",
            default=None,
            help="Password for the review account (a strong one is generated "
                 "if omitted).",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        password = options["password"] or secrets.token_urlsafe(12)

        # Idempotent reset: drop only these two dedicated rows (cascading their
        # posts/connections), then recreate. No other account is touched.
        User.objects.filter(email__in=[REVIEW_EMAIL, BUDDY_EMAIL]).delete()

        review = User(
            email=REVIEW_EMAIL,
            first_name="App",
            last_name="Review",
            bio="Demo account for reviewing TimeLine.",
            is_active=True,
        )
        review.set_password(password)
        review.save()

        # The companion exists only to be a Report/Block target and a feed
        # author. It never needs to log in, so it gets no usable password.
        buddy = User(
            email=BUDDY_EMAIL,
            first_name="Demo",
            last_name="Buddy",
            bio="A demo connection so reviewers can try Report and Block.",
            is_active=True,
        )
        buddy.set_unusable_password()
        buddy.save()

        # Symmetric accepted connection so the buddy's post shows in the review
        # account's feed and its profile is reachable.
        Connection.objects.create(
            requester=buddy,
            requestee=review,
            status=Connection.Status.ACCEPTED,
        )

        Post.objects.create(
            author=buddy,
            text=(
                "Welcome to TimeLine! This is a demo post so you can try "
                "reactions, comments, and the Report action in the post's ⋯ menu."
            ),
        )
        Post.objects.create(
            author=review,
            text=(
                "Reviewer test account — post something, edit your profile, open "
                "Settings, and visit Demo Buddy's profile to try Block."
            ),
        )

        self.stdout.write(self.style.SUCCESS(
            "\nApp Review account ready (isolated from real data):\n"
            f"  email:    {REVIEW_EMAIL}\n"
            f"  password: {password}\n\n"
            "Paste these into App Store Connect → your app → TestFlight → Test "
            "Information → 'Sign-in required'.\n"
        ))
