"""The credential the iOS notification service extension authenticates with
(Phase 10b).

A message push carries no content — it says *"New message from Ada"* and
nothing more, because the body transits Expo's servers and Apple's or Google's.
The content is filled in **on the device**, by a notification service extension
that wakes when the push arrives, fetches the line over TLS from us, and
rewrites the notification before anyone sees it. See
docs/reference/notifications.md.

That extension is a **separate process**, and the interesting question is what
it authenticates as. Deliberately not the account's own tokens, for two
independent reasons:

- **Refreshing rotates.** ``ROTATE_REFRESH_TOKENS`` and
  ``BLACKLIST_AFTER_ROTATION`` are both on, so a second process refreshing would
  leave the app holding a refresh token that has been blacklisted — spurious
  logouts, in a race nothing could reproduce.
- **The access token is dead exactly when this matters.** Refresh is *lazy*: the
  only trigger anywhere in the app is a 401 on a real request. So a token that
  expired overnight stays expired until someone next opens the app — which is
  precisely the window in which a lock-screen preview is the whole point.

So the extension gets a credential of its own whose only power is
``GET /conversations/<id>/push-preview/``. Three properties follow, and each is
the reason for a choice below:

1. **It cannot rotate**, so the two-process hazard cannot arise by construction.
2. **It is revocable by a row delete.** It lives on ``DevicePushToken``, which
   logout already deletes — no blacklist, no second lifecycle to keep in sync.
3. **What a leak costs is smaller than the account, and worth stating
   precisely.** It is stored in a keychain group a second target can read, which
   is a wider blast radius than the app's own keychain, so the honest
   description matters more than the reassuring one.

   What it *cannot* do: post, read a thread's history, change a setting, see a
   profile, or refresh itself into anything else. It authenticates one GET.

   What it *can* do, and this is more than "one notification's preview":
   nothing binds a request to a push that was actually delivered, so a holder
   can ask for **any conversation the account is in**, at any time, and get the
   latest inbound line of each — a rate-limited read feed over the newest
   message of every private thread, for as long as the device row lives. That
   is bounded by the throttle and killed by logout, and it is still a real
   capability rather than a keyhole.

   Narrowing it to a delivered ``PushOutbox`` row, or to a nonce carried in the
   push payload, would make the power match the name. Not done here: it is a
   design change with its own failure mode (a preview that silently stops
   working when the outbox row is pruned or the timing slips) and it belongs
   with the extension in M3, where it can be tested end to end. Recorded as an
   open question on the phase rather than left as a comfortable docstring.

It is an **opaque random string, not a JWT**, for (2): a JWT would have to carry
its own revocation story, and the honest one at this scale is a database row.
"""

from rest_framework import authentication, exceptions

from .models import DevicePushToken

# The ``Authorization`` scheme. Deliberately not ``Bearer``: the account's JWTs
# use that, and one header value meaning two different kinds of credential is
# how a scoped one quietly gets accepted where a full-privilege one was meant —
# or, just as bad, the reverse.
KEYWORD = "Preview"


class PushPreviewAuthentication(authentication.BaseAuthentication):
    """Authenticate a device by its preview credential.

    Returns ``(user, device)``, so the view can read ``request.auth`` for the
    device that asked — which is what makes the per-device ``show_previews``
    check possible on a request the account itself never made.

    **Attach this to the preview endpoint and to nothing else.** It is the other
    half of "this credential's only power is one GET": scoping is a property of
    where the class is mounted, not of the token's contents.
    """

    keyword = KEYWORD

    def authenticate(self, request):
        header = authentication.get_authorization_header(request).split()
        if not header or header[0].lower() != self.keyword.lower().encode():
            # Not our scheme — hand back to the next authenticator (or to
            # anonymous) rather than failing. Returning None here is what lets an
            # ordinary 401 be produced by the permission layer instead of this
            # class claiming every unauthenticated request.
            return None
        if len(header) != 2:
            raise exceptions.AuthenticationFailed(
                "Invalid preview credential header."
            )

        try:
            raw = header[1].decode()
        except UnicodeError as exc:
            raise exceptions.AuthenticationFailed(
                "Invalid preview credential header."
            ) from exc

        # Refused *before* hashing, which is the only place this check can
        # actually fire. Hashing first and then testing the stored value would
        # read as a guard against an empty credential matching the empty
        # ``preview_token_hash`` a pre-10b device row carries — but
        # ``sha256("")`` is a 64-character digest that can never equal ``""``,
        # so such a test is unreachable and pins nothing. This one costs a
        # query too.
        if not raw:
            raise exceptions.AuthenticationFailed("Invalid preview credential.")

        # Looked up by hash, so the database never holds anything usable. An
        # exact-match index lookup rather than a comparison in Python: there is
        # no per-candidate work for a timing attack to measure, and the input is
        # 32 bytes of `secrets` output, so there is nothing to guess at anyway.
        device = (
            DevicePushToken.objects.filter(
                preview_token_hash=DevicePushToken.hash_preview_token(raw)
            )
            .select_related("user")
            .first()
        )
        if device is None:
            raise exceptions.AuthenticationFailed("Invalid preview credential.")
        if not device.user.is_active:
            # The admin-approval / ban gate, honoured here as everywhere else. A
            # deactivated account's phone must stop learning anything new, and
            # the device row can outlive the session that created it.
            raise exceptions.AuthenticationFailed("User inactive or deleted.")
        return (device.user, device)

    def authenticate_header(self, request):
        # Without this DRF returns 403 instead of 401 for an unauthenticated
        # request, and the extension's "no credential yet" path would read as a
        # permission problem rather than something a re-registration fixes.
        return self.keyword
