"""Refresh tokens with per-client lifetimes (Phase 9).

The web app and the native app want opposite things from a refresh token:

- **Web:** short. A browser session lives on a shared or borrowed machine, and
  the site has no silent refresh anyway, so a long-lived refresh cookie is pure
  extra exposure for no benefit.
- **Mobile:** long. A phone app is expected to stay logged in indefinitely, and a
  logged-out app receives no push notifications — which would defeat Phase 9.

``SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"]`` is a single global, so honouring both
needs a second token class. ``MobileRefreshToken`` carries its own ``lifetime``
and stamps a ``client: "mobile"`` claim into the payload.

**Why the claim matters — this is the security-critical part.** Without it, the
mobile refresh endpoint would happily accept a *web* refresh token and rotate it
into a 90-day one: anyone who stole a 1-day browser cookie could upgrade it to
three months just by POSTing it to a different URL. The claim is what makes the
long lifetime unreachable from the short-lived path. ``MobileTokenRefreshSerializer``
rejects any token that isn't tagged, and rotation preserves the tag because it
mutates the decoded payload in place.

See docs/reference/accounts.md.
"""

from django.conf import settings
from rest_framework_simplejwt.exceptions import InvalidToken
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.tokens import RefreshToken

# The payload claim marking a token as issued to the native app.
CLIENT_CLAIM = "client"
MOBILE_CLIENT = "mobile"


class MobileRefreshToken(RefreshToken):
    """A refresh token for the native app: long-lived and tagged as mobile.

    ``lifetime`` is read at class-definition time from
    ``settings.MOBILE_REFRESH_TOKEN_LIFETIME`` — deliberately a separate setting
    from ``SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"]``, which stays short for the web.
    """

    lifetime = settings.MOBILE_REFRESH_TOKEN_LIFETIME

    @classmethod
    def for_user(cls, user):
        token = super().for_user(user)
        token[CLIENT_CLAIM] = MOBILE_CLIENT
        return token


class MobileTokenRefreshSerializer(TokenRefreshSerializer):
    """Rotates a mobile refresh token, refusing anything not issued as one.

    ``token_class`` decides the lifetime of the *rotated* token, so pointing it
    at ``MobileRefreshToken`` is what keeps the app logged in for 90 days rather
    than reverting it to the web's lifetime on first refresh.

    The claim check is the guard described in the module docstring: it stops a
    short-lived web refresh token being laundered into a long-lived mobile one.
    """

    token_class = MobileRefreshToken

    def validate(self, attrs):
        # Decode and verify before inspecting claims, so a forged or expired
        # token fails as a token first rather than as a wrong-client error
        # (which would otherwise leak that the signature checked out).
        token = self.token_class(attrs["refresh"])
        if token.get(CLIENT_CLAIM) != MOBILE_CLIENT:
            raise InvalidToken(
                "This refresh token was not issued to the mobile app."
            )
        return super().validate(attrs)
