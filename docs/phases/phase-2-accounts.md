# Phase 2 — Accounts & Authentication

**Status:** done 2026-07-04 (PR #5). Branch protection on `main` now requires the
`backend` + `frontend` checks.

## Goal

Real user accounts stored in Postgres, with sign-up / log-in / log-out, using
Django's built-in auth plus token auth for the API (do **not** hand-roll
password hashing, sessions, or tokens — see `docs/SHARED.md`). The wireframe
from Phase 1 gets wired to know "who is logged in."

## Decisions (confirmed with the user, 2026-07-04)

These were the open forks in the plan; locked in before starting because they're
costly to change later.

1. **Custom user model, from the start.** A dedicated `accounts` app with
   `User(AbstractUser)`, set as `AUTH_USER_MODEL = "accounts.User"`, using
   **email as the login identifier**. Django's own docs recommend setting a
   custom user model at project start even if it's identical to the default —
   retrofitting one after real accounts exist means painful data migrations.
   Gives us a natural home for profile fields (bio, display name — already shown
   in the Phase 1 wireframe) in Phase 4.
2. **Token auth via `dj-rest-auth`, token stored in an httpOnly cookie.** JWT
   mode (`dj-rest-auth` + `djangorestframework-simplejwt`), with the token in an
   **httpOnly** cookie so JavaScript can't read it — an XSS bug then can't steal
   a login. Matches SHARED.md's "token from the start so web + mobile can share
   it." Registration uses `dj-rest-auth`'s registration endpoint (which pulls in
   `django-allauth`).
3. **Sign-up gating: admin approval.** The sign-up form works and creates an
   account, but the account is **inactive** (`is_active=False`) and cannot log
   in until approved in the Django admin. Uses Django's built-in `is_active`
   flag — minimal custom code, nobody gets in without the maintainer's say-so.

## Runnable product at the end of this phase

A person can, in the running app:
- Submit the sign-up form (email + password) — the account is created but
  **pending approval** and cannot log in yet.
- After the maintainer approves them in the Django admin, **log in and log out**.
- See a page that only works when logged in (e.g. the feed), and get bounced to
  a login screen when logged out.

## Definition of done

- [x] Custom `accounts.User(AbstractUser)` with email login, set as
      `AUTH_USER_MODEL`, migrated into Postgres (see DB-reset caveat in Notes)
- [x] Passwords are hashed by Django (never stored in plain text)
- [x] API endpoints for register / login / logout / "who am I" via `dj-rest-auth`
- [x] Auth token delivered in an **httpOnly** cookie (not readable by JS)
- [x] New sign-ups are inactive until approved in the Django admin; approving is
      a documented one-toggle action
- [x] The user is visible/manageable in the Django admin (register the custom
      user with a suitable `UserAdmin`)
- [x] Frontend has login and sign-up forms wired to those endpoints, plus an
      auth-state context and a logout control
- [x] Logged-in state persists across page refresh (re-checks "who am I" on load)
- [x] Protected pages redirect to login when not authenticated
- [x] **Automated tests exist and run in CI** (first real test suite — see
      "Testing & CI"):
  - [x] Backend auth tests: register (creates an *inactive* account), login
        (rejected while inactive, succeeds once active), logout, "who am I", and
        that a protected endpoint rejects unauthenticated requests
  - [x] Settings hardening test carried over from Phase 0: with `DEBUG` off and
        no `DJANGO_SECRET_KEY`, the app refuses to boot (`ImproperlyConfigured`);
        with `DEBUG` on it falls back to the dev key
  - [x] Frontend test(s) for the login/auth flow (Vitest)
  - [x] `.github/workflows/main.yml` runs backend + frontend tests on every
        push/PR, replacing the Phase 0 placeholder job
  - [x] Branch protection on `main` updated to require the new CI job name(s)
        instead of `placeholder` (followed the deadlock-free sequence below):
        required checks are now `backend` + `frontend`

## Steps

1. **Custom user model first.** Create an `accounts` app, add
   `User(AbstractUser)` (email as `USERNAME_FIELD`, email unique), set
   `AUTH_USER_MODEL = "accounts.User"` in settings, and register it in the admin.
   Do this **before** any real accounts exist. Because Phase 0 already ran the
   default `auth` migrations into the dev DB, reset it first (see caveat below).
2. Confirm Django's DB settings point at the Postgres container (already wired in
   Phase 0) and run migrations to create the custom user table.
