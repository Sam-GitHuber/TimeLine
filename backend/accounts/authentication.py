"""Cookie authentication that doesn't lock you out when your user is gone.

DRF authenticates *before* it checks permissions, and a browser sends the
``timeline-auth`` cookie automatically on every request — including the login
POST. So if the cookie holds a validly-signed token whose ``user_id`` no longer
exists, simplejwt's ``get_user`` raises ``AuthenticationFailed("User not
found")`` and the request 401s before ``/api/auth/login/``'s ``AllowAny`` is
ever consulted. The person cannot log in, cannot sign up, cannot log into a
*different* account, and the error tells them nothing actionable. Only clearing
cookies by hand gets them out.

That is a real, reachable state: deleting your account on your phone while still
logged in on a laptop (Phase 7's delete-my-data flow), an admin hard-delete, a
database restore from a snapshot older than your account (docs/backup-restore.md),
or locally, any ``seed_demo`` run.

The fix: when the **cookie** path fails purely because the user has vanished,
return ``None`` (anonymous) instead of raising. Login then proceeds normally and
a successful login overwrites the stale cookie.

**This is not a weakening.** The token is validly signed, but its subject no
longer exists — there is no identity to assume. Anonymous is the accurate
reading, not a downgrade. Protected endpoints still refuse the request; they
just refuse it as "not logged in" rather than as a hard auth-layer failure.

Deliberately narrow:

- **Bearer tokens still 401.** A native client sends the header on purpose and
  handles 401 by re-authenticating — there's no automatic-resend trap to escape.
- **Every other failure still 401s.** Expired, tampered, wrong-signature, and
  in particular ``is_active=False`` (the admin-approval / ban gate) all raise as
  before. Only ``user_not_found`` is special-cased.

See docs/reference/accounts.md.
"""

from dj_rest_auth.jwt_auth import JWTCookieAuthentication
from rest_framework.exceptions import AuthenticationFailed


def _failure_code(exc):
    """The machine-readable code on an auth failure, whatever shape it takes.

    simplejwt's ``AuthenticationFailed`` subclasses DRF's but mixes in
    ``DetailDictMixin``, so ``exc.detail`` is a ``{"detail": ..., "code": ...}``
    dict rather than the ``ErrorDetail`` string DRF normally produces. **Every**
    exception that currently reaches here is a simplejwt one, so in practice only
    the dict branch runs; the ``ErrorDetail`` branch is an untested guard against
    a future simplejwt dropping the mixin, not covered behaviour.

    It's worth the extra line because the failure is silent: an unrecognised code
    re-raises, so a shape change restores the exact lockout this module exists to
    prevent, with a plausible-looking 401 and a green test suite.
    """
    detail = exc.detail
    if isinstance(detail, dict):
        return detail.get("code")
    return getattr(detail, "code", None)


class ResilientJWTCookieAuthentication(JWTCookieAuthentication):
    """Treats a cookie for a deleted user as anonymous rather than a 401."""

    def authenticate(self, request):
        try:
            return super().authenticate(request)
        except AuthenticationFailed as exc:
            # get_header() honours simplejwt's AUTH_HEADER_NAME setting and is
            # exactly what the parent used to decide header-vs-cookie, so this
            # can't drift from which path actually produced the token.
            if self.get_header(request) is not None:
                raise  # Bearer (mobile): a 401 is correct.
            if _failure_code(exc) != "user_not_found":
                raise  # expired / tampered / inactive: still a 401.
            return None  # Anonymous — login can now proceed.
