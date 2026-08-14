# Accounts, identity & auth

How people sign up, log in, and are represented; the security posture around
credentials; and the account-lifecycle features (password change, account
deletion, reporting/moderation). This is the current-state reference — for the
blow-by-blow of when each piece landed, see the git history.

Code: `backend/accounts/` (custom user model, serializers, admin), auth wiring in
`backend/config/settings.py`, account-lifecycle + reporting views in
`backend/api/views.py`.

## Identity model — no username, ever

- **Login is by email.** There is no username field anywhere, by deliberate
  decision (confirmed 2026-07-04). A person's display name **is** their real
  first + last name. Forcing a made-up handle adds friction for no benefit in an
  app for connecting with people you already know.
- **Custom user model from day one.** `accounts.User(AbstractUser)` with
  `AUTH_USER_MODEL = "accounts.User"`, `USERNAME_FIELD = "email"` (unique). Django
  itself recommends setting a custom user model at project start even if identical
  to the default — retrofitting one after real accounts exist means painful data
  migrations. It's also the natural home for profile fields (bio, avatar — added
  in [feed-and-posts](feed-and-posts.md)).
- **`User.display_name`** is a property, the single source of truth every
  serializer uses: `"First Last"` when set, else the **email local-part** (before
  the `@`) — never the full address, so members never see each other's emails in
  the feed or people list.
- **Real name is required at sign-up** (first + last), so every account has a real
  display name from day one; the email-local-part fallback almost never applies in
  practice.
- **Profile URLs are numeric** (`/u/:id`). Name-based slugs were considered and
  deliberately deferred — they're real extra surface (unique field, generation,
  collision handling, reserved-word validation) not needed to ship the product.

## Auth stack

Do **not** hand-roll password hashing, sessions, or tokens — this rides
well-trodden libraries:

- **`dj-rest-auth`** (+ `django-allauth` for registration, +
  `djangorestframework-simplejwt` for JWT) provides register / login / logout /
  "who am I" (`/api/auth/...`).
- **JWT delivered in an httpOnly cookie**, so page JavaScript can't read the token
  — an XSS bug then can't steal a login. The login response body *also* contains
  the access token (stock dj-rest-auth behaviour), but the frontend never reads or
  stores it; the httpOnly cookie is what we rely on.
- Passwords are hashed by Django (never stored plaintext).
- DRF default authentication = the cookie-JWT class; default permission =
  `IsAuthenticated` (specific endpoints opt out with `AllowAny`).
- **Access-token lifetime is 1 day** (`SIMPLE_JWT`) because the *web* app has no
  silent refresh — a 5-minute default would log people out constantly. The mobile
  client does refresh silently, but this setting is shared, so it stays at a day
  (see "Mobile auth" below).
- **allauth ≥65 settings API:** `ACCOUNT_LOGIN_METHODS = {"email"}`,
  `ACCOUNT_SIGNUP_FIELDS = [...]`, and `ACCOUNT_USER_MODEL_USERNAME_FIELD = None`
  (stops allauth trying to set a username). Custom serializers in
  `accounts/serializers.py` drop the `username` field dj-rest-auth's defaults
  assume, and `CustomRegisterSerializer.save()` is where `is_active=False` and the
  ToS consent stamp are set.

### A cookie for a deleted user is anonymous, not a 401

The configured auth class is `accounts.authentication.ResilientJWTCookieAuthentication`
— dj-rest-auth's `JWTCookieAuthentication` with one behaviour changed.

DRF authenticates *before* it consults permissions, and a browser resends the
`timeline-auth` cookie on **every** request, login included. So a validly-signed
token whose `user_id` no longer has a row used to 401 the login POST itself:
the person couldn't log in, sign up, or log into a *different* account, and the
error ("User not found") suggested nothing actionable. It went further than
login — even `/api/auth/csrf/`, the `AllowAny` primer the SPA calls on load,
401'd, so the app couldn't obtain a CSRF token to *attempt* a login with. The
only escape was clearing cookies by hand. That state is genuinely reachable — deleting your
account on your phone while still logged in on a laptop, an admin hard-delete, a
restore from a snapshot older than your account ([backup-restore](../backup-restore.md)),
or locally, any `seed_demo` run.

So when the **cookie** path fails *only* because the user has vanished, the class
returns `None` (anonymous) instead of raising. Login then proceeds and its fresh
cookie overwrites the stale one.

This isn't a weakening: the token is validly signed but its subject no longer
exists, so there is no identity to assume — anonymous is the accurate reading.
Protected endpoints still refuse the request, just as "not logged in".

Deliberately narrow — everything else still 401s:

- **Bearer tokens.** A native client sends the header on purpose and re-auths on
  401; there's no automatic-resend trap to escape.
- **`is_active=False`.** That's the admin-approval / ban gate doing its job.
- Expired, tampered, or wrong-signature tokens.

One trap for future edits: simplejwt's `AuthenticationFailed` subclasses DRF's
but mixes in `DetailDictMixin`, so `exc.detail` is a `{"detail": ..., "code": ...}`
**dict**, not the `ErrorDetail` string DRF normally produces. Reading the code
off the wrong shape fails closed (a 401), which silently restores the lockout
behind a plausible-looking error — so `_failure_code()` tolerates both shapes.
Only the dict branch actually runs today; the other is an unreached guard
against a future simplejwt dropping the mixin.

Issue #93.

## Mobile auth (Bearer tokens) — Phase 9

The native app authenticates with `Authorization: Bearer <access-token>` instead
of the cookie. Both clients hit the **same backend and the same API endpoints**;
only the login/refresh/logout handshake differs.

### Why separate endpoints exist

`JWT_AUTH_HTTPONLY` is on, which is what stops page JavaScript reading the web
app's tokens. dj-rest-auth implements it by **blanking the refresh token out of
the login response body** (`data['refresh'] = ""` in `dj_rest_auth/views.py`), so
`/api/auth/login/` can't give a native app what it needs. Turning
`JWT_AUTH_HTTPONLY` off would have weakened the *website* to serve the app — the
wrong trade — so the app gets its own endpoints instead:

