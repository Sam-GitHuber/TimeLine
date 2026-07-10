# Phase 7 — Self-Hosted Private Beta (home server)

**Status:** not started

> **When we start this phase, walk the user through it step by step.** They are
> new to servers/hosting and want simple, one-thing-at-a-time guidance. That
> hand-holding happens live — it is deliberately **not** written out here, to
> keep this doc short. This file records *what* and *why*, not the keystrokes.

## Goal

Get the finished app off localhost and onto a **wiped spare PC in the user's
house**, so a few close friends/family can log in over the internet (HTTPS) and
bug-test it.

This is **not** the app's final home — it's the cheap, fully reversible way to
prove the app is worth keeping before paying for cloud. If the beta goes well,
**Phase 7b** migrates all data to AWS; if it flops, nothing was spent but a
domain.

## Precondition

The full feature set (Phases 4–6) is done and the site **feels solid** — we
invite real people only once there's a genuinely good product to show them.

## Runnable product at the end of this phase

Invited friends/family visit a real HTTPS URL, log in, and use everything from
Phases 2–6 — running on the home server, surviving reboots.

## Definition of done

- [x] Old PC wiped, running **Ubuntu Server LTS** (Ubuntu 26.04 LTS on the
      250 GB SATA SSD — see hardware note below)
- [x] Server hardened: non-root user (`sam`), SSH-key login (passwords off,
      root SSH off), `ufw` firewall (only 22/80/443), automatic security
      updates (on by default in 26.04)
- [ ] **Docker + Compose**; a **production** compose file runs the whole stack
      and **survives a reboot** (restart policies + Docker as a system service)
- [ ] Reachable **from outside the home network** at the domain over **HTTPS**
      (Let's Encrypt) — verified on mobile data, not wifi
- [ ] A **reverse proxy (Caddy recommended)** serves SPA + API **same-origin**
      (auto-HTTPS *and* satisfies the CSRF-cookie requirement — see below)
- [ ] Postgres data + uploaded **media on persistent volumes**
- [ ] **Automated nightly backups copied OFF the PC** (DB dump *and* media) with a
      **restore that's been tested**
- [ ] Secrets in an env file, **not** in the repo
- [ ] Prod cookie hardening: `DJANGO_COOKIE_SECURE=true` +
      `CSRF_COOKIE_SECURE` / `SESSION_COOKIE_SECURE`, origin settled so the SPA
      can read `csrftoken`
- [ ] A **documented, repeatable deploy** (ship a new version to the box)
- [ ] A **continuous deploy added to CI**
- [ ] Basic **uptime monitoring** + alert
- [ ] **Terms of Service + privacy policy** published; content-takedown +
      delete-my-data path exists (see Legal / IP in `docs/SHARED.md`)
- [ ] `/security-review` run and findings addressed
- [ ] Rough **monthly running cost** written down

## Steps (high level — details walked through live)

1. Wipe the PC; install Ubuntu Server LTS.
2. Harden the box **before** it's internet-facing (user, SSH keys, firewall,
   auto-updates).
3. Install Docker/Compose; get the code + a production env file onto the box.
4. Add a production compose file with a **Caddy** reverse proxy (auto-HTTPS,
   same-origin).
5. Point the domain via **dynamic DNS**; forward router ports 80/443 to the PC.
6. Bring the stack up; prove it works **from outside** (mobile data).
7. Set up off-box backups and **test a restore**.
8. Add uptime monitoring.
9. Publish ToS/privacy; run `/security-review`.
10. Invite 2–3 close testers; bug-bash; iterate. Then → Phase 7b.

## Security notes

Internet-facing with real data now. Cover HTTPS everywhere, hardened cookies,
least-privilege DB access, no secrets in the repo, patched OS/deps.

- **Port-forwarding exposes the home IP (accepted trade-off).** User chose
  port-forwarding + DDNS over a Cloudflare Tunnel. Consequences to manage:
  - Turn on WHOIS privacy; the domain resolves to the home's public IP.
  - Forward **only 80/443** — never SSH (22) or Postgres. Admin over SSH on the
    LAN (or a VPN like Tailscale), not a forwarded port.
  - **If the ISP uses CGNAT**, inbound port-forwarding won't work — check early.
    Fallback that needs no port-forward and hides the home IP: a **Cloudflare
    Tunnel**.
- **CSRF cookie must be readable by the SPA (from the Phase 2 review).** The
  frontend reads the non-httpOnly `csrftoken` cookie and echoes it in
  `X-CSRFToken`. In prod that needs either **same-origin** serving (Caddy in
  front of SPA + API — why the reverse proxy is in the DoD), or **split
  subdomains** with `CSRF_COOKIE_DOMAIN`/JWT cookie domain on the shared parent
  and exact `CSRF_TRUSTED_ORIGINS`/`CORS_ALLOWED_ORIGINS`. Miss it and every
  authenticated mutation 403s.
