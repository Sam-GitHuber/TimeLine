import logging

from allauth.account.models import EmailAddress
from dj_rest_auth.registration.views import RegisterView
from dj_rest_auth.views import LoginView, PasswordChangeView
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.middleware.csrf import get_token
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from .email import send_password_reset_code, send_verification_code
from .models import EmailVerificationCode, PasswordResetCode, generate_code

User = get_user_model()

logger = logging.getLogger(__name__)


def _deliver_code(user, code):
    """Email a verification ``code``, logging (never raising) on failure.

    Sign-up and resend must not hard-fail on a transient email hiccup: the
    account and code row already exist, and the person can use "resend". Swallowing
    here also keeps the resend endpoint's response *identical* whether or not the
    address is a real unverified member — a send error propagating would otherwise
    be an enumeration oracle (500 for a real account vs 200 for an unknown one).
    A logged error lets the maintainer notice a genuinely broken mail pipeline.
    """
    try:
        send_verification_code(user.email, code, user.display_name)
    except Exception:  # pragma: no cover - defensive; provider/network failure
        logger.exception("Failed to send verification code to user %s", user.pk)


def _deliver_reset_code(user, code):
    """Email a password-reset ``code``, logging (never raising) on failure.

    Same rationale as :func:`_deliver_code`: the reset-request endpoint must
    return an *identical* response whether or not the address is a real account,
    so a send error propagating (a 500 for a member vs a 200 for an unknown
    address) would be an enumeration oracle. A logged error still flags a broken
    mail pipeline to the maintainer.
    """
    try:
        send_password_reset_code(user.email, code, user.display_name)
    except Exception:  # pragma: no cover - defensive; provider/network failure
        logger.exception("Failed to send password reset code to user %s", user.pk)


class ThrottledLoginView(LoginView):
    """dj-rest-auth's login, rate-limited per IP (``login`` scope).

    Login is the classic online-guessing target: an attacker with (or guessing)
    a known email tries passwords until one works. Since the caller is anonymous
    here, ``ScopedRateThrottle`` keys the counter on the client IP, so a burst of
    attempts from one source is cut off with a 429 well before it can grind
    through a password list. Rate lives in ``DEFAULT_THROTTLE_RATES['login']``.
    """

    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "login"


class ThrottledPasswordChangeView(PasswordChangeView):
    """dj-rest-auth's password change, rate-limited per user (``password_change``).

    The endpoint requires the *current* password (``OLD_PASSWORD_FIELD_ENABLED``),
    so it's a small guessing oracle for anyone riding a hijacked session. The
    caller is authenticated, so the throttle counter is keyed on the user id —
    the limit is per account, not per IP.
    """

    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "password_change"


class InactiveRegisterView(RegisterView):
    """Sign-up that creates a *pending* account and does not log anyone in.

    The account is created inactive (in ``CustomRegisterSerializer``). Unlike
    dj-rest-auth's default register flow, we deliberately:
    - do **not** issue a JWT (``perform_create`` skips token creation), and
    - do **not** call allauth's ``complete_signup`` (which would try to log the
      new — inactive — user in).

    The email/password are stored (password hashed) and an allauth EmailAddress
    row is created by the serializer's ``setup_user_email``, so login works once
    the maintainer flips the account to active in the admin.
    """

    def perform_create(self, serializer):
        # is_active=False is set inside the serializer's save().
        user = serializer.save(self.request)
        # Email a verification code — but ONLY on a real creation. A duplicate
        # email is a silent no-op in the serializer (returns None) that must send
        # no mail, or the "does this email exist?" oracle the serializer closes
        # would reopen. See CustomRegisterSerializer.save and issue #73.
        if user is not None:
            code = EmailVerificationCode.issue(user)
            _deliver_code(user, code)
        return user

    def get_response_data(self, user):
        # Identical for the real and duplicate-email paths (enumeration
        # hardening): the body must not reveal whether an account was created.
        return {
            "detail": (
                "Almost there — we've emailed you a 6-digit code. Enter it to "
                "verify your email address, then your account will await the site "
                "owner's approval before you can log in."
            )
        }


