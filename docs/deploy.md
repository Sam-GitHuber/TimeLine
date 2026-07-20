# Deploying TimeLine (home-server production)

The repeatable runbook for the self-hosted home server, **and** the design
rationale behind it (see "Why it's built this way" at the bottom). This is where
the app lives today: a wiped spare PC in the maintainer's house serving a real
HTTPS URL, so a few close friends/family can log in and use everything. It's
**not** the final home — it's the cheap, fully reversible way to prove the app is
worth keeping before paying for cloud (the AWS migration is a later, deferred
step). Off-box backups (`backup-restore.md`) are what make that migration
low-risk. When it's time to shut the app down for good, `docs/teardown.md` is the
reverse of this doc — the checklist for destroying every credential, closing the
accounts, and deleting the data.

**The box:** ASUS PC, hostname `timeline-server`, a dedicated non-root admin user, reached over
SSH on the LAN (`ssh timeline-server`). OS on the 250 GB SATA SSD; **all app data
(Postgres + media) on the 1 TB NVMe mounted at `/srv/timeline`**.

## One-time server setup

Already done: OS install, hardening (SSH keys, `ufw`, auto-updates), Docker, and
the NVMe data disk formatted + mounted at `/srv/timeline` with a `docker.service`
guard (`RequiresMountsFor=/srv/timeline`). What remains for a fresh checkout:

1. **Clone the repo** (read-only deploy key or HTTPS):

   ```bash
   git clone https://github.com/Sam-GitHuber/TimeLine.git ~/TimeLine
   cd ~/TimeLine
   ```

2. **Create the secrets file** from the template and fill in real values:

   ```bash
   cp .env.prod.example .env.prod
   # generate strong values:
   python3 -c "import secrets; print(secrets.token_urlsafe(32))"   # DB password
   python3 -c "import secrets; print(secrets.token_urlsafe(50))"   # DJANGO_SECRET_KEY
   nano .env.prod
   ```

   `.env.prod` is gitignored and must **never** be committed.

3. **Create the data directories on the NVMe.** The prod compose file bind-mounts
   Postgres and media to `/srv/timeline/postgres` and `/srv/timeline/media`.
   Docker's bind driver won't create these — the first bring-up fails with "no
   such file or directory" if they're missing. Make them once (root-owned; the
   Postgres and backend containers manage their own contents):

   ```bash
   sudo mkdir -p /srv/timeline/{postgres,media}
   ```

   `deploy/deploy.sh` refuses to run if either is missing.

4. **First bring-up.** Two modes:

   - **LAN test first (recommended)** — plain HTTP on the LAN IP, no domain/TLS
     yet, so you can confirm the app works before wiring DNS. Set these in
     `.env.prod` (`DJANGO_ALLOWED_HOSTS` and `DJANGO_CORS_ALLOWED_ORIGINS` must
     include the LAN IP), then:

     ```bash
     SITE_ADDRESS=:80 VITE_API_URL=http://192.168.1.95 \
       docker compose -f docker-compose.prod.yml up -d --build
     ```

     Visit `http://192.168.1.95` from another device on the LAN.

   - **Public HTTPS** — once DNS/DDNS + port-forward are set up, just use the
     deploy script (below); it defaults to the real domain with automatic HTTPS.

## Routine deploy (ship a new version)

From inside the repo on the server:

```bash
./deploy/deploy.sh
```

It pulls the latest code on the current branch, rebuilds, restarts, prunes old
images, and tails the backend log. It **aborts** if `/srv/timeline` isn't mounted
or `.env.prod` is missing. Migrations + `collectstatic` run automatically in the
backend entrypoint.

This build-on-box path stays the **fallback** — use it for a hotfix or if GHCR
is unavailable. The normal path is now the automated one below.

## Continuous deploy (automatic, on release)

The everyday way to ship is now: **publish a GitHub Release, and the box deploys
itself within a few minutes.** No SSH in from CI — the box only exposes 80/443,
so deploys are *pull-based* (the box reaches out to GHCR; nothing reaches in).

**How it flows:**

1. You publish a Release on GitHub (from green `main` — see below).
2. The **`Release images`** workflow (`.github/workflows/release-deploy.yml`)
   builds the `backend` + `web` images and pushes them to GHCR, tagged with the
   release tag **and** `latest`:
   - `ghcr.io/sam-githuber/timeline-backend`
   - `ghcr.io/sam-githuber/timeline-web`
