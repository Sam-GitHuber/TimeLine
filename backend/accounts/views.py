from dj_rest_auth.registration.views import RegisterView
from django.middleware.csrf import get_token
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


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
