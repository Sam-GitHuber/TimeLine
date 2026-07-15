"""Outbound account emails.

Kept apart from views/serializers so the send path is reusable (the sign-up hook,
the resend endpoint, and the ``send_test_verification`` management command all
call the same function) and easy to test.

Delivery rides Django's configured email backend (SMTP/Resend in production, the
console backend in dev) — see the Email section of ``config/settings.py`` and
docs/deploy.md. Nothing here knows about the provider.
"""

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string

from .models import EmailVerificationCode, PasswordResetCode


def send_verification_code(email, code, display_name=None):
    """Email a sign-up verification ``code`` to ``email``.

    ``display_name`` personalises the greeting when we have it (the sign-up /
    resend paths pass the user's name; the standalone smoke-test command doesn't).
    Sends a multipart message: a plain-text part (always) plus a branded HTML
    alternative, so it renders well everywhere and degrades gracefully.
    """
    context = {
        "code": code,
        "display_name": display_name,
        "expiry_minutes": int(EmailVerificationCode.EXPIRY.total_seconds() // 60),
    }
    # Subject lives in a template too so the wording is in one place; strip the
    # trailing newline render_to_string leaves (a subject can't contain newlines).
    subject = render_to_string(
        "accounts/email/verification_code_subject.txt", context
    ).strip()
    text_body = render_to_string("accounts/email/verification_code.txt", context)
    html_body = render_to_string("accounts/email/verification_code.html", context)

    message = EmailMultiAlternatives(
        subject=subject,
        body=text_body,
        from_email=settings.DEFAULT_FROM_EMAIL,
        to=[email],
    )
    message.attach_alternative(html_body, "text/html")
    message.send()


def send_password_reset_code(email, code, display_name=None):
    """Email a forgotten-password reset ``code`` to ``email``.

    Mirrors :func:`send_verification_code` (a plain-text part plus a branded HTML
    alternative); only the wording and expiry source differ. ``display_name``
    personalises the greeting when the caller has it.
    """
    context = {
        "code": code,
        "display_name": display_name,
        "expiry_minutes": int(PasswordResetCode.EXPIRY.total_seconds() // 60),
    }
    subject = render_to_string(
        "accounts/email/password_reset_code_subject.txt", context
    ).strip()
    text_body = render_to_string("accounts/email/password_reset_code.txt", context)
    html_body = render_to_string("accounts/email/password_reset_code.html", context)

    message = EmailMultiAlternatives(
        subject=subject,
        body=text_body,
        from_email=settings.DEFAULT_FROM_EMAIL,
        to=[email],
    )
    message.attach_alternative(html_body, "text/html")
    message.send()