class VerifyEmailCodeView(APIView):
    """Redeem a sign-up verification code: ``POST {email, code}``.

    On success flips allauth's ``EmailAddress.verified`` (the durable flag the
    login check reads) and consumes the code.

    **Enumeration-safe:** an unknown email, a missing code, a wrong code and an
    expired code all return the *same* generic 400, so this can't be used to probe
    which addresses are members. Login still needs admin approval too, so
    verifying alone doesn't grant access.
    """

    permission_classes = [AllowAny]
    # Per-IP throttle on top of the per-code 5-attempt budget: the attempt limit
    # only guards a single known code, so it does nothing against an attacker
    # hammering the endpoint across many emails. Keyed on IP (caller is anonymous),
    # same rationale as login. Rate in DEFAULT_THROTTLE_RATES['verify_email'].
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "verify_email"

    GENERIC_ERROR = {"detail": "That code is invalid or has expired."}

    def post(self, request):
        email = (request.data.get("email") or "").strip()
        code = (request.data.get("code") or "").strip()
        user = User.objects.filter(email__iexact=email).first()
        if user is None or not code:
            return Response(self.GENERIC_ERROR, status=status.HTTP_400_BAD_REQUEST)
        record = EmailVerificationCode.objects.filter(user=user).first()
        if record is None or not record.verify(code):
            return Response(self.GENERIC_ERROR, status=status.HTTP_400_BAD_REQUEST)
        # Correct: mark the address verified and burn the code so it can't be
        # replayed. (There's one EmailAddress per user in our email-only model.)
        EmailAddress.objects.filter(user=user).update(verified=True)
        record.delete()
        return Response(
            {
                "detail": (
                    "Your email address is verified. Your account is now awaiting "
                    "the site owner's approval before you can log in."
                )
            }
        )


class ResendVerificationView(APIView):
    """Re-send a verification code: ``POST {email}``.

    **Enumeration-safe:** always returns the *identical* 200, whatever the email.
    A code is only actually issued+sent when the address belongs to a real,
    not-yet-verified account (and not more often than the resend cooldown). Per-IP
    throttled (``resend_verification`` scope) on top, to blunt email-spamming.
    """

    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "resend_verification"

    GENERIC_OK = {
        "detail": "If that address still needs verifying, we've sent a new code."
    }

    def post(self, request):
        email = (request.data.get("email") or "").strip()
        user = User.objects.filter(email__iexact=email).first()
        if user is not None and not EmailAddress.objects.filter(
            user=user, verified=True
        ).exists():
            code = EmailVerificationCode.issue_if_due(user)
            if code is not None:
                _deliver_code(user, code)
        return Response(self.GENERIC_OK)


class PasswordResetRequestView(APIView):
    """Begin a forgotten-password reset: ``POST {email}`` (issue #38).

    **Enumeration-safe:** always returns the *identical* 200, whatever the email.
    A code is only actually issued+sent when the address belongs to a real account
    (and not more often than the reset cooldown). Per-IP throttled
    (``password_reset`` scope) on top, to blunt inbox-spamming / probing — same
    shape as the resend-verification endpoint.

    **Timing is equalised too, not just the response body.** Issuing a code runs a
    PBKDF2 hash (``EmailCode.issue``); the branches that *don't* issue one (an
    unknown address, or a real account still inside its resend cooldown) would
    otherwise return hundreds of milliseconds sooner and hand an attacker a
    reliable "is this address a member?" oracle from response latency alone. So
    every branch spends exactly one throwaway hash — the same guard the duplicate-
    email sign-up path uses. (A residual remains: a real account's *first* request
    in a cooldown window also sends an email; that send cost isn't equalised, the
    same accepted trade-off the sign-up path makes, and the 60-sec cooldown means
    repeat probes of a real address fall into the fast, no-send bucket anyway.)

    A pending, unapproved (``is_active=False``) account can still request a reset:
    the code just proves inbox control; it doesn't bypass the admin-approval gate,
    so there's no reason to special-case it (and doing so would add enumeration
    surface). Accounts created out of band (the maintainer's ``createsuperuser``)
    have a usable password and reset like any other.
    """

    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "password_reset"

    GENERIC_OK = {
        "detail": "If that email belongs to an account, we've sent a reset code."
    }

    def post(self, request):
        email = (request.data.get("email") or "").strip()
        user = User.objects.filter(email__iexact=email).first()
        issued = None
        if user is not None:
            issued = PasswordResetCode.issue_if_due(user)
            if issued is not None:
                _deliver_reset_code(user, issued)
        if issued is None:
            # No code was issued (unknown address, or within the resend cooldown),
            # so no PBKDF2 hash was spent above. Spend an equivalent throwaway one
            # here so the response time can't distinguish a member from a stranger.
            make_password(generate_code())
        return Response(self.GENERIC_OK)