3. Add the API auth layer: install and configure `dj-rest-auth` (+ `allauth` for
   registration, + `simplejwt` for JWT), enable JWT-in-httpOnly-cookie mode, and
   expose register / login / logout / current-user endpoints. Set DRF's default
   authentication to the cookie-based JWT class and default permission to
   `IsAuthenticated` (opt specific endpoints out with `AllowAny`).
4. Make sign-up create inactive accounts: override the registration serializer/
   flow so `is_active=False` on create, and confirm login is refused until an
   admin flips it on. Create a superuser for admin access.
5. Build the frontend: login + sign-up forms, an auth-state context (fetches
   "who am I" on load so refresh keeps you logged in), and a logout action.
   Fetches use `credentials: "include"` so the httpOnly cookie is sent.
6. Add frontend route protection (redirect to `/login` when not authenticated)
   and confirm the matching backend permission checks reject anonymous requests.
7. Stand up the real test suite and wire it into CI (see below), then update
   branch protection.

## Testing & CI

Phase 2 is where automated testing starts for real — Phase 0 deliberately left
CI as a passing placeholder. From here on, every phase ships tests.

- **Backend:** Django's built-in test runner. Cover the auth surface: register
  (asserts the new account is inactive), login (refused while inactive, works
  once active), logout, current-user, and that protected endpoints reject
  unauthenticated requests. Fold in the **Phase 0 settings hardening** as a
  regression test — `DEBUG=False` with no `DJANGO_SECRET_KEY` raises
  `ImproperlyConfigured`; `DEBUG=True` falls back to the dev key (guards
  `backend/config/settings.py`).
- **Frontend:** Vitest for the login/sign-up flow and auth-state behaviour
  (mock the API; assert redirect-when-anonymous and persisted-login-on-refresh).
- **CI test database — use a Postgres service container**, not SQLite, so tests
  run against the same engine as production. SQLite can hide Postgres-specific
  behaviour; matching engines is the boring, low-surprise choice. GitHub Actions
  makes a `postgres:16` service easy to attach.
- **CI jobs** in `.github/workflows/main.yml`, replacing the placeholder:
  - `backend`: start Postgres service, `uv sync`, `python manage.py test`
  - `frontend`: `npm ci`, `npm test`

### Branch-protection update — deadlock-free sequence

`main` has branch protection with `required_status_checks.contexts =
["placeholder"]`, `strict: true`, and `enforce_admins: true`. If we simply
rename the CI job, the required `placeholder` check never runs on the PR and it
can never merge. Do it in this order:

1. In the Phase 2 PR, define the new `backend` + `frontend` jobs (placeholder can
   be removed). Push so both jobs **run and report on the open PR**.
2. Owner updates the required checks (a settings change, not gated by a check):
   ```
   gh api --method PATCH \
     repos/Sam-GitHuber/TimeLine/branches/main/protection/required_status_checks \
     -f 'contexts[]=backend' -f 'contexts[]=frontend'
   ```
   (Or edit it in the GitHub branch-protection UI.)
3. The PR's own `backend`/`frontend` checks are now the required ones and are
   green → the PR becomes mergeable. Merge.

Zero-window alternative: keep the `placeholder` job alongside the new ones for
this PR, merge, then swap the required contexts and delete `placeholder` in a
tiny follow-up PR.

## Security notes

This is the first phase holding real credentials.
- **httpOnly cookie** keeps the token out of reach of page JavaScript (XSS
  mitigation). Pair with `SameSite` and, in production (Phase 5), `Secure` +
  HTTPS-only.
- **CSRF:** cookie-based auth needs CSRF protection; `dj-rest-auth`'s cookie JWT
  flow handles the CSRF token — wire the frontend to send it on mutating calls.
- **CORS with credentials:** set `CORS_ALLOW_CREDENTIALS = True` and keep
  `CORS_ALLOWED_ORIGINS` an explicit allowlist (never `*` with credentials);
  frontend fetches use `credentials: "include"`.
- Don't log secrets, tokens, or passwords. Keep `DJANGO_SECRET_KEY` out of the
  repo (already enforced by the Phase 0 settings guard).
- Inactive-by-default sign-up means a leaked/guessed form can't create a usable
  account without maintainer approval.
- **Accepted risk — account/email enumeration** (from the Phase 2 security
  review, dismissed at 2/10): duplicate-email registration and pending-account
  login return allauth's distinct default messages, so someone could probe
  whether an email is a member. It's stock, unmodified allauth/dj-rest-auth
  behaviour, leaks only membership existence (no credentials/session/data), and
  is low-value for a deliberately private, approval-gated friends-and-family app
  — so we accept it for now. **Revisit if sign-ups ever open to the public**
  (e.g. around the Phase 10 openness/funding work): switch to generic
  "check your email"-style responses that don't distinguish existing accounts.

