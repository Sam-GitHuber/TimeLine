# Deploying TimeLine (home-server production)

The repeatable runbook for the Phase 7 home server. The *why* behind these
choices lives in `docs/phases/phase-7-productionisation.md`; this file is the
*how*.

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
