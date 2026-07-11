# Phase 7 — Self-Hosted Private Beta (home server)

**Status:** in progress — **the app is LIVE on public HTTPS** at
https://your-timeline.net (home server, 2026-07-10). 12/15 DoD items live. The
last hard-gate item (ToS + privacy + delete-my-data + takedown) **merged (#44)
and deployed to the box 2026-07-11** — migrations applied, `/terms` + `/privacy`
serving 200 over HTTPS. **The hard gate is now closed** (real invites unblocked).

> **RESUME HERE (next session).** The core is done: the site is deployed on the
> box, survives reboots, data on the NVMe, reachable from outside over HTTPS with
> a Let's Encrypt cert (verified on mobile data). **Remaining, in priority order:**
> 1. ~~Off-box backups + a tested restore~~ **DONE (2026-07-11, on the box).**
>    Nightly encrypted backups to Cloudflare R2 via `rclone crypt` are live
>    (systemd timer enabled, next run confirmed); the **tested restore passed on
>    the box with real data** — DB user counts matched and uploaded images
>    restored byte-for-byte (matching MD5s). Runbook `docs/backup-restore.md`.
> 2. **`/security-review`** — DONE + VERIFIED ON BOX (2026-07-11). Review run, no
>    HIGH; three gaps fixed (#42) and deployed: auth-gated media (Caddy
>    `forward_auth`), LAN-only admin, sign-up enumeration hardening. On-box checks
>    all passed — see decisions log. DoD box ticked.
> 3. **ToS + privacy policy + delete-my-data / takedown path** — **DONE +
>    DEPLOYED ON BOX (2026-07-11, #44).** Merged to main and deployed via
>    `deploy.sh`; migrations `accounts.0003_user_tos_accepted_at` +
>    `api.0010_report` applied, static recollected, `/terms` + `/privacy` return
>    200 over public HTTPS. What shipped: public `/terms` + `/privacy` pages
>    (UK/UK-GDPR, linked from sign-up + footer), a required consent checkbox
>    recording `tos_accepted_at`, a password-reconfirmed **hard-delete** account
>    endpoint (cleans media files off disk, hands sole-admin groups to the
>    longest-standing member, deletes emptied groups), and an in-app **Report**
>    control → `Report` model reviewed in Django admin. See decisions log +
>    `docs/deploy.md` (handling reports & deletions). **DoD box ticked; hard gate
>    closed.**
> 4. **Continuous deploy** — IN PROGRESS. Trigger: **GitHub release published**
>    (not every merge). Pull-based via GHCR (decided, see log): the release
>    workflow builds + pushes the images; a systemd timer on the box notices the
>    new image and redeploys — outbound-only, since the box exposes 80/443, not
>    SSH. Then: uptime monitoring, monthly cost note.
>
> **Hard gate:** CLOSED (2026-07-11) — items 1–3 all done + live on the box. Real
> friends/family can now be invited.
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
- [x] **Terms of Service + privacy policy** published; content-takedown +
      delete-my-data path exists (see Legal / IP in `docs/SHARED.md`)
      — merged (#44) + deployed to the box 2026-07-11; `/terms` + `/privacy`
      serve 200 over HTTPS, delete-account + Report live. See decisions log.
- [x] `/security-review` run and findings addressed (2026-07-11: no HIGH; media
      auth-gating, LAN-only admin, sign-up enumeration fix — deployed + verified on
      the box, see decisions log)
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

- **Phone-photo upload cap raised 10 MB → 30 MB (2026-07-12, issue #40, branch
  `fix-40-phone-photo-size-cap`).** Real friends/family on modern iPhones/Androids
  were hitting "Image is too large (max 10 MB)" on ordinary camera-roll photos,
  which killed the intended "up to 10 photos per post" flow. The key insight:
  `MAX_UPLOAD_BYTES` in `api/imaging.py` is a **DoS/memory guard** (stop a client
  streaming an unbounded file into Pillow), **not a storage limit** — every
  accepted photo is already downscaled to 2048px + re-encoded at JPEG q85, so the
  *stored* file is well under 1 MB regardless of input size. So the fix is just to
  raise the input ceiling to a phone-realistic 30 MB and let compression handle
  actual storage/bandwidth. Verified no other layer blocks it: **Caddy** sets no
  `request_body max_size` (unlimited body), and **Django** file uploads bypass
  `DATA_UPLOAD_MAX_MEMORY_SIZE` (streamed to a temp file), so no settings change
  was needed. Also made the per-file error name the offending photo
  (`PostCreateView`) so a bad file in a batch of 10 isn't opaque. HEIC transcode
  is the separate issue #41 (needs `pillow-heif`/`libheif` — a stack decision).

- **ToS/privacy + delete-my-data + takedown built (2026-07-11, branch
  `phase-7-legal-delete`).** The last hard-gate item before real invites. Four
  user-confirmed decisions drove it:
  - **Jurisdiction: UK / UK-GDPR.** Documents written for England & Wales
    governing law and UK GDPR / DPA 2018 (matches the repo's British spelling and
    the home server's location). Data-controller contact is the maintainer's
    email for now (`samejefford@gmail.com`) — swap for a role address later.
    They're good-faith plain-English drafts, **not legal advice**; worth a
    solicitor's eyes before any *broad/public* launch (proportionate to skip for
    a private invite-only family beta). Single source of truth: the React page
    components at `/terms` and `/privacy` (public routes, so reachable from
    sign-up before login; also linked from an in-app footer).
  - **Consent: required + recorded.** Sign-up now has a mandatory "I agree to the
    Terms + Privacy Policy" checkbox (blocks submit) and stamps
    `User.tos_accepted_at` — a defensible consent record. Enforced server-side in
    `CustomRegisterSerializer` (a missing/false `accept_terms` is a 400), so it
    can't be bypassed by hitting the API directly.
  - **Deletion: hard delete.** `POST /api/account/delete/`, **password-
    reconfirmed** (irreversible action ⇒ re-auth, like the bank-transfer
    pattern). `delete_account()` does the teardown a naive `user.delete()` gets
    wrong: (1) deletes the user's media **files** off storage first (the cascade
    only drops rows, leaving JPEGs orphaned on the NVMe); (2) **last-admin
    guardrail** — a group whose *only* admin is leaving hands admin to the
    longest-standing remaining member (Group.creator is SET_NULL, so a group
    outlives members); (3) a group the user was the *sole* member of is deleted
    outright rather than left as dead space. All in one transaction. Chosen over
    anonymise-and-keep because it's the cleaner erasure story for a privacy-first
    app; accepted trade-off is that replies *others* wrote under a deleted user's
    comment cascade away too.
  - **Takedown: in-app Report.** A quiet "Report" control on posts + comments
    (hidden on your own) → `POST /api/reports/` → a `Report` row (post XOR
    comment, DB-enforced) surfaced in a Django-admin moderation queue
    (filter to `open`, remove the content, mark resolved). Chosen over a
    documented-email-only path so it's self-contained and testable; removal
    itself stays a manual admin action (the maintainer's judgement).
  - **Backups caveat, disclosed in the privacy policy:** deleted data can persist
    in the encrypted R2 backups until they age out (~30-day window, matching the
    `media-archive` retention). The policy states this honestly rather than
    implying instant global erasure.
  - Tests: backend consent-gating + hard-delete teardown (files, last-admin
    promotion, emptied-group deletion) + report creation/scoping; frontend
    consent gate, delete flow, report flow, and the two public legal routes.
  - **Merged + deployed (2026-07-11, #44).** Squash-merged to main
    (`cd83708`), then `deploy/deploy.sh` on the box: fast-forward pull, image
    rebuild, container recreate. Migrations `accounts.0003_user_tos_accepted_at`
    + `api.0010_report` applied cleanly, `collectstatic` ran, gunicorn came back
    up. Post-deploy smoke test from off-box: `/`, `/terms`, `/privacy` all 200
    over HTTPS. **This ticked the 12th DoD box and closed the hard gate** — real
    friends/family can now be invited.

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
- **Continuous deploy built: trigger on release, systemd timer over Watchtower
  (2026-07-11, branch `phase-7-cd-on-release`).** Implemented the pull-based plan
  above with two refinements the user asked for / I chose:
  - **Trigger = GitHub Release published, not every merge to main.** A deploy is
    now always a deliberate human action (`gh release create vX.Y.Z`), cut from a
    green main — safer than auto-shipping every commit, and gives a natural
    version/changelog. `.github/workflows/release-deploy.yml` builds both images
    and pushes them to GHCR tagged `<release>` + `latest` (uses the built-in
    `GITHUB_TOKEN` with `packages: write` — no PAT/secret needed). Fork PRs can't
    publish releases, so untrusted code never builds our images.
  - **Box side = a systemd timer, not Watchtower.** Chosen for consistency with
    the box's existing pattern (backups + DDNS are already systemd timers) and
    transparency — `deploy/autodeploy.sh` is a readable ~40-line script vs
    Watchtower's opaque daemon. Every ~5 min it `git pull`s config, `docker
    compose pull`s the `:latest` images, and **only if a digest changed** runs
    `up -d --no-build` against a new `docker-compose.ghcr.yml` override (so the
    box runs the pre-built image, never compiles). Reuses deploy.sh's guards
    (data-disk mounted, `.env.prod` present). A no-release poll is a quiet no-op.
  - **Hybrid config vs image: config via git, images via GHCR.** The Caddyfile is
    host-mounted and the compose files declare ports/volumes, so those must stay
    on the box's git checkout — autodeploy `git pull`s them; only the heavy image
    build is offloaded to CI. Box stays on `main` (no detached-HEAD footgun; the
    manual `deploy.sh` keeps working as the build-from-source fallback).
  - **GHCR packages set PUBLIC (one-time).** Repo is already public and images
    bake nothing secret (secrets stay in `.env.prod` at runtime), so public
    packages let the box pull anonymously — no registry creds on the box. Flip to
    private later = one `docker login ghcr.io` with a read:packages token.
  - Still TODO before ticking the DoD box: cut the first release, make the two
    packages public, install + enable the timer on the box, and watch a release
    deploy end-to-end. Walk through live (user is new to servers).
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
- **Security review run + hardening landed (2026-07-11).** Ran a full-application
  review (not a diff — everything's on `main`). Finding: the app layer is solid
  (centralised connection/block/membership gates, session-derived authors, 404-not-
  403 existence hiding, validate-by-decoding uploads with EXIF/SVG stripped, httpOnly
  JWT + CSRF, fail-safe DEBUG/SECRET_KEY). **No HIGH.** Fixed the three real gaps on
  branch `phase-7-security-hardening` (tests + ruff + bandit green, Caddyfile
  `caddy validate`d):
  1. **Uploaded media was world-readable** — Caddy served `/media/*` off disk with
     no auth (only an unguessable UUID URL protected real family photos; no expiry,
     no revocation). Chose **auth-only gating** (user's call): Caddy `forward_auth`s
     every media request to a new backend endpoint `GET /api/media-auth/`, which
     returns 204 only for a logged-in **active** member (SimpleJWT already rejects a
     deactivated user's token, so a banned member's saved URLs stop resolving). A
     leaked URL is now useless to a logged-out stranger. **Deferred to 7b:** full
     *per-author connection* gating (a logged-in member could still fetch a photo
     whose UUID they already hold) — accepted for a small closed beta; UUID stays a
     second layer.
  2. **Django admin was internet-facing** — restricted `/admin/` in Caddy to LAN +
     loopback (`remote_ip` allow-list), public internet gets 403. **Deliberately
     fail-closed:** the allow-list *excludes* Docker's own bridge range
     (172.16.0.0/12), so if published-port NAT ever presented the bridge gateway as
     the source IP instead of the real client, admin would lock out *everyone* (caught
     instantly) rather than silently open to the world. Remote admin while away = SSH
     to the box (`manage.py`) or an SSH tunnel. Added Caddy JSON access logging so the
     source-IP behaviour is verifiable.
  3. **Account enumeration at sign-up** — a duplicate email gave a distinct error,
     letting anyone probe who has an account. Now a taken email returns the *identical*
     "pending approval" 201 as a fresh sign-up (silent no-op in the serializer, with a
     throwaway password hash to equalise timing); the existing account is never
     touched.

  **On-box verification still required after merge + deploy (then tick the DoD box):**
  (a) media URL loads for a logged-in member and returns 401/403 in a logged-out/
  private-window request; (b) `/admin/` opens from the LAN and **403s from mobile
  data** (proves `remote_ip` sees real client IPs, i.e. the fail-closed exclusion
  didn't just block everything); (c) sign-up with an existing email still returns the
  generic pending-approval message.
- **Deployed + verified on the box (2026-07-11).** #42 deployed via `deploy/deploy.sh`
  (backend rebuilt → the `web` container recreated too, so Caddy re-read the mounted
  Caddyfile); homepage + API stayed 200. Checks:
  - **Media:** an unauthenticated request to a real uploaded photo returned **401**
    (it was 200 before). ✓
  - **Admin:** an off-LAN client returned **403**, a direct-LAN connection **200**,
    and Caddy's JSON access log confirmed it filters on the *real* client IP
    (`remote_ip` = the true public IP, **not** the Docker gateway) — so the
    fail-closed 172.16/12 exclusion is safe and admin is genuinely off the internet. ✓
    Handy test-vantage note: with a **VPN on**, a LAN machine hitting the public
    domain exits via the VPN's public IP and comes back as a real outside client
    (→ 403) — a convenient stand-in for the mobile-data test.
  - **Enumeration:** registering the same email twice against the live API returned an
    **identical 201 + body** both times, with only one account created; the throwaway
    test account was deleted afterwards. ✓
  - **Access nuance (documented):** a normal LAN device reaches `/admin/` via the
    public domain fine — the router's hairpin keeps the source on the LAN (confirmed
    on the Mac). A LAN device only gets 403 if something routes it *out* first — a
    VPN, or **iCloud Private Relay** on iOS/macOS (separate from the VPN toggle), the
    usual reason a phone on home Wi-Fi is still blocked. Fix on that device, or force
    the domain to the box's LAN IP with a hosts entry, or approve sign-ups via a
    `manage.py` one-liner over SSH. Genuinely-away devices (mobile data) correctly get
    403. See `docs/deploy.md`.
