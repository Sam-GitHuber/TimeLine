# Phase 5 — Productionisation & Private Deploy

**Status:** not started

## Goal

Get TimeLine off localhost and onto a real, private URL that invited
friends/family can actually use, hosted cheaply on **AWS Lightsail** (see
`docs/SHARED.md`). This is the phase that turns a local project into a running
service — with the security, reliability, and cost basics that entails.

## Runnable product at the end of this phase

Friends/family can visit a real URL (over HTTPS), log in, and use everything
built in Phases 2–4 — on a server that isn't your laptop, and that survives a
reboot.

## Definition of done

- [ ] App deployed to AWS Lightsail (Container Service or a Lightsail
      instance running Docker Compose — decide and document)
- [ ] Reachable at a real domain over **HTTPS** (valid TLS certificate)
- [ ] Postgres runs in a persistent, backed-up way (managed DB or a
      volume-backed container with a backup routine) — data must survive
      restarts and be recoverable
- [ ] Secrets (DB password, app secret key) come from environment/secret config,
      never committed to the repo
- [ ] Auth/CSRF cookies hardened for production: `DJANGO_COOKIE_SECURE=true`
      (JWT cookie) **and** `CSRF_COOKIE_SECURE`/`SESSION_COOKIE_SECURE` on, plus
      the frontend↔backend **origin topology** settled so the `csrftoken` cookie
      is readable by the SPA (see the CSRF cookie-domain note below)
- [ ] A documented, repeatable deploy process (how to ship a new version)
- [ ] Automated database backups with a tested restore
- [ ] Basic monitoring: know if the site is down
- [ ] Confirmed monthly cost estimate written down (feeds the funding phase)

## Steps

1. Choose the Lightsail deployment shape (Container Service vs. instance +
   Compose) and document the reasoning + cost.
2. Set up the production Postgres (managed vs. self-hosted) and backups.
3. Register/point a domain; set up HTTPS/TLS.
4. Move all secrets to environment/secret configuration.
5. Write the deploy runbook (build image → push → release).
6. Add uptime monitoring and a simple alert.
7. Do a full dry run: deploy, invite one real tester, fix what breaks.

## Security notes

This is the big security step — the app is now internet-facing with real data.
Cover at least: HTTPS everywhere, hardened auth cookies/tokens, least-privilege
DB access, no secrets in the repo, and keeping dependencies patched. Do a
`/security-review` before inviting real users.

- **CSRF cookie must be readable by the SPA (carried over from the Phase 2
  code review).** Our cookie-JWT flow has the frontend read the non-httpOnly
  `csrftoken` cookie and echo it in `X-CSRFToken` on mutating requests. In dev
  this works because everything is `localhost` (cookies are shared across
  ports). In production it only works if the SPA can actually read that cookie:
  - **Same-origin** (serve the API and the built SPA behind one domain via a
    reverse proxy) — simplest, nothing extra needed; **preferred**. Or
  - **Split subdomains** (e.g. `app.` + `api.example.com`) — then set
    `CSRF_COOKIE_DOMAIN` (and the JWT cookie domain) to the shared parent
    `.example.com`, and keep `CSRF_TRUSTED_ORIGINS`/`CORS_ALLOWED_ORIGINS`
    exact. Miss this and every authenticated mutation (logout, posting) fails
    CSRF with a 403.
- **Optionally stop returning the access token in the login response body.**
  dj-rest-auth includes it in the JSON even though we rely solely on the
  httpOnly cookie; overriding the login response to strip it removes the last
  place page JS can see a token. Low priority (see phase-2 notes).

## Notes / decisions log

(Record deviations/gotchas here.)