| Endpoint | View | Returns |
|---|---|---|
| `POST /api/auth/mobile/login/` | `accounts.views.MobileLoginView` | `access` + `refresh` + `user` in the body, **no cookies** |
| `POST /api/auth/mobile/refresh/` | simplejwt `TokenRefreshView` | a rotated `access` + `refresh` pair |
| `POST /api/auth/mobile/logout/` | simplejwt `TokenBlacklistView` | 200; blacklists the refresh token |

`MobileLoginView` **subclasses `ThrottledLoginView`**, so the app inherits every
control the browser login has: the per-IP rate limit, `CustomLoginSerializer`'s
verified-email requirement, and the admin-approval (`is_active`) gate. Building
it on simplejwt's stock `TokenObtainPairView` would have skipped all three and
given mobile a quietly weaker login path — **if this view is ever rewritten, keep
that inheritance.** A test pins each of the three.

Refresh and logout *are* stock simplejwt views, which is safe for the opposite
reason: they take a token rather than credentials, so there are no credential
checks to inherit.

### Bearer works with no settings change

`JWTCookieAuthentication` (the configured auth class) subclasses
`JWTAuthentication` and checks the `Authorization` header **first** — when a
header is present it never reads the cookie and never runs the CSRF check. So
Bearer authentication needed no new auth class. CSRF is a cookie concern; a
header-authenticated request skips it correctly, and a test pins that too.

### Refresh-token rotation

The two clients want opposite things. Mobile needs to stay logged in
indefinitely — a logged-out app receives no push notifications, which would
defeat Phase 9. The web wants the opposite: the site has no silent refresh, so a
long-lived refresh cookie on a shared or borrowed machine is pure extra exposure
for no benefit.

`SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"]` is a single global, so honouring both
takes a **second token class** (`accounts/tokens.py`):

| | Lifetime | Set by |
|---|---|---|
| Web refresh (`timeline-refresh` cookie) | **1 day** | `SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"]` |
| Mobile refresh | **90 days** | `MOBILE_REFRESH_TOKEN_LIFETIME` (own setting) |
| Access (both) | 1 day | `SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"]` |

**The `client` claim is the security-critical part.** `MobileRefreshToken` stamps
`client: "mobile"` into the payload, and `MobileTokenRefreshSerializer` rejects
any token without it. Without that check, `/api/auth/mobile/refresh/` would
happily accept a *web* refresh token and rotate it into a 90-day one — anyone who
stole a 1-day browser cookie could upgrade it to three months just by POSTing it
to a different URL. The claim is what makes the long lifetime unreachable from
the short-lived path, and rotation preserves it because it mutates the decoded
payload in place. A test pins the rejection.

Watch for this whenever `SIMPLE_JWT` is edited: **`REFRESH_TOKEN_LIFETIME` sets
the web cookie's max-age**, so lengthening it "for the app" silently widens the
browser's credential window. That's exactly the mistake this split exists to
prevent, and a test asserts the web cookie stays under two days.

Other pieces:

- `ROTATE_REFRESH_TOKENS` + `BLACKLIST_AFTER_ROTATION` are on, backed by the
  `rest_framework_simplejwt.token_blacklist` app. Every refresh returns a new
  refresh token and invalidates the one that bought it, so a **stolen refresh
  token is useful only until its owner next opens the app**, not for 90 days.
  The 90-day lifetime is only defensible *because* of this.
- **The blacklist tables need periodic flushing.** simplejwt writes an
  `OutstandingToken` row for every refresh token it issues (every login on either
  client, plus every rotation) and never removes expired ones.
  `deploy/token-flush.{service,timer}` runs `flushexpiredtokens` weekly — see
  [deploy.md](../deploy.md). It only deletes already-expired rows, so it can
  never log anyone out.
- `ACCESS_TOKEN_LIFETIME` stays at **1 day** for both clients.
- **Logout blacklists server-side.** Deleting the token from the device isn't
  enough on its own: a copy lifted from a backup would still mint access tokens.
- A **deactivated user is locked out immediately** despite holding valid tokens —
  simplejwt's `get_user` rejects `is_active=False`. This matters precisely
  *because* refresh tokens now live 90 days; admin approval stays the real gate.

On the device the tokens live in **`expo-secure-store`** (Keychain-backed), never
`AsyncStorage`. Unlike the web's httpOnly cookie they *are* readable by our own
JS, so: never log them, never put them in an error report, never append them to a
URL query string.

**A rotation can outlive the session that started it, and mustn't (#219).** The
refresh runs on a shared in-flight promise and stores the rotated pair when the
response lands, which is a whole round trip after it began — long enough for the
user to sign out in the middle. Signing out then wiped the Keychain and the
refresh wrote a live pair straight back into it; worse, rotation means the token
`logout` blacklisted is *not* the one being stored, so nothing on the server had
ended the session either. The next launch found a good token and signed the
previous user back in without a password — on a handed-on phone, handing over
the account. `tokens.ts` now carries a **session counter** that `clearTokens`
bumps, `saveTokens` takes the session its pair belongs to and refuses a write
from one that has ended (re-checking after the write, since the Keychain writes
are awaits like any other, and undoing by compare-and-delete so it can only ever
remove what it wrote), `getAccessToken` won't prime its in-memory cache from a
read that started before a sign-out, and a refresh is only shared with requests
from the same session.

Three consequences worth knowing, because each was a bug in the first draft of
that fix:

- **A refused write fails its own request with `status: 0`** — "we never got an
  answer" — precisely so it does *not* trigger the session-expired teardown. The
  same check guards the *refusal* path in `request`, which is the likelier
  landing: `logout` blacklists the exact token an in-flight refresh is carrying,
  so the server refuses it moments later, and tearing the session down on that
  would sign out whoever is on the phone by then.
- **A rotated pair we refuse to store is blacklisted server-side** before it's
  discarded. Nobody else holds it, but "nobody holds it" isn't "it can't be
  used", and ending the session on the server is what logout is *for*.
- **A login whose write is refused fails the login.** Reporting success would
  leave the app `signedIn` with no credentials, and since `request` skips its
  refresh branch when there's no access token, nothing would ever say so.

Same shape as the push-registration race in
[notifications.md](notifications.md), one layer down and with more at stake.

### Only the server may end a session (#245)