3. On the box, **`timeline-autodeploy.timer`** fires every ~5 min and runs
   `deploy/autodeploy.sh`, which: `git pull`s the latest config (compose files,
   GHCR override, Caddyfile), `docker compose pull`s the two `:latest` images,
   and — **only if an image actually changed** — recreates the stack via the
   GHCR override (`docker-compose.ghcr.yml`, `--no-build`, so the box runs the
   pre-built image and never compiles). Migrations + `collectstatic` run in the
   backend entrypoint as usual. A poll with no new release is a quiet no-op.

**Cutting a release (the deploy trigger):**

```bash
# from a green main — tag vX.Y.Z and publish; --generate-notes writes a changelog
gh release create v0.1.0 --generate-notes
```

Then watch it land on the box:

```bash
# the build+push run
gh run watch $(gh run list --workflow "Release images" -L1 --json databaseId -q '.[0].databaseId')

# on the box: the autodeploy log
journalctl -u timeline-autodeploy.service -f
```

**One-time setup on the box** (walk through live):

```bash
# 1. Make the two GHCR packages PUBLIC so the box can pull with no credentials.
#    After the first release pushes them, open each package on GitHub
#    (Profile → Packages → timeline-backend / timeline-web →
#    Package settings → Change visibility → Public). One-time per package.
#    (They contain nothing secret — the repo is public and secrets stay in
#    .env.prod at runtime — so public is the simple, safe default. To keep them
#    private instead, `docker login ghcr.io` on the box with a read:packages
#    token and skip this step.)

# 2. Install + enable the timer (edit User= and the ExecStart= path first).
sudo cp deploy/timeline-autodeploy.service deploy/timeline-autodeploy.timer \
  /etc/systemd/system/
sudoedit /etc/systemd/system/timeline-autodeploy.service   # set User= + path
sudo systemctl daemon-reload
sudo systemctl enable --now timeline-autodeploy.timer

# 3. Prove it by hand once before trusting the timer.
./deploy/autodeploy.sh
systemctl status timeline-autodeploy.timer --no-pager
```

To pause auto-deploy (e.g. during maintenance): `sudo systemctl stop
timeline-autodeploy.timer`. Re-enable with `start`.

## Going public: dynamic DNS (Cloudflare)

The home connection's public IP changes over time, so a **DDNS updater** keeps the
Cloudflare A record for `your-timeline.net` pointed at the current IP. The router's
built-in DDNS doesn't support Cloudflare, so we run a small updater on the box.

One-time setup (on the server):

```bash
# 1. Config file with the Cloudflare API token (Edit-zone-DNS, scoped to the zone).
sudo mkdir -p /etc/timeline
sudo cp deploy/cloudflare-ddns.env.example /etc/timeline/cloudflare-ddns.env
sudo nano /etc/timeline/cloudflare-ddns.env      # paste the real token
sudo chmod 600 /etc/timeline/cloudflare-ddns.env

# 2. Test it once by hand — should create/point the A record at the home IP.
sudo ~/TimeLine/deploy/cloudflare-ddns.sh

# 3. Install + enable the systemd timer (runs at boot + every 5 min).
sudo cp deploy/cloudflare-ddns.service deploy/cloudflare-ddns.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflare-ddns.timer

# 4. Verify.
systemctl status cloudflare-ddns.timer --no-pager
journalctl -u cloudflare-ddns.service --no-pager -n 20
```

The A record must be **DNS only (grey cloud)**, not Proxied — Caddy needs a direct
route for its Let's Encrypt challenge, and the domain resolves to the home IP
(accepted trade-off; WHOIS privacy is on).

## Outbound email (Resend)

The app needs to send mail (password recovery, and later email verification). We
send over SMTP through **Resend** — a transactional email provider whose free
tier (3,000 emails/month) is far more than a private friends/family beta uses.
Any SMTP provider works; only the four `EMAIL_*` values in `.env.prod` change.

Why a provider at all, rather than sending mail straight from the box? A home IP
has no sending reputation and is on every mailbox provider's dynamic-IP blocklist,
so self-sent mail lands in spam or is dropped outright. A provider sends from
warmed, authenticated IPs — the difference between "reset link arrives" and
"family member never gets it."