- **Optional:** stop returning the access token in the login response body
  (dj-rest-auth includes it though we rely only on the httpOnly cookie). Low
  priority — see phase-2 notes.

## Notes / decisions log

- **Server hardware + boot gotcha (2026-07-10).** The repurposed spare PC is an
  **ASUS** box with **two SSDs**: a 250 GB Samsung 840 EVO (SATA) and a 1 TB
  Samsung 980 (**NVMe**). The **motherboard firmware cannot boot from NVMe** — the
  980 never appears anywhere in the BIOS (no NVMe config section at all), even with
  CSM disabled. Linux *uses* the NVMe fine once running; the firmware just can't
  *start* from it. Symptom was three installs that completed but produced no
  `ubuntu` boot entry. **Resolution: OS on the 250 GB SATA SSD** (the only bootable
  disk; Windows on it was wiped), **1 TB NVMe reserved for data/media** — not yet
  partitioned/mounted (a later step). Also: the install must be **UEFI** (CSM
  **disabled**) — a CSM/legacy install produced a non-bootable drive. Verify UEFI by
  the presence of a `/boot/efi` (EFI System Partition) at the storage-summary step.
- **Server access facts (2026-07-10).** Hostname `timeline-server`, admin user
  `sam`, current LAN IP `192.168.1.95` (**DHCP lease — still needs a router
  reservation for stability before port-forwarding**). Mac connects via `ssh
  timeline-server` (ed25519 key, passphrase in macOS Keychain; `~/.ssh/config`
  alias). Guided-LVM "100 GB quirk" hit again — root LV expanded to fill the disk.
- **Production stack built (2026-07-10).** Added alongside the dev stack (dev
  untouched): `docker-compose.prod.yml` (project name `timeline-prod` so its
  volumes can't collide with dev's), a **Caddy** `web` service (`deploy/Caddyfile`
  + `deploy/web.Dockerfile`) that builds the SPA and serves it **same-origin** with
  the API (auto-HTTPS via `SITE_ADDRESS`), backend on **gunicorn** + **WhiteNoise**
  (`backend/entrypoint.prod.sh`: migrate → collectstatic → gunicorn), and prod
  security settings in `settings.py` (secure cookies, `SECURE_PROXY_SSL_HEADER`,
  opt-in HSTS) — all gated so dev/CI (DEBUG on / DEBUG-off-in-tests) are unaffected.
  Persistent volumes: `postgres_data`, `media`, `caddy_data/config`. Secrets in
  `.env.prod` (gitignored; template `.env.prod.example`). **Verified end-to-end
  locally** (SPA, API 401-gating, admin, WhiteNoise static, CSRF `Secure` cookie,
  security headers) and full 167-test backend suite green with prod settings.
  **LAN-test mode**: `SITE_ADDRESS=:80 VITE_API_URL=http://<ip>` for a first run
  before DNS/HTTPS. Still to do on the box: deploy key + clone, real `.env.prod`,
  bring up, prove reboot-survival, then DNS/DDNS + port-forward + external test.
- **Two-step productionisation (user, 2026-07-05).** Self-host the finished app
  at home first for a cheap, reversible friends/family beta; migrate to AWS
  (Phase 7b) only once proven. Known cost: a one-time home→cloud data migration,
  deliberately accepted and de-risked (see Phase 7b).
- **Exposure = port-forwarding + dynamic DNS (user, 2026-07-05).** Chosen over a
  Cloudflare Tunnel; home-IP-exposure + CGNAT caveats above, Cloudflare Tunnel is
  the documented fallback.
- **CGNAT check PASSED (2026-07-09).** Public IP (as seen by the internet) ==
  router WAN IP, so no carrier-grade NAT — inbound port-forwarding is viable, the
  port-forward + DDNS plan stands, Cloudflare Tunnel fallback not needed. (Home IP
  is dynamic, hence DDNS.)
- **Photos on the PC's local disk this phase (user, 2026-07-05).** No paid cloud
  storage until proven; media on a persistent volume with off-box backups, moves
  to S3 in Phase 7b. **The media folder must be in the off-box backup** — one
  aging PC is a single point of failure holding real family photos.
- **Off-box backups are non-negotiable.** Nightly DB dump + media archive to a
  second device/cloud drive, restore tested once. Also what makes 7b low-risk.
- **Domain: `your-timeline.net` — PURCHASED (user, 2026-07-09) via Cloudflare
  Registrar.** Bare `timeline.me` (the earlier chosen candidate) was taken by
  purchase time, so `your-timeline.net` was registered instead — reputable
  classic TLD, reads as "*your* timeline." Bought through Cloudflare (at-cost, no
  upsells), with auto-renew + free WHOIS privacy on (WHOIS privacy matters:
  domain will resolve to the home public IP). All Caddy / DDNS config targets
  `your-timeline.net`.
- **Reverse proxy: Caddy (recommended)** for tiny-config auto-HTTPS + same-origin
  serving; nginx + certbot is the manual alternative.
