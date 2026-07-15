"""Interactive email-delivery smoke test.

    python manage.py send_test_verification you@example.com

Sends a real 6-digit verification code to the given address through whatever
email backend is configured, then waits for you to type the code back and tells
you whether it matched. Handy to run over SSH on the server to confirm outbound
mail (Resend/SMTP + SPF/DKIM) actually reaches an inbox and renders.

It exercises the exact code generator and email templates the sign-up flow uses,
but is otherwise self-contained: it does **not** create or modify any account or
verification record, so it's safe to run against production.
"""

import hmac

from django.core.management.base import BaseCommand, CommandError

from accounts.email import send_verification_code
from accounts.models import EmailVerificationCode, generate_code


class Command(BaseCommand):
    help = (
        "Send a test verification code to an email address and check it "
        "interactively (outbound-email smoke test). Touches no accounts."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "email",
            nargs="?",
            help="Address to send the test code to (prompted if omitted).",
        )

    def handle(self, *args, **options):
        email = options.get("email") or input("Email to send a test code to: ").strip()
        if not email:
            raise CommandError("No email address given.")

        code = generate_code(EmailVerificationCode.CODE_LENGTH)
        try:
            send_verification_code(email, code)
        except Exception as exc:  # surface the real delivery error clearly
            raise CommandError(f"Sending failed: {exc}") from exc

        self.stdout.write(
            self.style.SUCCESS(
                f"Sent a {EmailVerificationCode.CODE_LENGTH}-digit code to {email}. "
                "Check the inbox (and the logs, if using the console backend)."
            )
        )

        entered = input("Enter the code you received: ").strip()
        # Constant-time compare — matches how a real credential check should work,
        # even though it's only a local smoke test.
        if hmac.compare_digest(entered, code):
            self.stdout.write(
                self.style.SUCCESS(
                    "✓ Correct — outbound email and the code round-trip both work."
                )
            )
        else:
            self.stdout.write(
                self.style.ERROR(
                    f"✗ That didn't match. Expected {code}, you entered "
                    f"{entered or '(nothing)'}."
                )
            )