```
# 1. Create a Resend account (resend.com) and add the domain `your-timeline.net`
#    (Domains → Add Domain).

# 2. Resend shows a few DNS records (an SPF TXT record and DKIM CNAME/TXT
#    records). Add each one in Cloudflare DNS (same zone as the A record above),
#    as **DNS only (grey cloud)**. Wait for Resend to mark the domain "Verified"
#    (usually minutes). This is what proves to receiving servers that mail
#    "from" your-timeline.net is really authorised — without it, mail is
#    spam-filtered or bounced.

# 3. Create an API key (API Keys → Create). This is the SMTP password.

# 4. Fill these into .env.prod (see .env.prod.example for the block):
#      EMAIL_HOST=smtp.resend.com
#      EMAIL_PORT=587
#      EMAIL_USE_TLS=true
#      EMAIL_HOST_USER=resend            # literal username for Resend
#      EMAIL_HOST_PASSWORD=<the API key>
#      DEFAULT_FROM_EMAIL=TimeLine <no-reply@your-timeline.net>
#    then redeploy (the timer picks it up, or restart the backend by hand).

# 5. Smoke-test a real delivered email from the prod stack:
docker compose -f docker-compose.prod.yml exec backend \
  python manage.py sendtestemail you@example.com
#    Check the inbox (and spam). If it lands, delivery works end to end.

# 6. Smoke-test the sign-up verification email specifically (issue #73): sends a
#    branded 6-digit code, then waits for you to type it back and confirms the
#    match. Exercises the real template + code round-trip; touches no account, so
#    it's safe against production.
docker compose -f docker-compose.prod.yml exec backend \
  python manage.py send_test_verification you@example.com
```

> Run these from the repo checkout on the box (`cd ~/TimeLine`) and keep the
> `-f docker-compose.prod.yml` flag — without it Compose can't find a config file
> ("no configuration file provided: not found"). See *Everyday operations* below.

**Fail-loud in production.** With `DEBUG` off, an unset `EMAIL_HOST` makes the
app refuse to boot — so a misconfigured deploy can't silently start printing
password-reset links (a plaintext account-takeover token) to the logs. For a
deliberate LAN test *before* you have a provider, comment out `EMAIL_HOST` and
set `EMAIL_CONSOLE_FALLBACK=true`: mail is then printed to the backend logs
(visible via `docker compose … logs -f backend`) rather than sent. Never enable
that in real production.

## Everyday operations

```bash
# status of all services
docker compose -f docker-compose.prod.yml ps

# follow logs (all services, or one)
docker compose -f docker-compose.prod.yml logs -f
docker compose -f docker-compose.prod.yml logs -f backend

# Django admin shell / management commands
docker compose -f docker-compose.prod.yml exec backend python manage.py <cmd>

# create the first admin (to approve sign-ups)
docker compose -f docker-compose.prod.yml exec backend python manage.py createsuperuser

# stop / start the whole stack
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

## Admin access is LAN-only (security hardening)

`/admin/` is **not reachable from the public internet** — Caddy 403s any request
whose source IP isn't on the home LAN (`192.168.x` / `10.x`) or loopback. The admin
login is the one high-value credential on the box, so it doesn't face internet
brute-force traffic. (Verified 2026-07-11: a genuinely off-LAN client gets `403`; a
LAN device gets in.)

- **From home:** just open `https://your-timeline.net/admin/` on a device on the
  LAN — it works. The router's hairpin (NAT loopback) keeps the source address on
  the LAN, so Caddy sees a `192.168.x` client and allows it.
- **If a LAN device gets a 403 anyway,** its traffic is leaving the LAN *before* it
  reaches the box, so it looks like an outside client. The usual culprits, in order
  of likelihood:
  - a **VPN** is on (turn it off for this site), or
  - **iCloud Private Relay** on an iPhone/Mac (Settings → your name → iCloud →
    Private Relay) — this is separate from the VPN toggle and relays you through a
    public IP, so it's the common reason a *phone on home Wi-Fi* is still blocked.

  Rather than fiddle with those, you can force the domain to the box's LAN IP on
  your admin machine with a one-line hosts entry (`/etc/hosts` on macOS/Linux,
  `C:\Windows\System32\drivers\etc\hosts` on Windows) — the connection then stays on
  the LAN regardless of relay/VPN:

  ```
  192.168.1.95   your-timeline.net
  ```

