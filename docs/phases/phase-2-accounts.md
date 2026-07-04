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

## Security notes

This is the first phase holding real credentials. Be explicit about: HTTPS in
production (Phase 5), secure cookie/token settings, and not logging secrets.
Flag anything that weakens account security even for a "small private app."

## Notes / decisions log

(Record deviations/gotchas here.)
