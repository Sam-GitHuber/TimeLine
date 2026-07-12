from dj_rest_auth.registration.views import RegisterView
from dj_rest_auth.views import LoginView, PasswordChangeView
from django.middleware.csrf import get_token
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle


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
        return serializer.save(self.request)

    def get_response_data(self, user):
        return {
            "detail": (
                "Account created and pending approval. You'll be able to log in "
                "once the site owner approves your account."
            )
        }


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