- **From genuinely away** (mobile data, a café, another house): you'll get `403` —
  that's the point. SSH into the box and administer there. To approve a pending
  sign-up without the web UI:

  ```bash
  docker compose -f docker-compose.prod.yml exec backend python manage.py shell -c \
    "from django.contrib.auth import get_user_model as g; g().objects.filter(email='them@example.com').update(is_active=True)"
  ```

The allow-list deliberately **excludes** Docker's bridge range, so it fails *closed*:
if it ever blocks *every* device including a plain LAN one, that's the signal that
Caddy isn't seeing real client IPs (check
`docker compose -f docker-compose.prod.yml logs web` for `remote_ip`) — fix that
rather than widening the list to the whole internet.

## Uploaded media is authenticated

Post photos and avatars under `/media/` are **not world-readable**. Caddy asks the
backend (`forward_auth` → `/api/media-auth/`) before serving each file and returns
it only to a logged-in, active member — so a leaked media URL is useless to an
outsider, and a deactivated account's saved URLs stop resolving. Nothing to operate;
just don't be surprised that `curl https://your-timeline.net/media/...` returns 401
without a valid session cookie. (Per-author connection gating is a later, Phase 11
step; today any logged-in member can fetch a media file whose URL they already hold.)

## Handling reports & deletion requests (moderation)

Members can flag content and delete their own accounts (Phase 7 legal gate).

- **Content reports.** A member's “Report” on a post or comment creates a report
  row. Review them in the Django admin under **Api › Reports** (LAN-only, like the
  rest of admin). Filter the list to `open`, open the flagged post/comment (both
  are readable/deletable from their own admin pages), delete the content if it
  breaks the Terms, then set the report’s **status** to `resolved` (or `dismissed`
  if there’s nothing to do) to clear the queue.

- **Account deletion is self-service and permanent.** A member deletes their own
  account from **Settings** (password-reconfirmed). It hard-deletes their account
  and content, removes their uploaded image files from `/srv/timeline/media`, and
  hands any group they solely administered to the longest-standing remaining
  member (a group they were the only member of is deleted). You don’t need to do
  anything. To action a deletion request over SSH instead (e.g. someone locked
  out), from inside the repo on the box:

  ```bash
  docker compose -f docker-compose.prod.yml exec backend python manage.py shell -c \
    "from api.views import delete_account; from django.contrib.auth import get_user_model as g; delete_account(g().objects.get(email='them@example.com'))"
  ```

- **Backups caveat.** Deleted data can linger in the nightly encrypted R2 backups
  until they age out (~30 days) — this is stated in the privacy policy. There’s no
  need (and no clean way) to surgically scrub a single account from historical
  encrypted backups; they roll over on their own.

## Verifying data really is on the NVMe

After the first `up`, confirm Postgres + media resolve onto the data disk, not
the OS SSD:

```bash
docker volume inspect timeline-prod_postgres_data -f '{{ .Options.device }}'  # -> /srv/timeline/postgres
docker volume inspect timeline-prod_media        -f '{{ .Options.device }}'  # -> /srv/timeline/media
du -sh /srv/timeline/postgres /srv/timeline/media
```

## Reboot-survival

`restart: unless-stopped` on every service means the stack comes back after a
reboot. To prove it: `sudo reboot`, wait, then `ssh timeline-server` and check
`docker compose -f docker-compose.prod.yml ps` shows everything `Up`, and the
site loads.

## Rollback

Images are rebuilt from a git checkout, so rolling back is a git operation:

```bash
git log --oneline -n 10          # find the last-good commit
git checkout <good-sha>          # or: git reset --hard <good-sha> on the branch
docker compose -f docker-compose.prod.yml up -d --build
```

(Database migrations are not auto-reversed — a rollback that spans a migration
needs care. For the beta, prefer rolling *forward* with a fix.)

## Backups & restore

Nightly encrypted off-site backups (Postgres dump + media) to Cloudflare R2, plus
the tested restore procedure, live in their own runbook: **`docs/backup-restore.md`**.
Take an ad-hoc backup before a risky change with `./deploy/backup.sh`.

