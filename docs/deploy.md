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
