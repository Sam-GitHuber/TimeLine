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
- **Access-token lifetime is 1 day** (`SIMPLE_JWT`) because there's no silent
  refresh yet — a 5-minute default would log people out constantly. Add
  refresh-on-401 when it matters.
- **allauth ≥65 settings API:** `ACCOUNT_LOGIN_METHODS = {"email"}`,
  `ACCOUNT_SIGNUP_FIELDS = [...]`, and `ACCOUNT_USER_MODEL_USERNAME_FIELD = None`
  (stops allauth trying to set a username). Custom serializers in
  `accounts/serializers.py` drop the `username` field dj-rest-auth's defaults
  assume, and `CustomRegisterSerializer.save()` is where `is_active=False` and the
  ToS consent stamp are set.

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
  2018) — matches the home server's location and the repo's British spelling. The
  data-controller contact is the maintainer's email for now. These are good-faith
  plain-English drafts, **not legal advice** — worth a solicitor's eyes before any
  broad/public launch (proportionate to skip for a private family beta).

## Account deletion (hard delete)

`POST /api/account/delete/`, **password-reconfirmed** (irreversible action ⇒
re-auth, like a bank transfer). `delete_account()` does the teardown a naive
`user.delete()` gets wrong:

1. Deletes the user's media **files** off storage first (a row cascade alone
   leaves orphaned JPEGs on disk).
2. **Last-admin guardrail:** a group whose only admin is leaving hands admin to
   the longest-standing remaining member (`Group.creator` is `SET_NULL`, so a
   group outlives its creator).
3. A group the user was the *sole* member of is deleted outright rather than left
   as dead space.

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
resend cooldown). The dj-rest-auth link endpoints remain mounted (via
`dj_rest_auth.urls`) but nothing calls them, exactly as with verify-email.

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
`POST /api/reports/` → a `Report` row (post XOR comment, DB-enforced) surfaced in
a Django-admin moderation queue (filter to `open`, remove the content, mark
resolved). Removal itself stays a manual admin action (the maintainer's
judgement). Chosen over an email-only takedown path so it's self-contained and
testable. See also the moderation runbook in [deploy.md](../deploy.md).

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

### Rate-limiting (auth-sensitive endpoints)

`login`, `password/change/`, `account/delete/`, the email-verification endpoints,
and the password-reset endpoints are throttled via DRF's `ScopedRateThrottle`
(login 10/min, password-change 10/min, account-delete 5/min, resend-verification
5/min, verify-email 20/min, password-reset 5/min, password-reset-confirm 20/min;
all env-overridable). The two reset scopes mirror their verification counterparts:
per-IP (the caller is anonymous), with the request side kept low to blunt inbox-
spamming and the confirm side generous so a real user retrying a weak password
isn't blocked. A tripped limit is a clean `429`. Two non-obvious decisions:

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