## Expired-token housekeeping (weekly)

With JWT refresh-token rotation on (Phase 9 — see
[`reference/accounts.md`](reference/accounts.md#refresh-token-rotation)),
`simplejwt` writes an `OutstandingToken` row for **every refresh token it ever
issues** — every web login, every mobile login, and every rotation — plus a
`BlacklistedToken` row per rotation. Nothing removes them when they expire, so
left alone the two tables grow forever and drag the nightly backup up with them.

`flushexpiredtokens` deletes only rows whose token has **already expired**, so it
can never log anyone out. Install the weekly timer:

```bash
sudo cp deploy/token-flush.{service,timer} /etc/systemd/system/
sudo nano /etc/systemd/system/token-flush.service   # set User= and paths
sudo systemctl daemon-reload
sudo systemctl enable --now token-flush.timer

# check it's scheduled
systemctl list-timers token-flush.timer
```

It runs Sunday 04:15, after the 03:30 backup window so the two don't overlap on
the database. Weekly rather than nightly because at this scale the tables grow by
a handful of rows per person per day.

## Push notification delivery (Phase 9)

Notifications destined for a phone are queued into `PushOutbox` by the web
request and delivered out-of-band by `manage.py send_pushes`, so a slow or
unreachable Expo can never fail a user's action — see
[`reference/notifications.md`](reference/notifications.md#phone-push-phase-9-milestone-d)
for the why. **Without this timer installed, notifications still appear in the
in-app activity centre but no phone ever buzzes** — the rows just accumulate
unsent, which is the failure mode to recognise.

```bash
sudo cp deploy/send-pushes.{service,timer} /etc/systemd/system/
sudo nano /etc/systemd/system/send-pushes.service   # set User= and paths
sudo systemctl daemon-reload
sudo systemctl enable --now send-pushes.timer

# check it's scheduled, then watch a few runs
systemctl list-timers send-pushes.timer
journalctl -u send-pushes.service -f
```

Prove it by hand first — this is safe to run repeatedly and sends nothing:

```bash
docker compose -f docker-compose.prod.yml exec -T backend \
  python manage.py send_pushes --dry-run
```

It runs every minute (not `Persistent=true`, unlike the other timers here: after
the box has been off, firing a backlog of stale pushes at people's phones is
worse than skipping them — the rows still go out on the next ordinary tick).

Set `EXPO_ACCESS_TOKEN` in `.env.prod` at the same time — see
`.env.prod.example`. Without it Expo accepts unauthenticated sends, meaning
anyone who learns one of your users' push tokens could push to them under your
app's name.

## Uptime monitoring

You want to hear about an outage from a robot, not from a friend texting "is the
site down?". We reuse **[healthchecks.io](https://healthchecks.io)** — the same
service the backup uses. It's a *passive* dead-man's-switch: it can't probe your
site itself, so the box pings it. A small systemd timer curls the app's health
endpoint (`GET /api/healthz/`, which returns 200 only when Caddy, gunicorn **and**
Postgres are all alive) every 5 minutes and reports the result:

- **Site healthy** → ping the check's success URL.
- **Site answering but broken** (e.g. DB down → 503) → ping `<url>/fail` →
  immediate alert.
- **Box off / broadband down** → the timer can't run, so no ping arrives → the
  check goes overdue and healthchecks.io alerts you. *Silence is the alarm.*

That trio covers every realistic home outage (power cut, crashed box, crashed
container, dead DB, dropped internet).

> **Scope:** by default the probe hits the public hostname but pinned to loopback
> (so it doesn't depend on the router "hairpinning"), which tests the whole local
> serving stack but *not* the inbound path from the wider internet (port
> forwarding / public DNS). Those rarely break once set. If you later want to
> cover them too, add a second monitor on a machine *outside* your house.

**One-time setup:**

```text
# 1. On healthchecks.io, create a SECOND check (separate from the backup one).
#    Name it e.g. "timeline-uptime". Set Period = 5 min, Grace = 10 min, so a
#    truly-down box alerts within ~15 min. Add an email/Slack/push integration.
#    Copy its ping URL (looks like https://hc-ping.com/<uuid>).
```

```bash
# 2. Config file with that ping URL (runs as the deploy user).
sudo mkdir -p /etc/timeline
sudo cp deploy/healthcheck.env.example /etc/timeline/healthcheck.env
sudo nano /etc/timeline/healthcheck.env          # paste PING_URL=...
sudo chown "$USER:$USER" /etc/timeline/healthcheck.env
sudo chmod 600 /etc/timeline/healthcheck.env

# 3. Prove it by hand first — should print "OK ... 200; success ping sent."
#    and the check should flip to "up" on healthchecks.io within seconds.
./deploy/healthcheck.sh

# 4. Install + enable the timer (edit User= and the ExecStart= path first,
#    same as the backup/autodeploy units).
sudo cp deploy/timeline-healthcheck.{service,timer} /etc/systemd/system/
sudo nano /etc/systemd/system/timeline-healthcheck.service   # set User= + path
sudo systemctl daemon-reload
sudo systemctl enable --now timeline-healthcheck.timer

# 5. Confirm it's scheduled + watch one run.
systemctl list-timers timeline-healthcheck.timer
journalctl -u timeline-healthcheck.service -n 20
```

To test the alerting end-to-end: `docker compose -f docker-compose.prod.yml stop
backend`, wait for the `/fail` alert to land, then `start` it again.

## Monthly running cost

The point of the home-server beta is to prove the app is worth keeping *before*
paying for cloud (that's Phase 11 → AWS). So the running cost is deliberately
close to zero — only the domain is a hard cash cost:

| Item | Cost | Notes |
|------|------|-------|
| Domain `your-timeline.net` | ~**£10–15 / year** (~£1 / mo) | The only unavoidable bill. Renews annually. |
| Cloudflare DNS + DDNS | £0 | Free plan. |
| Cloudflare R2 (encrypted backups) | £0 | Well within the 10 GB free tier for a small beta — check with `rclone size timeline-crypt:`. |
| healthchecks.io (uptime + backup) | £0 | Free tier (up to 20 checks). |
| Resend (outbound email) | £0 | Free tier (3,000 emails/mo) — a private beta sends a handful. |
| GitHub Actions + GHCR (CI + image registry) | £0 | Free for a public repo. |
| Let's Encrypt TLS | £0 | Free, auto-renewed by Caddy. |
| TLS/hosting/servers | £0 | Runs on the wiped home PC. |
| **Electricity** | ~**£3–7 / mo** | The one variable cost: an always-on desktop drawing ~30–60 W ≈ 22–43 kWh/mo at ~£0.27/kWh (UK 2026). Depends on the actual box + tariff — measure with a plug meter for a real figure. |

**Rough total: ~£4–8 / month**, dominated by electricity, plus the ~£12/yr
domain. That's the baseline the eventual AWS bill (Phase 11) has to justify
beating — see `docs/phases/phase-11-aws-migration.md`.

## Why it's built this way (design decisions)

The runbook above is the *how*; this is the durable *why* behind the ops choices,
so a future change doesn't quietly undo the reasoning.

- **Same-origin serving behind Caddy — because of CSRF.** The SPA reads the
  non-httpOnly `csrftoken` cookie and echoes it as `X-CSRFToken` (see
  `reference/accounts.md`). In production that needs either same-origin serving
  (Caddy in front of both SPA and API — what we do) or split subdomains with
  matching cookie-domain + trusted-origin config. Miss it and *every*
  authenticated mutation 403s. Caddy also gives tiny-config auto-HTTPS (Let's
  Encrypt via HTTP-01); nginx + certbot is the manual alternative.
- **Exposure = port-forward + dynamic DNS, not a Cloudflare Tunnel.** Forward
  **only 80/443** (never SSH/Postgres); admin over SSH on the LAN. Accepted
  trade-off: the domain resolves to the home's public IP, so WHOIS privacy is on.
  CGNAT would break inbound port-forwarding (checked — this ISP doesn't use it); a
  **Cloudflare Tunnel** is the documented fallback that needs no port-forward and
  hides the home IP. DDNS runs *on the box* (`deploy/cloudflare-ddns.sh` + a
  systemd timer) because the router has no Cloudflare option; pin the IP lookup to
  `curl -4` since we publish an A record (a dual-stack box otherwise returns its
  IPv6). A **router DHCP reservation** pins the box's LAN IP — a lease change
  otherwise silently breaks inbound access and looks like a crashed box.
- **Data on the 1 TB NVMe, not the OS disk.** The OS boots off the small SATA SSD
  (the motherboard firmware can't boot from NVMe — a hardware quirk of this box);
  Postgres data *and* media live on the NVMe for capacity (family photos dwarf
  250 GB), to avoid filling the boot disk (a full OS disk takes the box down), and
  for speed. The catch: Docker named volumes default to `/var/lib/docker/volumes`
  on the OS disk, so the volumes are explicitly pinned to the NVMe mount, and Docker
  is guarded by `RequiresMountsFor` so it can't come up writing to the OS disk
  before the NVMe mounts. Verify with `docker volume inspect` + a reboot test.
- **Continuous deploy is pull-based and release-triggered.** The box forwards only
  80/443, not SSH, so CD must be **outbound from the house** — GitHub can't SSH in.
  So: `gh release create vX.Y.Z` → a workflow builds + pushes images to GHCR (using
  the built-in `GITHUB_TOKEN`, no PAT); a systemd timer on the box polls every
  ~5 min, `docker compose pull`s, and redeploys **only on a changed digest**.
  Triggering on *release* (not every merge) keeps a deploy a deliberate human
  action with a version/changelog, and fork PRs can't publish releases so untrusted
  code never builds our images. Chosen a systemd timer over Watchtower for
  consistency with the box's other timers (backups, DDNS) and transparency. Config
  (Caddyfile, compose files) travels via `git pull`; only the heavy image build is
  offloaded to CI, and the box stays on `main` so the manual `deploy.sh`
  build-from-source path still works as a fallback. **Security:** the whole
  pipeline's trust reduces to control of the GitHub account (2FA is the crown-jewel
  control); the box holds no registry write creds and images bake nothing secret
  (real secrets are injected at runtime from `.env.prod`).
- **Backups: encrypted to Cloudflare R2, media mirrored not snapshotted.** See
  `backup-restore.md` for the runbook. R2 was chosen (over B2 / self-managed)
  because it reuses the Cloudflare account, has 10 GB free + zero egress, and is
  S3-compatible so it doubles as a stepping stone to the Phase 11 S3 migration.
  `rclone crypt` encrypts before anything leaves the house. Media is *mirrored*
  (not snapshotted) so off-site size ≈ live media, with changed/deleted files
  diverted to a dated `media-archive/` (30-day window) so a local wipe can't
  propagate to the backup.
- **Security hardening (from `/security-review`, no HIGH findings).** Three gaps
  were closed: (1) **uploaded media auth-gated** via Caddy `forward_auth` →
  `/api/media-auth/` (logged-in active members only; see `reference/feed-and-posts.md`);
  (2) **Django `/admin/` restricted to the LAN** by Caddy `remote_ip` allow-list,
  deliberately **fail-closed** — it *excludes* Docker's bridge range so a NAT
  misconfig locks admin out (caught instantly) rather than silently opening it to
  the world; (3) **sign-up enumeration closed** (see `reference/accounts.md`). Note
  a normal LAN device reaches `/admin/` via the public domain through the router's
  hairpin; it only 403s if something routes it *out* first (a VPN, or iCloud
  Private Relay on iOS/macOS) — the usual reason a phone on home Wi-Fi is still
  blocked.
- **Uptime = an on-box active probe + a dead-man's switch.** healthchecks.io is
  *passive* (it waits for pings, it does not probe your URL), so the active half
  lives on our side: a 5-min timer curls `GET /api/healthz/` (public, runs
  `SELECT 1` so "gunicorn up but Postgres down" is caught; 503 on DB error) and
  pings success/`/fail`. The probe hits the public hostname **pinned to loopback**
  (`curl --resolve …:127.0.0.1`) because many consumer routers can't hairpin a LAN
  request to their own public IP — this exercises the real cert + routing + DB but
  not the inbound internet path (static once set; an external check is a deferred
  nice-to-have). If the box or broadband is down the timer can't run, so the
  missing ping goes overdue → the dead-man's alert fires. No `Persistent=true` on
  this timer (a catch-up ping would falsely claim the site was up during an
  outage).
