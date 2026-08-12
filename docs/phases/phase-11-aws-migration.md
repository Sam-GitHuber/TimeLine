# Phase 11 — Migrate to AWS Lightsail

**Status:** planned, not started

> **When we start this phase, walk the user through it step by step.** They are
> new to hosting/cloud and want simple, one-thing-at-a-time guidance. That
> hand-holding happens live — deliberately **not** written out here, to keep this
> doc about *what* and *why*, not keystrokes.

## Goal

Move **everything** — the app and all real data people created (accounts, posts,
comments, photos, messages) — from the home PC to **AWS Lightsail**, with **no
data loss** and minimal downtime.

The core promise: **nobody loses anything.**

## Why this is happening now (changed 2026-08-12)

The original trigger was "the beta proved the app worth paying for". That still
holds, but a second, harder trigger arrived: **the new ISP (Toob) puts the house
behind CGNAT.**

`tracepath` from the box shows hop 1 `192.168.1.1`, hop 2 `100.127.240.247` —
inside `100.64.0.0/10`, the RFC 6598 carrier-grade NAT range. The public address
`145.40.156.204` that DNS returns is Toob's *shared* outer NAT address, not the
house. **No port-forward can ever work**, because inbound traffic never reaches
the Linksys in the first place. The site is currently down for this reason and
this reason alone — the box, the containers and the certificate are all healthy
(`--resolve your-timeline.net:443:127.0.0.1` returns 200 on both `/` and
`/api/healthz/`).

The alternative was a Cloudflare Tunnel. That is a day of work that Phase 11
throws away anyway, so the migration wins on effort as well as on merit. A
Lightsail static IP fixes the problem permanently.

**This means the home server can no longer act as a public rollback target.** See
*Rollback* below — the original plan's escape hatch is gone and is replaced.

## Precondition

Tested off-box backups exist (Phase 7, `deploy/backup.sh` → encrypted rclone
remote on Cloudflare R2, covering **both** the `pg_dump` and the whole media
tree). These are the safety net for the migration and they already work.

## Runnable product at the end of this phase

The same app, at the same URL, over HTTPS — now on AWS, always-on, with all beta
data present, reachable from anywhere without touching a router. The home server
can be switched off and wiped.

## What we are actually moving (measured 2026-08-12)

| | Size |
|---|---|
| Postgres database | **13 MB** |
| Media (post photos, avatars, chat photos) | **39 MB**, 112 files |
| Busiest table | 272 rows (`api_message`) |

This is small enough that the whole cutover is minutes, not a maintenance
window. Sizing and risk decisions below all follow from that.

## Cost — settled

| Line | Monthly |
|---|---|
| Lightsail instance, 2 GB RAM / 2 vCPU / 60 GB SSD / 3 TB transfer | $12 |
| Automatic snapshots (~12 GB used) | ~$0.60 |
| **Total** | **≈ $13 / £13 inc. VAT** |

Confirmed acceptable by the user on 2026-08-12. Notes:

- **Self-hosted Postgres in a container, not a Lightsail managed DB.** Managed
  adds $15/mo (nearly doubling the bill) for automated backups and patching we
  already have via `deploy/backup.sh` + unattended-upgrades. Revisit if the user
  base grows beyond friends and family.
- **2 GB, not the $7 1 GB tier.** The box uses ~960 MB today so 1 GB would
  *probably* run it, but a Docker image build or a migration in 1 GB is where
  things get OOM-killed at the worst moment. Lightsail resizes later if needed.
- The 3 TB transfer allowance is thousands of times current traffic.
- **Set an AWS budget alert on day one** (see M1). First-time AWS accounts are
  where surprise bills happen; Lightsail itself is fixed-price, but a stray S3 or
  data-transfer charge should page us, not appear on a statement.

## Decisions settled up front

- **Region `eu-west-2` (London).** Latency for UK friends and family, and it
  keeps real personal data in the UK, which matches the privacy-first principle
  and keeps the privacy policy honest. Do not default to `us-east-1`.
- **Lightsail instance + Docker Compose**, not Lightsail Container Service. The
  stack is already Compose; this is a lift-and-shift, and Container Service costs
  more and would need the deploy shape rewritten.
