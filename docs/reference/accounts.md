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
(no email involved, so it's independent of the not-yet-built forgotten-password
reset). `OLD_PASSWORD_FIELD_ENABLED = True` so the **current password is
required** — a hijacked session (e.g. via XSS) can't silently rotate the password,
and a shoulder-surfer at an unlocked screen can't lock the owner out. Frontend is
an inline expanding section on `/settings`.

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

`login`, `password/change/`, and `account/delete/` are throttled via DRF's
`ScopedRateThrottle` (login 10/min, password-change 10/min, account-delete 5/min;
env-overridable). A tripped limit is a clean `429`. Two non-obvious decisions:

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

A duplicate-email sign-up returns the **identical** "pending approval" 201 as a
fresh sign-up (silent no-op in the serializer, with a throwaway password hash to
equalise timing); the existing account is never touched. This closes the probe
for whether an email is a member. (Login still returns allauth's distinct
"inactive account" message — a smaller leak accepted for now; revisit if sign-ups
ever open to the public.)

## Testing

Phase 2 is where automated testing started for real; every feature since ships
tests. Backend uses Django's test runner against a **Postgres service container**
in CI (not SQLite — match the prod engine so Postgres-specific behaviour can't
hide). Frontend uses Vitest. CI (`.github/workflows/main.yml`) runs both on every
push/PR; `main` requires the `backend` + `frontend` checks green to merge.