The silent refresh in `mobile/src/api.ts` is the one place the app destroys
credentials without being asked to, so it has to be certain *why* it is doing it.
Until #245 it wasn't: the refresh `fetch` sat outside any `try`, and the single
`catch` around it treated every failure as the server's verdict — the comment
there listed three causes (expired, rotated away, blacklisted) and all three were
things the server says. A fourth it didn't list, the request never arriving, took
the same branch and ran `clearTokens()` on a refresh token still perfectly valid
90 days out.

That window is the ordinary condition of a mobile network rather than an exotic
one. It needs the connection to work for one request and fail for the next, which
is what a foreground-after-a-while does: the first call 401s (so the network was
up), the app goes to refresh, and the train enters a cutting. The user lands on
the login screen with nothing left to recover with and no way to describe what
happened beyond "it logged me out". `onlineManager` is deliberately left unwired
to NetInfo (see [connections.md](connections.md#reporting-a-refused-write)), so
React Query rejects an offline request rather than pausing it — which is what
makes this reachable rather than theoretical.

The rule now: **a session ends only when the server refuses the token.**
`isTokenRejection` reads the status — 401 (expired, rotated away, blacklisted) or
400 (a malformed body), the two answers simplejwt's `TokenRefreshView` gives —
and only those clear the tokens and fire the session-expired handler. Everything
else rethrows and keeps them:

- **The request never landed.** The `fetch` is guarded and re-raised as an
  `ApiError` with `status: 0`, `fromServer: false` and a sentence of ours,
  keeping the `TypeError` as `cause` — the same shape the web's `request` uses
  (#240/#244).
- **A 200 that isn't the token pair.** A captive portal answering with its own
  login page is a connection problem wearing a success status; unguarded, the
  JSON parse throws and reads exactly like a refused token.
- **A 5xx.** The box redeploying and answering 502 for a few seconds says nothing
  about anyone's token, and a release must not sign every phone out.

The user retries when signal returns and stays signed in. The two paths that end
a session for real are unchanged, and the `'Your session has expired.'` message
is now only shown when it's true. Pinned in `mobile/src/__tests__/api.test.ts`
and `auth.test.tsx`; the cold-start half of the same rule is the `status === 401`
check in `auth.tsx`, which this makes consistent — the two used to disagree about
what a lost connection meant.

### What leaves the phone with the session (#191)

The threat model is a **shared or handed-on phone**: a session ends, someone
else signs in, and nothing of the previous person's may still be on the device.
A session ends three ways — explicit sign-out, the session-expiry handler, and
the cold-start 401 — and the app's session data lives in two kinds of place,
each with its own rule:

- **The TanStack Query cache** (feed, conversation previews, profiles, unread
  counts — the bulk of a session) is emptied by `useSessionReset`
  (`mobile/src/useSessionReset.ts`) on **every** transition to `signedOut`,
  covering all three paths with one rule. It watches auth `status` from
  `AuthGate` rather than being called inside `auth.tsx`, which deliberately has
  no React Query dependency. The cache is in-memory only (never persisted), so
  a process death is its own clear.
- **The module stores** — outbox, drafts, resolved quotes (`outbox.ts`,
  `drafts.ts`, `quotes.ts`) — are cleared by `signOut` itself. A session
  *expiry* deliberately keeps them: unsent words surviving a token failure so
  their owner can retry is the point of the outbox, and an expiry doesn't
  change whose phone it is. The leak that leaves open — a *different* person
  signing in on the login screen the expiry landed on — is closed at sign-in:
  `signIn` compares the new `pk` against the last session's and clears all
  three stores when they differ, so the same person gets their words back and
  anyone else gets nothing.

A third thing leaves with the session, and it is the one with a *race* in it
rather than a rule: the **device's push registration**. `signOut` awaits
`unregisterPush()`, but registration is fire-and-forget, so the two could
interleave and leave the phone receiving the previous user's notifications
(#219). How they're sequenced now lives with push itself, in
[notifications.md](notifications.md) § *App side* — one copy, because the two
docs disagreeing about it is how the next change breaks it.

### What leaves the browser with the session (#194)

Same threat model on a **shared computer**, and since #194 the same two rules —
the web is simpler only because it has fewer ways to end a session.

- **The TanStack Query cache** is emptied by `useSessionReset`
  (`frontend/src/useSessionReset.js`), mounted in `App.jsx` because that is the
  one component still rendered on both sides of the logged-in boundary. It
  watches `user` going null rather than being called from `logout`, and the
  reason is timing rather than taste: at the moment `logout` runs, the feed, the
  nav's unread counts and any open drawer are still mounted, so clearing there
  pulls queries out from under live observers and they immediately refetch —
  carrying a cookie the server has just invalidated — a render before the
  redirect unmounts them anyway.
- **The module stores** — outbox and drafts (`outbox.js`, `drafts.js`) — are
  cleared by `logout` itself, as on the phone.

**And the same guard at sign-in**, for the same reason the phone has one: a
sign-in doesn't have to follow a sign-out, so "the session ended" can't be the
only trigger. Two tabs open as Ada, she logs out in one, and the other still
holds her user, her cache and her drafts — `/login` is public, and the sign-up,
verify-email and reset-password pages all link to it, so the next person reaches
the form without anything in that tab ever going null. `login` therefore compares
the pk it just fetched against the one this browser last held (a ref, since
nothing renders from it) and empties cache and stores when they differ. Same pk
is the same person back again, and their own unsent words are theirs to keep.
Clearing *is* safe from inside `login`, unlike `logout`: the route in that moment
is a public one, so there are no live observers to send refetching.

There is **no session-expiry path** on the web — `api.js` has no 401 handler, so
`user` only becomes null via `logout` or a cold load. If one is ever added,
pointing it at `setUser(null)` gets the cache cleared by the hook for free; what
it must decide for itself is the stores, since the phone deliberately *keeps*
those across an expiry (unsent words surviving a token failure is the point of an
outbox) and leans on the sign-in guard to catch the different-person case.

The teardown runs from a `finally`, which is the other half of #194. `api.logout`
is an ordinary `request()` and *rejects* on a network blink or an already-dead
session — where the app's equivalents (`api.logout`, `unregisterPush`) swallow
their own failures by design. So a failed POST used to skip `setUser(null)` and
both clears, while `NavUserMenu` navigated to `/login` regardless ("clicking
logout should never leave you seemingly still logged in"): you landed on the
login form with the whole previous session still in memory, and the next person
to log in on that browser inherited it. The rejection is now swallowed around
that one call — a throw from the teardown itself is a bug of ours and stays loud.

**What no client can fix** is the auth cookie: it's httpOnly, so only that POST
clears it. A logout whose request never landed therefore leaves a live session
that a page reload picks straight back up, while the UI says logged-out — the
worst-placed remnant of the shared-computer threat model, and untouched by #194.
Closing it needs a retry, or a re-check that tells the person their logout didn't
land; both are product decisions, not cleanups.

### Push device registration

`POST`/`PATCH`/`DELETE /api/push-tokens/` registers, configures or removes one
device's **Expo push token** (`api.models.DevicePushToken`: `user`, `expo_token`,
`platform`, `created_at`, `last_seen`, `show_previews`, `preview_token_hash`).
One user can have several devices.

`expo_token` is unique **globally**, not per user, and POST upserts on it —
overwriting `user`. An Expo token identifies a *device*, so when a phone changes
hands the row must move rather than leave the previous owner's notifications
going somewhere they no longer control. DELETE is scoped to the caller, so a
leaked token value can't be used to silence someone else's phone.

**POST answers `200 {preview_token, show_previews}`, not `204`** (Phase 10b).
The last two fields are the lock-screen preview feature, and both are worth
knowing before touching this endpoint:

- **`show_previews`** — whether this device may show a message's *text* on its
  lock screen. Off by default, and **per device rather than per account**,
  because what leaks is a lock screen and a lock screen belongs to a phone.
  Changed through `PATCH` (`{expo_token, show_previews}`, scoped to the caller's
  own devices, 404 otherwise) and deliberately **not** through POST: the app
  POSTs on every launch, so a value in the registration upsert would either
  reset the user's choice on every cold start or raise on the launch path.

  Registration **clears it when the row changes owner**. The row moving to a
  phone's next owner is the rule above and stays; a preference about a lock
  screen must not be inherited with it.

  Registration also **answers it**, and that is the only way a client can learn
  where its own switch stands — there is no GET, deliberately, since one would
  have to carry a device identifier in a URL. It costs nothing, because the app
  registers on every launch, and it means the reset above isn't silent: without
  it the new owner's app would go on drawing the switch in the position the
  previous owner left it.
- **`preview_token_hash`** — SHA-256 of the device's **preview credential**, the
  thing the iOS notification service extension authenticates with. Minted fresh
  on every registration and returned in plaintext in that one response, which is
  the only place it exists outside the app's keychain. It is opaque and random
  rather than a JWT so that revoking it is the row delete DELETE already
  performs; its only power is `GET /conversations/<id>/push-preview/`, and the
  account's own bearer token is refused *there* just as this credential is
  refused everywhere else. See `api/push_preview.py` for why the extension can't
  use the account's tokens, and for an honest account of what a leaked one can
  reach.

  **On the device it lives in `mobile/src/previewCredential.ts`**, not in
  `tokens.ts` with the session. It is stored under a keychain service this repo
  pins (rather than expo's default, which a package upgrade could change) and
  with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, because an extension woken by a
  push has to read it while the phone is locked — SecureStore's default,
  `WHEN_UNLOCKED`, would work on every unlocked dev handset and never on a lock
  screen. Keeping it out of `tokens.ts` is what confines that at-rest downgrade
  to a read-only preview credential: the access and refresh tokens keep the
  stricter property they have always had. It is deleted wherever this device's
  registration is dropped: sign-out, session expiry, and a cold start whose
  token the server refuses.

  **Only sign-out revokes it server-side**, though, and the asymmetry is worth
  knowing. Sign-out DELETEs the row, which takes the hash with it. The other two
  paths deliberately leave the row alone — the unregister endpoint is
  authenticated, and by then the session is precisely what has been refused — so
  the hash stays valid until the next registration rotates it. What they remove
  is the plaintext, which is the only copy that could be used; there is no way
  for a signed-out device to reach the endpoint without it.

Push itself is documented in [notifications.md](notifications.md); the app that
registers the token is in [mobile-app.md](mobile-app.md).

## Sign-up is gated by admin approval

New sign-ups create an **inactive** account (`is_active=False`) that **cannot log
in until approved** in the Django admin. Uses Django's built-in `is_active` flag —
minimal custom code, and nobody gets in without the maintainer's say-so. Django,
allauth, and simplejwt all refuse to authenticate an inactive user, so the gate
holds without extra code.

**Approving a sign-up (the one action):** Django admin → Users → tick **Active**
(or select rows → "Approve selected sign-ups"). Each environment makes its own
superuser via `python manage.py createsuperuser`.

The who-am-I payload exposes `is_staff` (read-only) so the app nav can show an
**Admin** link to staff only — cosmetic; Django enforces staff access on `/admin/`
server-side. In production `/admin/` is further restricted to the LAN — see
[deploy.md](../deploy.md).

## Email verification (6-digit code)

Email is our sole login identifier, so we confirm a member actually controls the
address they signed up with — otherwise a typo means an unrecoverable account and
a deliberately wrong address points the login identifier at someone else's inbox.
**Verification proves address *control*; admin approval (`is_active`) stays the
membership gate — both are required to log in.**

**Flow.** Sign-up creates the account (`is_active=False`) and emails a **6-digit
code**. The person types/pastes it into the SPA's `/verify-email` page; on a match
we flip allauth's `EmailAddress.verified`. The account then still waits for admin
approval. Login is refused until **both** are true.

**Why a code, not a link.** We run our own small code flow rather than allauth's
built-in email-verification. dj-rest-auth's verify endpoint is HMAC-*key* based
and allauth's code mode is session/stateful — neither maps cleanly onto a
stateless "type this code" REST call, so bending them together was the fragile
path. A code is also the friendlier UX (copy-paste, OS autofill via
`autocomplete="one-time-code"`) and needs **no** `FRONTEND_URL` env var (there's
no link to build). `ACCOUNT_EMAIL_VERIFICATION` stays `"none"` — allauth still
creates the `EmailAddress` row at sign-up; we own flipping its `verified` flag,
which remains the single source of truth the login check reads.

**The code itself** (`accounts.models.EmailVerificationCode`, one row per user):
- Only a **hash** of the code is stored (`django.contrib.auth.hashers`), never the
  plaintext — a DB leak can't hand out live codes. `secrets` (not `random`)
  generates it.
- Short-lived (**15 min**), **5 attempts** then dead (online-guessing guard: 6
  digits × 5 tries = 5-in-a-million), and a **60-second resend cooldown** so
  "resend" can't flood an inbox even from rotating IPs.

**Endpoints** (both `AllowAny`, both enumeration-safe):
- `POST /api/auth/verify-email/` `{email, code}` → flips `verified` and consumes
  the code. An unknown email, missing/wrong/expired code **all** return the same
  generic `400` ("That code is invalid or has expired."), so it can't probe who's
  a member.
- `POST /api/auth/resend-verification/` `{email}` → **always** the identical `200`
  whatever the address; a code is only really issued+sent for a real, not-yet-
  verified account (and not inside the cooldown). Per-IP throttled
  (`resend_verification` scope, env `DJANGO_THROTTLE_RESEND_VERIFICATION`).

The `verify-email` endpoint isn't scope-throttled — the code's own 5-attempt
budget is the limiter.

**Login enforcement** lives in `CustomLoginSerializer` (wired via
`REST_AUTH["LOGIN_SERIALIZER"]`): after dj-rest-auth's own checks (credentials +
`is_active`), it blocks an account that has an `EmailAddress` row but none
verified, with a clear "please verify" message (so the SPA can offer a resend
path — the same small enumeration trade-off login already makes for approval
status). Accounts with **no** `EmailAddress` row — the maintainer's
`createsuperuser`, seeded demo users — are exempt (they never went through the
verifiable sign-up). A one-off data migration
(`0005_verify_existing_active_members`) grandfathered already-approved members so
turning this on didn't lock them out; pending accounts can self-serve a fresh
code via resend.

The Django user admin shows an **Email verified** column beside **Active** so the
maintainer sees both when approving. There's also a
`python manage.py send_test_verification <email>` command: it emails a code and
checks it back interactively — an outbound-email smoke test (e.g. over SSH on the
box) that touches **no** account.

The same code machinery backs forgotten-password reset — see
[Password reset](#password-reset-forgotten-password) below.

## Consent & legal (ToS / privacy)

- Sign-up has a **required** "I agree to the Terms + Privacy Policy" checkbox that
  blocks submit and stamps `User.tos_accepted_at` — a defensible consent record.
  Enforced **server-side** in `CustomRegisterSerializer` (a missing/false
  `accept_terms` is a 400), so it can't be bypassed by hitting the API directly.
- `/terms` and `/privacy` are **public** React routes (reachable from sign-up
  before login; also linked from an in-app footer). They are the single source of
  truth for the documents.
- Jurisdiction is **UK / UK-GDPR** (England & Wales governing law, UK GDPR / DPA
  2018) — matches where the app is hosted (London) and the repo's British spelling. The
  data-controller contact is the maintainer's email for now. These are good-faith
  plain-English drafts, **not legal advice** — worth a solicitor's eyes before any
  broad/public launch (proportionate to skip for a private family beta).

## Account deletion (hard delete)

`POST /api/account/delete/`, **password-reconfirmed** (irreversible action ⇒
re-auth, like a bank transfer). `delete_account()` does the teardown a naive
`user.delete()` gets wrong:

1. Deletes the user's media **files** off storage (a row cascade alone leaves
   orphaned JPEGs on disk) — avatars, their posts' images, their event album
   photos and their chat attachments. See **Media file cleanup** below; this
   used to be a hand-written gather here, and the hard part was that several
   cascades reach *other people's* files.
2. **Last-admin guardrail:** a group whose only admin is leaving hands admin to
   the longest-standing remaining member (`Group.creator` is `SET_NULL`, so a
   group outlives its creator).
3. A group the user was the *sole* member of is deleted outright rather than left
   as dead space.

Deleting a member from the **Django admin** runs the same `delete_account()`
(`UserAdmin.delete_model`/`delete_queryset`), single or bulk. A bare cascade
there skipped points 2 and 3, so the maintainer removing an abusive account could
leave a group with no admin in it or a memberless group as dead space — a
moderation action shouldn't mean less than the member doing it themselves.

### Media file cleanup

Deleting a row does **not** delete the file it points at, and an orphaned file
stays *fetchable* by anyone holding its URL, because `media_auth` gates on being
signed in rather than on owning the file (see
[feed-and-posts.md](feed-and-posts.md)). So "delete the post I regret" has to
mean the photo too, and a maintainer's takedown has to mean it most of all.

**One mechanism does it: a `post_delete` receiver on every model with a file
field**, wired up in `ApiConfig.ready` — see `api/media_cleanup.py`, which
carries the full reasoning. The set is **derived** from our own apps' models
rather than hand-listed, because a registry someone has to remember to update is
the same failure as a call site someone has to remember to write. Today it comes
out as five models: `User.avatar`/`avatar_thumb`, `Group.avatar`/`avatar_thumb`,
`PostImage.image`/`thumbnail`, `EventPhoto.image`/`thumbnail`,
`MessageAttachment.file`/`thumbnail`. `api.tests.MediaFileFieldRegistryTests`
pins that, so a new file field trips a test asking you to confirm the sweep suits
it — not to go and add it somewhere.

Why a signal rather than a call in each delete path, which is what this was:

- **Cascades come free, and they were the hard part.** Deleting an account
  reaches other people's files through `Event.organiser` (deleting the organiser
  destroys albums full of members' photos) and through `Conversation.user_a`/
  `user_b` (which takes the other party's messages in those 1:1 threads). Each
  needed its own hand-written query, and getting the set wrong was silent.
- **Everything that isn't a view is covered.** The Django admin — which *is* the
  documented moderation/takedown path — and the management commands
  (`seed_demo`, `create_review_account`) delete rows without going near a view,
  and so left every file behind. Registering a `post_delete` listener disables
  Django's fast-delete optimisation, which is precisely why the signal then fires
  for cascaded and bulk `queryset.delete()` rows too.
- **The ordering is right by construction.** `Collector.delete` runs inside its
  own transaction, so the sweep is registered `on_commit` and is discarded if the
  delete rolls back — a crash can leave an orphaned file (recoverable, invisible
  in the app), never a live row pointing at nothing.

The one case a receiver can't cover is **replacing** a file, since no row is
deleted: `imaging.save_avatar`/`clear_avatar` call `delete_files_on_commit`
directly, and **their callers must have a transaction open** (`ATOMIC_REQUESTS`
is off, so `on_commit` outside one runs immediately). Both do. Getting that wrong
is worse than an orphan, and it's the reason this is spelled out: the row rolls
back still pointing at a file that's already gone, which is a broken avatar
forever — the old image can't be re-derived and the row won't take a repair
without a re-upload.

That replacement case is also why **a file field must never be editable in the
Django admin**, which `UserAdmin` and `GroupAdmin` both enforce with
`readonly_fields`. Django's file widget carries a "Clear" checkbox that blanks
the column *without deleting a row*, so no receiver fires and the file is
orphaned; and an upload through the admin skips `imaging.process_avatar`
altogether, storing a client's file with its EXIF — including the GPS the app
strips from every other photo — intact. Avatars change through the API or not at
all. `MediaFileFieldRegistryTests` asserts this for every file field, so a new
one can't quietly arrive editable.

None of this narrows *who can fetch a file that still exists* — see issue #223.

**Deactivation is not deletion**, and it's worth being exact about which is
which. Setting `is_active=False` — the admin-approval flag doubling as the
maintainer's takedown lever — **deletes nothing**. Every row survives; the
content simply stops being *returned*, because each read query filters on the
author still being active (`visible_posts`, `_comment_counts`, `visible_events`,
and for an album both `event_photo_previews` and `EventPhotosView` GET, which
filter `uploader__is_active=True`). Those two album queries have to agree, or the
photo count on an event card and the grid it opens would disagree. Note that
`connected_user_ids` deliberately doesn't check `is_active`, so **every consumer
of that set has to**. Reactivating the account brings all of it straight back.
Deletion is the other thing entirely: rows cascade away, files are swept, and
nothing returns.

**The confirm dialog can't be dismissed while the POST is open** (issue #254) —
on either client, by Escape, the backdrop, Cancel or the Android hardware back.
It renders the rejection inside itself, and a "wrong password" 400 is the
overwhelmingly likely one, so dismissing it mid-request left you with no idea
whether the account you'd just asked to erase still existed. Same gate
`ConfirmDeleteDialog.jsx` puts on a half-done delete; the rule and its two
gotchas are written up in
[connections.md](connections.md#reporting-a-refused-write).

All in one transaction. Chosen over anonymise-and-keep because it's the cleaner
erasure story for a privacy-first app; the accepted trade-off is that replies
*others* wrote under a deleted user's comment cascade away too. **Backups caveat**
(disclosed in the privacy policy): deleted data can persist in the encrypted R2
backups until they age out (~30-day window).

## Password change

Logged-in password rotation via dj-rest-auth's `POST /api/auth/password/change/`
(no email involved, so it's independent of the forgotten-password reset below).
`OLD_PASSWORD_FIELD_ENABLED = True` so the **current password is required** — a
hijacked session (e.g. via XSS) can't silently rotate the password, and a
shoulder-surfer at an unlocked screen can't lock the owner out. Frontend is an
inline expanding section on `/settings`.

**Close is held while the POST is out** (issue #259 on the web, #256 on the
phone). The section is the only renderer of its own rejection, and
Close collapses it — so pressing Change password and then Close meant a 400 of
*"Your old password was entered incorrectly"* landed nowhere at all, leaving you
believing your password had been rotated when it hadn't. Of everything in that
family this is the one where silence leaves you wrong about a *credential*, which
is why it's called out here as well as in
[connections.md](connections.md#reporting-a-refused-write). The flag is released
the moment the request settles, not when the section closes — the success line
needs a way out too.

**On the phone there are four ways out, not one**, and the form can see none of
them: Close, Android's hardware back (registered on the section, which owns
`open`), and the Settings screen's own "← Back" and iOS swipe-back — two levels
above the request. The form declares the write once and both holds read it,
which is the one place the *forwarding* in `mobile/src/writeHold.tsx` earns its
keep: a declaration reaches only the nearest hold, so without it the screen
would never learn a password change was in flight. The two other Settings
sections that render their own rejection — read receipts and the notification
toggles — declare into the same hold; `DeleteAccountSection` deliberately does
not, because it holds its own dialog and then lets go *before* a teardown that
is itself two network round trips.

**The phone's profile editor is the same shape with one extra wrinkle**: its
`onSuccess` awaits `refreshUser()`, and React Query keeps a mutation pending for
the whole of `onSuccess` — so it sets a `saved` flag first and holds on
`isPending && !saved`, or Cancel would stay shut across a second round trip that
has nothing to report. Same fix as the web's (#259), same reason.

## Password reset (forgotten password)

Self-service recovery for a member who's forgotten their password (#38) — without
it, a forgotten password is a permanent lockout needing manual admin surgery, a
poor fit for the non-technical friends/family this app is for.

**A 6-digit code, not a link — the same flow as email verification.** dj-rest-auth
ships link-based `password/reset` endpoints, but we deliberately run our own code
flow instead, for the same reasons codes won for verification: friendlier UX
(copy-paste, OS autofill), enumeration-safety we control end-to-end, and **no
`FRONTEND_URL`** needed (there's no link to build). The two flows share their
machinery — `EmailVerificationCode` and `PasswordResetCode` both subclass the
abstract `EmailCode` (hashed code only, 15-min expiry, 5-attempt budget, 60-sec
resend cooldown). dj-rest-auth's link endpoints are **not routed at all** — see
"The auth URL surface" below for why leaving them mounted-but-uncalled turned out
not to be harmless.

**Flow.** `/reset-password` in the SPA (reached from a "Forgot your password?"
link on login):
1. **Request** — `POST /api/auth/password-reset/` `{email}` emails a 6-digit code.
2. **Confirm** — `POST /api/auth/password-reset/confirm/`
   `{email, code, new_password1, new_password2}` verifies the code, runs the new
   password through Django's validators, sets it, and consumes the code.

**The credential is stronger than it looks.** A reset directly grants account
access (unlike verification, which still needs admin approval), so it's the
account-takeover surface. But a 6-digit code with a 5-attempt budget is
5-in-a-million per issued code; getting more guesses means requesting more codes,
each of which emails the *real* owner (noise) and is rate-limited + cooldown-
gated. Brute-forcing is impractical and loud. The code is stored only as a hash,
so a DB leak can't hand out live resets.

**Two deliberate details:**
- **A successful reset also marks the address verified.** Receiving the emailed
  code proves inbox control, so a member who never finished verification but
  forgot their password isn't then stuck behind the verify gate. (Admin approval,
  `is_active`, still applies — a reset never bypasses membership.)
- **Password errors (mismatch / too weak) don't consume the code.** They're only
  reachable *after* a valid code is held, so a real user who fumbles a weak
  password can fix it and resubmit with the same still-valid code.

**Enumeration-safety** mirrors verification: the request endpoint always returns
the identical 200 (a code is only really sent to a real account, and a send
failure is swallowed+logged so it can't become a 500-vs-200 oracle); the confirm
endpoint returns one generic 400 for unknown-email / missing / wrong / expired
alike. Password-strength/mismatch messages are more specific, but only a holder of
a valid code sees them, so they leak nothing about membership. Both are per-IP
throttled (`password_reset`, `password_reset_confirm` scopes — see
[Rate-limiting](#rate-limiting-auth-sensitive-endpoints)).

**Response *timing* is equalised on the request too, not just the body.** Issuing
a code runs a PBKDF2 hash; a branch that issues none (unknown address, or a real
account inside its resend cooldown) would return hundreds of ms sooner and leak
membership from latency alone. So the request view spends one throwaway hash on
the no-issue branches — the same guard the [duplicate-email sign-up](#accountemail-enumeration--closed-at-sign-up)
path uses. One residual is accepted (as at sign-up): a real account's *first*
request in a cooldown window also sends an email, whose cost isn't equalised; the
60-sec cooldown means repeat probes fall into the fast, no-send bucket. The
confirm endpoint has a smaller, matching residual (an unknown email returns before
`verify()` spends its `check_password`) shared with the verify-email endpoint —
worth folding into a shared constant-time helper on `EmailCode` if either flow
ever opens to the public.

**Known limitation:** a reset doesn't revoke JWTs already issued to other
sessions (our auth is stateless — the cookie token stays valid until its 1-day
expiry). Acceptable for a private beta; revisit with token-versioning if it
matters.

## Reporting & moderation

A quiet **Report** control on posts + comments (hidden on your own) →
`POST /api/reports/` → a `Report` row (exactly one of post / comment / message,
DB-enforced) surfaced in a Django-admin moderation queue (filter to `open`, remove
the content, mark resolved). Removal itself stays a manual admin action (the
maintainer's judgement). Chosen over an email-only takedown path so it's
self-contained and testable. See also the moderation runbook in
[deploy.md](../deploy.md).

**Messages are reportable too, and they're the special case** (Phase 9b): the admin
can no longer read a conversation at all, so a report is the *only* path by which
message text reaches the maintainer, and the row carries a server-written snapshot
of the reported text. [messaging.md](messaging.md#moderation-a-report-is-the-only-window)
owns that story — the visibility gate, the snapshot's rationale, and why deleted
messages can't be reported.

**Mobile (Phase 9 E4a).** The iOS app surfaces the same controls against the same
endpoints — App Review requires working report **and** block for a social app. A
post's ⋯ overflow menu offers **Report** on others' posts (and **Edit**/**Delete**
on your own), and a comment's ⋯ does exactly the same one level down (issue #128 —
see [feed-and-posts.md](feed-and-posts.md#editing--deleting-your-own-comment)).
**Block/Unblock** lives on a person's profile, confirmed through the shared
disconnect-warning modal (a block severs the same shared group chats — see
[connections.md](connections.md)); once you've blocked someone the profile shows
only Unblock plus an explanation. No backend change — the app is another client of
the Phase 5 block and Phase 7 report endpoints.

## Security posture

This is the layer holding real credentials, so:

- **httpOnly auth cookie** keeps the token out of reach of page JS (XSS
  mitigation). Paired in production with `Secure` + `SameSite` + HTTPS-only.
- **CSRF:** cookie-based auth needs CSRF protection. `JWT_AUTH_COOKIE_USE_CSRF` is
  on — once the auth cookie is present, unsafe requests must carry an
  `X-CSRFToken` header matching the `csrftoken` cookie. `/api/auth/csrf/` lets the
  SPA prime that cookie on load. The SPA reads the non-httpOnly `csrftoken` and
  echoes it. This is **why production serves SPA + API same-origin** behind Caddy
  (see [deploy.md](../deploy.md)) — miss it and every authenticated mutation 403s.
  Test gotcha: Django's test client sets `_dont_enforce_csrf_checks`; use
  `APIClient(enforce_csrf_checks=True)` to test the blocked-without-token path.
- **CORS with credentials:** `CORS_ALLOW_CREDENTIALS = True` and
  `CORS_ALLOWED_ORIGINS` an explicit allowlist (never `*` with credentials);
  frontend fetches use `credentials: "include"`.
- **Secrets never in the repo** — `DJANGO_SECRET_KEY` is env-only, enforced by a
  settings guard (with `DEBUG` off and no key, the app refuses to boot; with
  `DEBUG` on it falls back to a dev key). Regression-tested.
- **Author/sender is never trusted from the client** — every create endpoint sets
  it from `request.user`, ignoring any value in the body.
- **A malformed id in a request body is a 400, never a 500** (#205). Most bodies
  go through a serializer, which coerces for you; the handful of endpoints that
  read `request.data` by hand run every id through `_int_id` / `_int_ids`
  (`api/views.py`) first. Handed to the ORM raw, a non-numeric id raises
  `ValueError` — which DRF has no handler for, so the caller gets a 500 and the
  log gets a stack trace that anyone can generate in a loop. The helper also
  **range-checks** (a long enough run of digits overflows the bigint column —
  the same 500 by another route) and **refuses booleans** (`int(True) == 1`, so
  `{"ids": [true]}` would silently mean row 1 — a wrong row, not a missing one).
  `_message_id_param` defers to it, so `?thread_root=`/`?ids=` and a body field
  can't drift into different answers about what an id is. Id *lists* are capped
  at `BODY_IDS_MAX` — one bind parameter per id, and the driver refuses a
  statement with more than 65535 of them.
- **A request body doesn't have to be an object.** `[]` is valid JSON and DRF
  passes it through, so a hand-read body called `.get` on a list and raised
  `AttributeError` — the same 500 one level up. `_body(request)` is the guard;
  endpoints that hand the whole body to a serializer don't need it, because DRF
  checks the shape for them. The endpoints applying both rules are listed in
  [messaging](messaging.md#api),
  [groups](groups.md#api),
  [notifications](notifications.md#api),
  [events](events.md) and
  [feed-and-posts](feed-and-posts.md#posts).

### The auth URL surface

**Every dj-rest-auth route is registered individually in `config/urls.py`. Do not
re-introduce `include("dj_rest_auth.urls")`.** The include registers its routes as
`re_path(r"login/?$", ...)` — the trailing slash is *optional* — so a `path()`
override placed above it only ever shadows the slashed spelling. For a long time
this meant:

- `POST /api/auth/login` (no slash) resolved to dj-rest-auth's own `LoginView`
  instead of `ThrottledLoginView`. It was a fully working login — the global
  `LOGIN_SERIALIZER` still applied both the verified-email and `is_active` gates,
  and the JWT cookies were still set — with **no rate limit at all**, since that
  view declares no throttle classes and `DEFAULT_THROTTLE_CLASSES` is deliberately
  unset. The 10/min limit could be skipped by deleting one character.
- `POST /api/auth/password/change` (no slash) was unthrottled the same way.
- dj-rest-auth's link-based `password/reset` pair stayed live, anonymous and
  unthrottled. Worse, its URL generator reverses `password_reset_confirm` — a name
  we rebind to our own zero-argument path — so it raised `NoReverseMatch` and
  **500'd for addresses that had an account while returning 200 for those that
  didn't**: a clean account-existence oracle sitting in front of the very leak the
  hand-written reset view equalises PBKDF2 timing to close.

Listing routes explicitly is the fix and the guard: anything unnamed isn't routed,
and `path()` matches the slash exactly, so there is no second spelling. Only the
four the clients actually use are registered — `login/`, `password/change/`,
`logout/`, `user/`. dj-rest-auth's `token/verify` + `token/refresh` pair is
deliberately left out on the same reasoning that made the reset pair dangerous:
no client calls either (the web session is a 1-day cookie and simply re-logs in),
and an anonymous endpoint nothing calls is surface without a purpose. Our own
reset-confirm route is named `password_reset_code_confirm` rather than
`password_reset_confirm`, so it no longer squats on the name allauth/dj-rest-auth
reverse with `(uid, key)` — which is what made their view 500 in the first place,
and would re-arm if an `allauth` include were ever added. The
`AuthUrlSurfaceTests` in `accounts/tests.py` assert on `resolve()` for both the
paths that must reach a throttled view and the ones that must reach nothing —
behaviour tests against the slashed URL cannot catch this class of bug.

### Rate-limiting (auth-sensitive endpoints)

`login`, `registration/`, `password/change/`, `account/delete/`, the
email-verification endpoints, and the password-reset endpoints are throttled via
DRF's `ScopedRateThrottle` (login 10/min, register 5/min, password-change 10/min,
account-delete 5/min, resend-verification 5/min, verify-email 20/min,
password-reset 5/min, password-reset-confirm 20/min; all env-overridable). The two reset scopes mirror their verification counterparts:
per-IP (the caller is anonymous), with the request side kept low to blunt inbox-
spamming and the confirm side generous so a real user retrying a weak password
isn't blocked. A tripped limit is a clean `429`. Two non-obvious decisions:

- **Sign-up is throttled because it sends mail on an anonymous caller's say-so.**
  Each request creates a `User` row *and* emails a code to an address the caller
  chose, so an unthrottled endpoint is an inbox-bomb aimed at third parties, sent
  from our own domain at the cost of its sending reputation. It inherited
  dj-rest-auth's `dj_rest_auth` scope, which has no rate configured and no default
  throttle class behind it — i.e. no limit — until it was given its own.
- **Login is keyed on IP, not the submitted email.** An email-keyed limit would
  let an attacker lock a real member out of their *own* login by spamming wrong
  passwords for their address (a DoS). Per-IP blunts online guessing without that
  foot-gun. Password-change and delete are per-user (caller is authenticated).
- **`NUM_PROXIES=1` is what makes the per-IP login limit actually hold.** Without
  it, DRF derives the throttle identity from the *entire* `X-Forwarded-For`
  string; since Caddy *appends* the real client IP, an attacker could send a
  rotating junk prefix and mint a fresh bucket per request. `NUM_PROXIES=1` (we
  have exactly one proxy hop, Caddy) tells DRF to trust only the last address.
- **Throttle counters use the DB cache in prod** (`DatabaseCache`, reuses Postgres
  — no Redis). The default per-process `LocMemCache` would give each gunicorn
  worker its own counter, inflating the real limit ~3×. `entrypoint.prod.sh` runs
  `createcachetable`. Dev keeps `LocMemCache` (single-process runserver).

### Account/email enumeration — closed at sign-up

A duplicate-email sign-up returns the **identical** "verify your email" 201 as a
fresh sign-up (silent no-op in the serializer, with a throwaway password hash to
equalise timing) **and sends no verification email**; the existing account is
never touched. This closes the probe for whether an email is a member. The
verification **and** password-reset endpoints hold the same line — `verify-email`
and `password-reset/confirm` return one generic error for unknown-email/wrong-code
alike, and `resend-verification` and `password-reset` always return the identical
200 (see [Email verification](#email-verification-6-digit-code) and
[Password reset](#password-reset-forgotten-password) above). (Login still returns
a distinct message once an account is active but
unverified — a smaller leak accepted for now, consistent with the existing
inactive-account message; revisit if sign-ups ever open to the public.)

## Testing

Phase 2 is where automated testing started for real; every feature since ships
tests. Backend uses Django's test runner against a **Postgres service container**
in CI (not SQLite — match the prod engine so Postgres-specific behaviour can't
hide). Frontend uses Vitest. CI (`.github/workflows/main.yml`) runs both on every
push/PR; `main` requires the `backend` + `frontend` checks green to merge.