- **Keep backups on Cloudflare R2, not in AWS.** Backups belong with a *different*
  provider than the thing they protect — an AWS account problem shouldn't take
  the backups with it. R2 is already set up, encrypted and tested.
- **Retire the Cloudflare DDNS timer.** A static IP makes
  `deploy/cloudflare-ddns.{sh,service,timer}` dead weight; delete the units and
  set the A record by hand, once. One fewer moving part.
- **Keep the pull-based autodeploy** (systemd timer polling GHCR). It works, and
  it avoids giving CI any credentials that can reach production.
- **Carry over the other timers unchanged:** `backup`, `token-flush`,
  `send-pushes`, `timeline-healthcheck`.

## Open decisions — need the user's call before the relevant milestone

### 1. How to reach the Django admin on AWS (needed before M2)

`deploy/Caddyfile` restricts `/admin/` to `127.0.0.1/8 ::1 10.0.0.0/8
192.168.0.0/16` and 403s everyone else. **On AWS there is no LAN, so that
allow-list matches nothing and the admin becomes unreachable from anywhere.**

Note an SSH tunnel does *not* trivially fix this: host-loopback traffic to a
published Docker port arrives at Caddy as the bridge gateway `172.18.0.1`
(observed in the access log on 2026-08-12), which is deliberately excluded.

Options:

- **(a) Drop the web admin in production; use `manage.py` over SSH.** Most
  secure — the highest-value credential in the system stops having a login form
  on the public internet at all. Least convenient. *Recommended.*
