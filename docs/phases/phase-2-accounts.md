# Phase 2 — Accounts & Authentication

**Status:** not started (plan confirmed 2026-07-04)

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

- [ ] Custom `accounts.User(AbstractUser)` with email login, set as
      `AUTH_USER_MODEL`, migrated into Postgres (see DB-reset caveat in Notes)
- [ ] Passwords are hashed by Django (never stored in plain text)
- [ ] API endpoints for register / login / logout / "who am I" via `dj-rest-auth`
- [ ] Auth token delivered in an **httpOnly** cookie (not readable by JS)
- [ ] New sign-ups are inactive until approved in the Django admin; approving is
      a documented one-toggle action
- [ ] The user is visible/manageable in the Django admin (register the custom
      user with a suitable `UserAdmin`)
- [ ] Frontend has login and sign-up forms wired to those endpoints, plus an
      auth-state context and a logout control
- [ ] Logged-in state persists across page refresh (re-checks "who am I" on load)
- [ ] Protected pages redirect to login when not authenticated
- [ ] **Automated tests exist and run in CI** (first real test suite — see
      "Testing & CI"):
  - [ ] Backend auth tests: register (creates an *inactive* account), login
        (rejected while inactive, succeeds once active), logout, "who am I", and
        that a protected endpoint rejects unauthenticated requests
  - [ ] Settings hardening test carried over from Phase 0: with `DEBUG` off and
        no `DJANGO_SECRET_KEY`, the app refuses to boot (`ImproperlyConfigured`);
        with `DEBUG` on it falls back to the dev key
  - [ ] Frontend test(s) for the login/auth flow (Vitest)
  - [ ] `.github/workflows/main.yml` runs backend + frontend tests on every
        push/PR, replacing the Phase 0 placeholder job
  - [ ] Branch protection on `main` updated to require the new CI job name(s)
        instead of `placeholder` (follow the deadlock-free sequence below)

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

## Notes / decisions log

- **DB reset caveat:** introducing `AUTH_USER_MODEL` after the initial `migrate`
  (which Phase 0 ran) is not a clean in-place migration. Since the dev DB holds
  no real data yet, reset it before migrating the custom user:
  `docker compose down -v` (drops the `postgres_data` volume), then bring it back
  up so migrations create the custom user table from scratch. Do this now, while
  it's free — after real family accounts exist it would be destructive.
- **New dependencies (backend):** `dj-rest-auth`, `django-allauth`,
  `djangorestframework-simplejwt` (managed with `uv`). All are standard,
  well-trodden libraries; recorded here per the SHARED.md "raise new libraries"
  rule since they extend the from-the-start auth choice rather than replace it.
- (Record further deviations/gotchas here as we build.)
