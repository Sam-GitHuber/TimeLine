# Phase 7b — Migrate to AWS Lightsail

**Status:** not started

> **When we start this phase, walk the user through it step by step.** They are
> new to hosting/cloud and want simple, one-thing-at-a-time guidance. That
> hand-holding happens live — deliberately **not** written out here, to keep this
> doc short. This file records *what* and *why*, not the keystrokes.

## Goal

Once the home-server beta (Phase 7) has proven the app worth keeping, move
**everything** — the app *and* all real data people created (accounts, posts,
comments, photos) — from the home PC to **AWS Lightsail**, with **no data loss**
and minimal downtime.

The core promise: **nobody loses anything.** Everything from the beta comes
across intact.

## Precondition

Phase 7 ran, feedback was good enough to commit to paid hosting, and the tested
off-box backups from Phase 7 exist (the safety net for the migration).

## Runnable product at the end of this phase

The same app, at the same URL, over HTTPS — now on AWS, always-on, with all beta
data present. The home server can be switched off and wiped.

## How it's kept safe

Move the **database** (accounts/posts/comments) and the **media** (photos)
separately: photos go to an S3-compatible bucket (moved once, never again), the
DB is dumped and restored, both are verified, then DNS flips — with the home
server left running as an instant rollback until AWS is proven.

## Definition of done

- [ ] AWS Lightsail provisioned + documented (**instance + Docker Compose** vs.
      **Container Service** — decide, note why + cost)
- [ ] Production Postgres on AWS (**managed Lightsail DB** vs. self-hosted
      container + backups — decide, document)
- [ ] **Media moved to S3-compatible object storage** via `django-storages`; all
      existing beta photos uploaded
- [ ] **Data migration verified:** DB restored on AWS with **row counts matching**
      the source (users/posts/comments), and **every beta photo loads** on the
      live site
- [ ] Domain **cut over** to AWS; HTTPS valid; login + feed + photos all work
- [ ] **Rollback kept during cutover:** home server left running, DNS TTL lowered
      ahead of time
- [ ] Backups on AWS with a **tested restore**
- [ ] Uptime monitoring re-pointed at AWS
- [ ] Secrets from AWS env/secret config, never the repo
- [ ] Home server **decommissioned only after** AWS is verified stable (a few days
      on standby first)
- [ ] Updated **monthly cost estimate** written down (feeds funding, Phase 10)

## Steps (high level — details walked through live)

1. Stand up an empty stack on Lightsail; prove the deploy shape before any data
   moves.
2. Switch media storage to an S3 bucket; upload the beta's media folder.
3. Rehearse the migration: dump the home DB, restore to AWS, spot-check.
4. Real cutover: lower DNS TTL a day ahead, brief maintenance/read-only, final
   dump + restore, sync new photos, verify counts + photos load.
5. Flip DNS to AWS; confirm everything works for an external visitor.
6. Watch with the home server on standby (rollback); once stable, retire + wipe
   the old PC.

## Notes / decisions log

- **This migration is the accepted cost of the home-first plan (Phase 7).** Kept
  low-risk by: moving media to S3 so photos never move again, rehearsing the
  migration, and keeping the home box as a live rollback during cutover.
- **Phase 4 builds storage through `django-storages`** precisely so switching to
  an S3 bucket here is a **config change, not a rewrite**.
- **Managed DB vs. self-hosted Postgres — decide at the start.** For real family
  data, lean managed (automatic backups/patching) unless cost is tight.
- **Same-origin serving still applies** (reverse proxy in front of SPA + API) so
  the CSRF-cookie flow keeps working — carry over the Phase 7 security notes.
- **Confirm the monthly cost here** — the number that feeds the Phase 10 funding
  conversation.