- **(b) SSH tunnel straight to gunicorn**, bypassing Caddy (`ssh -L` to the
  backend container's port). Keeps the web admin, keeps Caddy's public 403, and
  SSH key auth becomes the gate. Needs `DJANGO_ALLOWED_HOSTS` to accept
  `localhost`. *Good middle ground.*
- **(c) Put the box on a WireGuard/Tailscale network and allow that range.**
  Reconstitutes a "LAN". Cleanest UX, one more service to run.
- **(d) Add `172.18.0.1/32` to the allow-list.** **Do not do this.** It converts
  a deliberately fail-closed design into a fail-open one: if Docker's userland
  proxy ever SNATs published-port traffic, the whole internet arrives as
  `172.18.0.1` and the admin login is exposed. The Caddyfile comment calls this
  exact trap out.

### 2. Whether media really moves to S3 (needed before M3)

The original definition of done says move media to an S3 bucket so photos "move
once, never again". Having read the code, **that is a bigger change than it
looks, and it weakens a security property.**

Today `/media/*` is gated by Caddy `forward_auth` → `/api/media-auth/`: the
backend authorises **every single request**, so a leaked URL is useless to a
logged-out stranger and a banned member's saved URLs stop working immediately.
Switching to S3 with `querystring_auth` signed URLs (already scaffolded in
`backend/config/settings.py:235`) replaces that with **a signed URL that stays
valid for its whole lifetime regardless of what happens to the account behind
it.** It would also change every media URL on every page load, which is likely
to break client-side image caching on web and in the mobile app.

Options:

- **(a) Keep media on the instance disk, as now.** 39 MB. Already backed up
  encrypted to R2 and covered by instance snapshots. Keeps live authorisation
  and per-request revocation. Zero code change, zero new failure modes.
  *Recommended — revisit when media passes a few GB.*
- **(b) Move to S3 with short-lived signed URLs.** Delivers the "never move
  again" goal; costs the revocation property and needs cache behaviour tested on
  both clients. If chosen, signed-URL lifetime must be short (~5 min) and M3
  grows a real client-side testing step.

Note (b) also reintroduces variable cost (S3 egress is billed per GB), which is
in tension with the fixed-price rationale for choosing Lightsail.

## Rollback — reworked, because the old plan no longer works

The original plan kept the home server serving publicly and rolled back by
flipping DNS. **CGNAT killed that.** The replacement:

1. **Nothing is deleted from the home box** until AWS has run stable for a week.
   It stays powered on and intact — just not publicly reachable.
2. The **pre-cutover dump is kept in three places**: on the home box, in R2, and
   downloaded locally.
3. Rollback within the cutover window = **restore the pre-cutover dump onto the
   AWS instance** (fast: 13 MB) and fix forward. This is the realistic path and
   it must be **rehearsed in M4 before the real cutover**, not improvised.
4. **Lower the DNS TTL to 60s a day ahead** so DNS is never the thing that's slow.
5. If AWS is unrecoverable, the home box can be restored to service only by
   also solving CGNAT (Cloudflare Tunnel) — hours, not minutes. Treat this as
   disaster recovery, not rollback, and accept it.

## Definition of done

- [ ] Lightsail instance provisioned in `eu-west-2`, documented, **budget alert set**
- [ ] Static IP allocated and attached; DNS A record points at it (**grey cloud**,
      not Proxied — Caddy needs a direct connection for Let's Encrypt)
- [ ] Production Postgres running as a container with `deploy/backup.sh` proven
      on AWS
- [ ] Media decision (open decision 2) implemented and documented
- [ ] Admin access decision (open decision 1) implemented and documented; `/admin/`
      verified **403 from the public internet**
- [ ] **Data migration verified:** row counts match the source for users, posts,
      comments and messages, and **every beta photo loads** on the live site
- [ ] Domain cut over; HTTPS valid; login, feed, photos, messaging, push all work
- [ ] **Rollback rehearsed** (restore pre-cutover dump onto AWS) before real cutover
- [ ] Backups running on AWS to R2 with a **tested restore**
- [ ] Uptime monitoring (healthchecks.io) re-pointed at AWS
- [ ] Mobile app verified against the new host (push included)
- [ ] Secrets from env/secret config on the instance, never the repo
- [ ] DDNS units removed; `docs/deploy.md` rewritten for AWS, including the
      correction that **this ISP does use CGNAT** (the current note at ~line 655
      says it doesn't — true of the old ISP only)
- [ ] Home server decommissioned only after a week of stable AWS operation
- [ ] Final monthly cost written down (feeds Phase 12 funding)

## Milestones

**M1 — Account and instance.** AWS account, billing alert, Lightsail instance in
`eu-west-2`, static IP, SSH key, unattended-upgrades, firewall limited to 22/80/443.
Nothing app-related yet.

**M2 — Empty stack.** Docker + Compose, clone the repo, GHCR pull, bring the
stack up on a **temporary hostname** with a throwaway DNS record so Let's
Encrypt works without touching the live domain. Implement the admin decision.
Prove the deploy shape before any real data moves.

**M3 — Media.** Implement the media decision. If S3: bucket, `django-storages`
env vars, upload the 112 files, verify signed URLs on web *and* mobile. If disk:
confirm the volume and `forward_auth` behave identically on AWS.

**M4 — Migration rehearsal.** Dump the home DB, restore to AWS, sync media,
compare row counts, click through the app on the temporary hostname. **Then
rehearse the rollback restore.** Throw the data away and repeat until clean.

**M5 — Cutover.** Lower DNS TTL a day ahead. Brief read-only/maintenance window,
final dump, restore, final media sync, verify counts and photos, flip DNS to the
static IP, confirm as an external visitor on mobile data.

**M6 — Watch and retire.** Monitoring re-pointed, backups verified on AWS, a
week of stability, mobile app checked, then power off and wipe the home PC.
Distil this file into `docs/reference/` and delete it.

## Notes / decisions log

- **CGNAT forced the timing** (2026-08-12). The phase was always planned; the ISP
  change turned it from "when the beta proves itself" into "the only way back
  online without throwaway work".
- **Phase 4 built storage through `django-storages`** precisely so an S3 switch
  would be config, not a rewrite — and it is. The open question in decision 2 is
  not *can we*, it's *should we*, and the answer turns on the `forward_auth`
  revocation property rather than on effort.
- **Same-origin serving still applies** (one Caddy in front of SPA + API) so the
  CSRF cookie flow keeps working. Carry the Phase 7 security notes over intact.
- **The `/admin/` allow-list is the single most important thing not to get wrong
  in this migration.** It is currently fail-closed by design; every option in
  decision 1 except (d) preserves that. Verify with a real request from mobile
  data after cutover, not by reading the config.
