# Phase 2 — Accounts & Authentication

**Status:** not started

## Goal

Real user accounts stored in Postgres, with sign-up / log-in / log-out, using
Django's built-in auth plus token auth for the API (do **not** hand-roll
password hashing, sessions, or tokens — see `docs/SHARED.md`). The wireframe
from Phase 1 gets wired to know "who is logged in."

## Runnable product at the end of this phase

A person can, in the running app:
- Create an account (email + password).
- Log in and log out.
- See a page that only works when logged in (e.g. the feed), and get bounced
  to a login screen when logged out.

## Definition of done

- [ ] Django `User` model in use (built-in or a lightweight custom user),
      migrated into Postgres
- [ ] Passwords are hashed by Django (never stored in plain text)
- [ ] API endpoints for register / login / logout / "who am I" (via
      `dj-rest-auth`/`djoser` or DRF token auth)
- [ ] The user is visible/manageable in the Django admin
- [ ] Frontend has login and sign-up forms wired to those endpoints
- [ ] Logged-in state persists across page refresh
- [ ] Protected pages redirect to login when not authenticated
- [ ] At this small/private stage, sign-up can be gated (e.g. invite-only or
      manually approved via the admin) so it isn't open to the public — decide
      and document which
- [ ] **Automated tests exist and run in CI** (first real test suite — see
      "Testing & CI" below):
  - [ ] Backend auth tests: register, login, logout, "who am I", and that a
        protected endpoint rejects unauthenticated requests
  - [ ] Settings hardening test carried over from Phase 0: with `DEBUG` off and
        no `DJANGO_SECRET_KEY`, the app refuses to boot (`ImproperlyConfigured`);
        with `DEBUG` on it falls back to the dev key
  - [ ] Frontend test(s) for the login/auth flow (Vitest)
  - [ ] `.github/workflows/main.yml` runs these on every push/PR, replacing the
        Phase 0 placeholder job
  - [ ] Branch protection on `main` updated to require the new CI job name(s)
        instead of `placeholder`

## Steps

1. Configure Django's database settings to point at the Postgres container.
2. Decide built-in `User` vs. a custom user model (do this *now* if at all —
   it's painful to change later), and run migrations to create the user table.
3. Add the API auth layer (`dj-rest-auth`/`djoser` or DRF tokens): register /
   login / logout / current-user endpoints.
4. Register the user in the Django admin and create a superuser.
5. Build frontend login + sign-up forms and an auth state (e.g. React context).
6. Add route protection on the frontend and matching auth checks on the backend.
7. Decide how sign-up is restricted while private (invite/approval) and document
   it here.
8. **Stand up the real test suite and wire it into CI** (see below).

## Testing & CI

Phase 2 is where automated testing starts for real — Phase 0 deliberately left
CI as a passing placeholder because there was nothing to test yet. From here on,
every phase ships tests alongside its features.

- **Backend:** Django's built-in test runner (or `pytest-django`). Cover the
  auth surface: register / login / logout / current-user, and that protected
  endpoints reject unauthenticated requests. Fold in the **Phase 0 settings
  hardening** as a regression test — assert that `DEBUG=False` with no
  `DJANGO_SECRET_KEY` raises `ImproperlyConfigured`, and that `DEBUG=True`
  falls back to the dev key (guards `backend/config/settings.py`).
- **Frontend:** Vitest for the login/sign-up flow and auth-state behaviour.
- **CI:** replace the placeholder job in `.github/workflows/main.yml` with real
  jobs, e.g.
  - backend: `uv sync` then `python manage.py test` (spin up a Postgres service
    container, or use SQLite for the test DB — decide and document)
  - frontend: `npm ci` then `npm test`
- **Branch protection gotcha:** the required status check on `main` is currently
  named `placeholder` (the job id). When the CI jobs are renamed here, the
  required-check list must be updated or PRs will hang waiting on a check that
  no longer runs. Update it with:
  `gh api --method PUT repos/Sam-GitHuber/TimeLine/branches/main/protection`
  (set `required_status_checks.contexts` to the new job name(s)).

## Security notes

This is the first phase holding real credentials. Be explicit about: HTTPS in
production (Phase 5), secure cookie/token settings, and not logging secrets.
Flag anything that weakens account security even for a "small private app."

## Notes / decisions log

(Record deviations/gotchas here.)