class PasswordResetConfirmView(APIView):
    """Complete a reset: ``POST {email, code, new_password1, new_password2}``.

    On a valid code we set the new password (run through Django's password
    validators, same as sign-up / change), consume the code, and — since receiving
    the emailed code proves the person controls the inbox — mark the address
    verified if it wasn't. That last step means someone who never finished
    verification but forgot their password isn't left stuck behind the verify gate
    after a successful reset (admin approval, ``is_active``, still applies).

    **Enumeration-safe on the code check:** an unknown email, a missing/wrong/
    expired code all return the *same* generic 400, so this can't probe who's a
    member. Password-strength / mismatch errors are only reachable *after* a valid
    code is held — which an attacker targeting a non-member's address can't
    obtain — so returning those specific messages leaks nothing. Those errors also
    deliberately **don't** consume the code, so a real user who fat-fingers a weak
    password can fix it and resubmit with the same still-valid code.

    Per-IP throttled (``password_reset_confirm``) on top of the per-code 5-attempt
    budget, which only guards a single known code (nothing against an attacker
    hammering across many emails). This is the account-takeover surface, so it
    carries the same layered guards as login / verify.
    """

    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "password_reset_confirm"

    GENERIC_ERROR = {"detail": "That code is invalid or has expired."}

    def post(self, request):
        email = (request.data.get("email") or "").strip()
        code = (request.data.get("code") or "").strip()
        new_password1 = request.data.get("new_password1") or ""
        new_password2 = request.data.get("new_password2") or ""

        user = User.objects.filter(email__iexact=email).first()
        if user is None or not code:
            return Response(self.GENERIC_ERROR, status=status.HTTP_400_BAD_REQUEST)
        record = PasswordResetCode.objects.filter(user=user).first()
        if record is None or not record.verify(code):
            return Response(self.GENERIC_ERROR, status=status.HTTP_400_BAD_REQUEST)

        # The code is valid — the caller has proven inbox control. Only now do we
        # check the new password, and we leave the code intact on these errors so
        # the person can correct it and resubmit (see the docstring).
        if new_password1 != new_password2:
            return Response(
                {"new_password2": ["The two password fields didn't match."]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            validate_password(new_password1, user=user)
        except DjangoValidationError as exc:
            return Response(
                {"new_password1": list(exc.messages)},
                status=status.HTTP_400_BAD_REQUEST,
            )

        user.set_password(new_password1)
        user.save(update_fields=["password"])
        # Burn the code so it can't be replayed, and clear any unverified gate
        # (receiving the code proved control of the address).
        record.delete()
        EmailAddress.objects.filter(user=user).update(verified=True)
        return Response(
            {"detail": "Your password has been reset. You can now log in."}
        )


@api_view(["GET"])
@permission_classes([AllowAny])
def csrf(request):
    """Prime the CSRF cookie.

    The SPA calls this once on load. ``get_token`` makes Django's CSRF
    middleware set the (non-httpOnly) ``csrftoken`` cookie on the response, which
    the frontend then echoes back in the ``X-CSRFToken`` header on mutating
    requests — required because our JWT lives in an httpOnly cookie
    (``JWT_AUTH_COOKIE_USE_CSRF``).
    """
    get_token(request)
    return Response({"detail": "CSRF cookie set"})