## Notes / decisions log

- **DB reset caveat:** introducing `AUTH_USER_MODEL` after the initial `migrate`
  (which Phase 0 ran) is not a clean in-place migration. Since the dev DB holds
  no real data yet, reset it before migrating the custom user:
  `docker compose down -v` (drops the `postgres_data` volume), then bring it back
  up so migrations create the custom user table from scratch. Do this now, while
  it's free — after real family accounts exist it would be destructive.
- **New dependencies (backend):** `dj-rest-auth` (7.2), `django-allauth` (65.18),
  `djangorestframework-simplejwt` (5.5), plus `requests` (pulled in transitively
  by allauth's socialaccount provider code that dj-rest-auth's registration
  imports). All are standard, well-trodden libraries; recorded here per the
  SHARED.md "raise new libraries" rule since they extend the from-the-start auth
  choice rather than replace it. `pyjwt` also arrives as a simplejwt dep.
- **allauth 65 settings API:** allauth ≥65 replaced the old per-flag settings
  with `ACCOUNT_LOGIN_METHODS = {"email"}` and
  `ACCOUNT_SIGNUP_FIELDS = ["email*", "password1*", "password2*"]`. With no
  username field on the user, `ACCOUNT_USER_MODEL_USERNAME_FIELD = None` is what
  stops allauth trying to set one.
- **Custom serializers were required, not optional:** dj-rest-auth's default
  `RegisterSerializer`/`UserDetailsSerializer` reference a `username` field our
  model doesn't have, so `accounts.serializers` provides slimmed versions
  (username dropped). `CustomRegisterSerializer.save()` is also where
  `is_active=False` is set.
- **Inactive gating is mostly free:** Django/allauth won't authenticate an
  inactive user, so login is refused while pending without extra code. simplejwt
  also refuses to resolve a token for an inactive user, so even the register
  flow (which we made issue *no* token anyway) couldn't accidentally let someone
  in. `InactiveRegisterView` deliberately skips `complete_signup` (which would
  try to log the new user in and reverse an allauth URL we don't route).
- **CSRF with the cookie-JWT flow:** enabled `JWT_AUTH_COOKIE_USE_CSRF`, so once
  the auth cookie is present, unsafe requests must carry the `X-CSRFToken`
  header matching the `csrftoken` cookie. Added `/api/auth/csrf/` for the SPA to
  prime that cookie on load, `CSRF_TRUSTED_ORIGINS` for the cross-port dev
  origin, and `CORS_ALLOW_CREDENTIALS = True`. Gotcha for tests: Django's test
  client sets `_dont_enforce_csrf_checks`, which suppresses even dj-rest-auth's
  manual CSRF check — use `APIClient(enforce_csrf_checks=True)` to test the
  blocked-without-token path.
- **Login response still contains the access token in its JSON body** (dj-rest-
  auth behaviour). The httpOnly cookie is what we rely on; the frontend never
  reads or stores that body token. An XSS attacker can't retrieve a past login
  response, so the "JS can't read the token" property effectively holds. If we
  want to be stricter later we can override the login response to strip it.
- **Access token lifetime set to 1 day** (`SIMPLE_JWT`) because the frontend
  doesn't do silent refresh yet; a 5-minute default would log people out
  constantly. Revisit (add refresh-on-401) when it matters.
- **Approving a sign-up (the one-toggle action):** in Django admin → Users, tick
  **Active** on the pending account (or select rows → "Approve selected
  sign-ups"). A dev superuser was created locally for admin access
  (`admin@timeline.local`); each environment makes its own via
  `python manage.py createsuperuser`.
- **Branch protection (done):** the CI job was renamed from `placeholder` to
  `backend` + `frontend`, and once both were green on the Phase 2 PR the required
  contexts were swapped (`PATCH .../required_status_checks` with
  `contexts[]=backend`, `contexts[]=frontend`). `main` now requires those two.
- **Staff-only Admin link (added on top of the DoD):** the who-am-I payload
  exposes `is_staff` (read-only), and the app nav shows an **Admin** link (to the
  backend `/admin/`, built from `VITE_API_URL`, opens in a new tab) only for
  staff users. This is cosmetic — Django enforces staff access on `/admin/`
  server-side. **Phase 5 follow-up:** harden the admin *surface* itself
  (HTTPS-only, and consider a non-default admin URL / IP allowlist / 2FA).
