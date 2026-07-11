# Phase 7 — Self-Hosted Private Beta (home server)

**Status:** in progress — **the app is LIVE on public HTTPS** at
https://your-timeline.net (home server, 2026-07-10). 10/15 DoD items done.

> **RESUME HERE (next session).** The core is done: the site is deployed on the
> box, survives reboots, data on the NVMe, reachable from outside over HTTPS with
> a Let's Encrypt cert (verified on mobile data). **Remaining, in priority order:**
> 1. ~~Off-box backups + a tested restore~~ **DONE (2026-07-11, on the box).**
>    Nightly encrypted backups to Cloudflare R2 via `rclone crypt` are live
>    (systemd timer enabled, next run confirmed); the **tested restore passed on
>    the box with real data** — DB user counts matched and uploaded images
>    restored byte-for-byte (matching MD5s). Runbook `docs/backup-restore.md`.
> 2. **`/security-review`** and fix findings.
> 3. **ToS + privacy policy + delete-my-data / takedown path.**
> 4. Continuous deploy in CI (pull-based via GHCR — decided, see log), uptime
>    monitoring, monthly cost note.
>
> **Hard gate:** do NOT invite real friends/family until 1–3 are done.
> **Live-work reminder:** the user is new to servers — walk each box step
> one-thing-at-a-time, live; this doc records *what/why*, not keystrokes.
> Operational how-to (deploy, ops, DDNS) is in `docs/deploy.md`.

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
- [x] Server hardened: dedicated non-root user, SSH-key login (passwords off,
      root SSH off), `ufw` firewall (only 22/80/443), automatic security
      updates (on by default in 26.04)
- [x] **Docker + Compose**; a **production** compose file runs the whole stack
      and **survives a reboot** (restart policies + Docker as a system service)
      — proven 2026-07-10: hard reboot, all 3 containers auto-restarted, a
      pre-reboot post persisted (see decisions log)
