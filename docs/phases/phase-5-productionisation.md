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

## Notes / decisions log

(Record deviations/gotchas here.)