- [x] Reachable **from outside the home network** at the domain over **HTTPS**
      (Let's Encrypt) — verified on mobile data, not wifi (done 2026-07-10:
      https://your-timeline.net loads + login works from a phone off wifi)
- [x] A **reverse proxy (Caddy recommended)** serves SPA + API **same-origin**
      (auto-HTTPS *and* satisfies the CSRF-cookie requirement — see below) —
      done 2026-07-10: Let's Encrypt cert obtained via HTTP-01, http→https 308
- [x] Postgres data + uploaded **media on persistent volumes**, and those
      volumes live on the **1 TB NVMe** (data disk), **not** the 250 GB SATA
      SSD that boots the OS — see decisions log below (done 2026-07-10;
      `docker volume inspect` confirms both pinned to `/srv/timeline`)
- [x] **Automated nightly backups copied OFF the PC** (DB dump *and* media) with a
      **restore that's been tested** — encrypted to Cloudflare R2 (`rclone crypt`),
      nightly systemd timer; restore verified on the box 2026-07-11 (DB counts
      matched, media restored byte-for-byte / matching MD5s)
- [x] Secrets in an env file, **not** in the repo (`.env.prod`, gitignored,
      mode 600, secrets generated on the box; done 2026-07-10)
- [x] Prod cookie hardening: `DJANGO_COOKIE_SECURE=true` +
      `CSRF_COOKIE_SECURE` / `SESSION_COOKIE_SECURE`, origin settled so the SPA
      can read `csrftoken` — done 2026-07-10 (flipped from the LAN-test `false`
      once HTTPS was live; verify login end-to-end on mobile data)
- [x] A **documented, repeatable deploy** (ship a new version to the box) —
      `deploy/deploy.sh` + runbook `docs/deploy.md` (done 2026-07-10)
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
- **Server access facts (2026-07-10).** Hostname `timeline-server`, a dedicated
  non-root admin user, LAN IP `192.168.1.95` (**router DHCP reservation set 2026-07-10** —
  Settings → Local Network → Static DHCPv4 on the Vodafone Power Hub, binding
  the box's NIC MAC → `192.168.1.95`; interface `enp3s0`). Mac connects via `ssh
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
- **Live on public HTTPS (2026-07-10).** Port-forwarded **TCP 80 + 443** only
  (Vodafone Power Hub → Static Port Mapping → `timeline-server`/192.168.1.95);
  SSH stays LAN-only. Verified port 80 open from the internet via check-host.net
  nodes (IR/NL/RS/US) *before* flipping HTTPS, so Let's Encrypt would pass first
  try. Then flipped `.env.prod` to `DJANGO_COOKIE_SECURE=true` +
  `DJANGO_CORS_ALLOWED_ORIGINS=https://your-timeline.net` (kept the LAN IP in
  ALLOWED_HOSTS for admin) and redeployed with compose defaults (no
  SITE_ADDRESS/VITE_API_URL overrides), so the SPA is rebuilt against
  `https://your-timeline.net` and Caddy serves the apex. Caddy obtained a
  Let's Encrypt cert via HTTP-01 on the first attempt (`certificate obtained
  successfully`); `https://your-timeline.net` returns 200 with a browser-trusted
  cert (issuer Let's Encrypt, ~90-day), `http→https` 308, API 401-gated, and
  port 443 confirmed open from external nodes. HSTS still off (opt-in) until the
  site is proven stable. **To roll back to a LAN test:** pass
  `SITE_ADDRESS=:80 VITE_API_URL=http://192.168.1.95` and set COOKIE_SECURE=false.
- **Dynamic DNS via Cloudflare API updater (2026-07-10).** Router DDNS
  (DynDNS/No-IP/ChangeIP/Dyn/EasyDNS/ZoneEdit) has no Cloudflare option and the
  domain is on Cloudflare, so DDNS runs on the box: `deploy/cloudflare-ddns.sh`
  (+ systemd `.service`/`.timer`, every 5 min) creates/updates the apex A record
  when the public IPv4 changes, DNS-only (grey cloud) so Caddy can do the
  Let's Encrypt HTTP challenge. Token in `/etc/timeline/cloudflare-ddns.env`
  (root:600, off-repo). **IPv6 gotcha:** the box is dual-stack, so
  `cloudflare.com/cdn-cgi/trace` first returned the *IPv6* address — pinned the
  lookup to `curl -4` since we publish an A record and port-forward IPv4. Result:
  `your-timeline.net` → the home IPv4, resolving publicly.
  Apex only for now; `www` deferred.
- **First real deploy + reboot-survival PROVEN on the box (2026-07-10).** Cloned
  the repo to `~/TimeLine`, generated `.env.prod` on the box (secrets never left
  the server; mode 600), brought the prod stack up in **LAN-test mode**
  (`SITE_ADDRESS=:80 VITE_API_URL=http://192.168.1.95`, `DJANGO_COOKIE_SECURE=false`
  — all three *temporary* for plain HTTP; flip for HTTPS). Verified SPA 200, API
  401-gated, admin 302, WhiteNoise static 200, and both data volumes pinned to
  `/srv/timeline` on the NVMe. Created the first superuser. Then hard-rebooted:
  the NVMe re-mounted via fstab, Docker (guarded by `RequiresMountsFor`)
  restarted all three containers unattended, and a post made *before* the reboot
  was still present in the DB and in the browser. Reboot-survival + NVMe
  persistence done.
- **Gotcha: box "unreachable" for ~minutes after reboot = slow DHCP, not a crash
  (2026-07-10).** After the reboot the box was un-pingable at 192.168.1.95 and no
  host on the subnet answered SSH, which *looked* like a boot failure — but the
  console showed a normal login prompt and `ip a` showed it *did* have .95; the
  network simply came up late (link/DHCP negotiation after the login prompt).
  It became reachable a few minutes later on its own. **Lesson:**
  this is the DHCP-lease instability already flagged — a lease change silently
  breaks inbound access and every diagnosis starts by chasing a "dead" box
  that's actually fine. **Fixed same session:** router DHCP reservation set
  (NIC MAC → `192.168.1.95`) so the IP is now stable before
  port-forwarding. Also note:
  don't panic-diagnose a reboot as a wipe-induced boot failure until the console
  is checked — the SATA install booted fine; the NVMe wipe was irrelevant.
- **Continuous deploy: manual first, then pull-based via GHCR (user,
  2026-07-10).** Ordering decision: build and prove a **manual, documented
  deploy** (a `deploy.sh` run on the box: `git pull` →
  `docker compose -f docker-compose.prod.yml up -d --build` → migrate) **before**
  automating — never automate a deploy you haven't run by hand. Once happy,
  automate with the **pull-based** pattern (chosen over SSH-push): GitHub Actions
  runs CI on `main`, and if green **builds + pushes an image to GHCR**; a small
  agent on the box (**Watchtower** or a systemd timer) notices the new image and
  redeploys. Chosen because the box forwards **only 80/443, not SSH** — CD must
  be **outbound from the house**, so GitHub can't SSH in. (Rejected alternative:
  Tailscale-tunnelled SSH push from Actions — cleaner/immediate but puts
  Tailscale in the deploy critical path; kept as a fallback.) Note: moving to
  GHCR is a shift from today's "box builds the images itself" — a later step,
  not needed for the manual deploy.
- **Data lives on the 1 TB NVMe, not the OS disk (user, 2026-07-10).** The OS
  boots off the small 250 GB SATA SSD (firmware can't boot NVMe — see hardware
  note); the 1 TB Samsung 980 NVMe is the **data disk**. Postgres data **and**
  uploaded media must live on the NVMe, not the OS SSD. Reasons: (1) capacity —
  real family photos will dwarf 250 GB; (2) don't fill the root/boot disk (a
  full OS disk takes the whole box down); (3) keeps data on the faster disk.
  **The catch:** the prod compose file uses Docker *named* volumes
  (`postgres_data`, `media`, …), which by default live under
  `/var/lib/docker/volumes` — i.e. on the **OS SSD**. So this doesn't happen for
  free. Plan (walked through live): partition + format the NVMe (single ext4),
  mount it at a stable path via `/etc/fstab` (mount **by UUID**, not
  `/dev/nvme…`, so it survives disk-order changes), then point the DB + media
  volumes at it — either bind-mount subdirectories of the NVMe mount, or
  `local` volumes with `driver_opts` `device=`/`o=bind` targeting NVMe paths.
  `caddy_data`/`caddy_config` are tiny (TLS certs) and can stay on the OS disk.
  **Verify before inviting anyone:** `docker inspect` the volumes and confirm
  their mountpoints resolve onto the NVMe, and that a reboot re-mounts it (so the
  stack doesn't come up writing to the OS disk because the NVMe wasn't mounted
  yet). Off-box backups (below) still cover both DB and media regardless of disk.
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
- **Backup tooling built (2026-07-11).** `deploy/backup.sh` (+ `backup.service`/
  `backup.timer`, `backup.env.example`), `deploy/restore.sh`, and runbook
  `docs/backup-restore.md`. Nightly systemd timer (03:30, mirrors the DDNS timer
  pattern): `pg_dump -Fc` from inside the `db` container (so it never needs the DB
  creds) + `rclone sync` of media, both to **Cloudflare R2** behind an **rclone
  `crypt`** remote — encrypted before leaving the house. **Destination decision:
  R2** (chosen over Backblaze B2 / self-managed) — reuses the existing Cloudflare
  account, 10 GB free + zero egress, S3-compatible so it doubles as a stepping
  stone to the Phase 7b S3 migration. **Key storage design:** media is *mirrored*
  (`sync`), not snapshotted, so off-site size ≈ live media (not × retention),
  keeping a small beta inside R2's free tier; DB dumps are tiny so ~30 dailies are
  cheap; changed/deleted files divert to a dated `media-archive/` (30-day window)
  so a local wipe can't propagate to the backup. Optional `HEALTHCHECK_URL` pinged
  only on success → a *missing* ping surfaces silent backup rot. The
  dump→createdb→`pg_restore --clean --if-exists --no-owner`→verify pipeline was
  **validated locally against real Postgres 16 + the actual app schema** (dev
  `db`); the rclone/R2/crypt layer and the mount guard are server-only.
- **Backups DONE — deployed + tested restore on the box (2026-07-11).** R2 bucket
  `timeline-backups` + a bucket-scoped Object-R&W token; `rclone crypt` remote
  configured (crypt password/salt saved off-box — losing them makes backups
  permanently undecryptable); first manual backup ran, systemd timer enabled
  (next run confirmed); healthcheck (healthchecks.io) wired. **Tested restore
  passed with real data:** restored into a scratch DB + scratch dir, DB user
  count matched live, and an uploaded photo (full + generated thumbnail)
  restored **byte-for-byte — MD5s identical** after the encrypt→R2→decrypt→restore
  round-trip. Three setup gotchas found + fixed (in code/runbook, not just on the
  box): (1) the bucket-scoped token can't `CreateBucket`, so the R2 remote needs
  **`no_check_bucket=true`** or the first upload 403s; (2) `backup.env` must be
  **chown'd to the deploy user** (the service runs as that user, not root, so a
  root-owned `600` file is unreadable); (3) the restore's scratch media dir now
  defaults under **`LOCAL_STAGE`** (deploy-user-owned) instead of directly under
  root-owned `/srv/timeline`, where the non-root `mkdir` failed.
