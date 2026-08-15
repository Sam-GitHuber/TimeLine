# Deploying TimeLine (AWS Lightsail production)

The repeatable runbook for production, **and** the design rationale behind it
(see "Why it's built this way" at the bottom). This is where the app lives:
an AWS Lightsail instance in London serving `https://your-timeline.net`, so
friends and family can log in and use everything. When it's time to shut the app
down for good, `docs/teardown.md` is the reverse of this doc — the checklist for
destroying every credential, closing the accounts, and deleting the data.

**The box:** AWS Lightsail, region **`eu-west-2` (London)**, instance
`timeline-prod`, Ubuntu 24.04 LTS, 2 vCPU / 2 GB RAM / 60 GB SSD. Reached with
`ssh timeline-aws` as user **`ubuntu`** (`sudo` needs no password there). Static
IP **`13.135.109.0`**, which the `your-timeline.net` A record points at. App data
(Postgres + media) lives under **`/srv/timeline`** — an ordinary directory on the
single disk, not a separate volume.

> **History.** Until August 2026 this ran on a wiped PC in the maintainer's house
> — a deliberately cheap, reversible way to prove the app was worth paying to
> host. That ended when the home ISP moved the connection behind **CGNAT**, which
> makes inbound port-forwarding impossible at any price, so the AWS migration
> (Phase 11) was brought forward and completed on **2026-08-12**. The home-server
> details are gone from this doc; git history has them if ever needed.

## One-time server setup

Provisioning the instance (region, static IP, SSH key, firewall for 22/80/443
only) is done in the Lightsail console — see "Provisioning a fresh box" at the
bottom. Ubuntu's Lightsail image already ships `PasswordAuthentication no` and an
active `unattended-upgrades`, so those need no work. What remains for a fresh
checkout:

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

3. **Create the data directories.** The prod compose file bind-mounts Postgres
   and media to `/srv/timeline/postgres` and `/srv/timeline/media`. Docker's bind
   driver won't create these — the first bring-up fails with "no such file or
   directory" if they're missing. Make them once (root-owned; the Postgres and
   backend containers manage their own contents):

   ```bash
   sudo mkdir -p /srv/timeline/{postgres,media}
   ```

   `deploy/deploy.sh` and `deploy/backup.sh` both refuse to run if either is
   missing.

   Create them root-owned and leave them alone: the backend container takes
   ownership of `media` itself on every boot — see "The backend runs
   unprivileged" below, which is also why the deploy user can write there
   during a restore.

4. **Tell the deploy scripts this is a single-disk host.** `deploy.sh`,
   `autodeploy.sh` and `backup.sh` all default to requiring `/srv/timeline` to be
   a real **mount point**, which suited the old two-disk home box. Lightsail has
   one volume, so that check can only ever fail here — see "Single-disk hosts"
   below for the `TIMELINE_REQUIRE_DATA_MOUNT=0` setting and where it goes.

5. **First bring-up.** Once the A record points at the static IP, the deploy
   script does everything — it defaults to the real domain with automatic HTTPS:

   ```bash
   TIMELINE_REQUIRE_DATA_MOUNT=0 ./deploy/deploy.sh
   ```

   To bring the stack up on a **temporary hostname** first (useful when staging a
   migration without touching the live record — add a throwaway A record, e.g.
   `aws.your-timeline.net`, so Let's Encrypt can still issue):

   ```bash
   SITE_ADDRESS=staging.your-timeline.net VITE_API_URL=https://staging.your-timeline.net \
     docker compose -f docker-compose.prod.yml up -d --build
   ```

   **`VITE_API_URL` must match the hostname you're serving on.** Vite inlines it
   into the JS bundle at *build* time (`frontend/src/api.js`), so a released GHCR
   image always points at `https://your-timeline.net` and cannot be tested on any
   other hostname — for that you must build from source, as above. `SITE_ADDRESS`
   accepts a comma-separated list if you need Caddy to serve both names at once.

## Routine deploy (ship a new version)

From inside the repo on the server:

```bash
./deploy/deploy.sh
```

It pulls the latest code on the current branch, rebuilds, restarts, prunes old
images, and tails the backend log. It **aborts** if `.env.prod` is missing, or if
the data directories aren't there — and, unless `TIMELINE_REQUIRE_DATA_MOUNT=0`,
if `/srv/timeline` isn't a mount point (see "Single-disk hosts"; on this box you
need that variable). Migrations + `collectstatic` run automatically in the backend
entrypoint.

This build-on-box path stays the **fallback** — use it for a hotfix or if GHCR
is unavailable. The normal path is now the automated one below.

> **Know what the fallback leaves behind.** `deploy.sh` builds images named
> `timeline-prod-backend` / `timeline-prod-web`; autodeploy runs
> `ghcr.io/sam-githuber/timeline-*`. **Same services, different image names**, so
> after a `deploy.sh` run the containers are pinned to your local build. Autodeploy
> now notices that and recreates them from the release on its next tick (see
> below) — but until it does, the box is running your hotfix build, not a release.
> Cut a real release for anything you want to keep.

## Continuous deploy (automatic, on release)

The everyday way to ship is now: **publish a GitHub Release, and the box deploys
itself within a few minutes.** No SSH in from CI — the box only exposes 80/443,
so deploys are *pull-based* (the box reaches out to GHCR; nothing reaches in).

**How it flows:**

1. You publish a Release on GitHub (from green `main` — see below).
2. The **`Release images`** workflow (`.github/workflows/release-deploy.yml`)
   builds the `backend` + `web` images and pushes them to GHCR under the release
   tag, then — **once both have pushed** — moves `latest` to point at them
   together:
   - `ghcr.io/sam-githuber/timeline-backend`
   - `ghcr.io/sam-githuber/timeline-web`

   The two-step is deliberate. The box polls `latest` every ~5 min, so when each
   build moved its own `latest` as it finished, a tick landing between the two
   builds deployed **half a release** — old web against new backend. It
   self-corrected on the next tick, but on a release with an API change those
   minutes are real errors for real users.
3. On the box, **`timeline-autodeploy.timer`** fires every ~5 min and runs
   `deploy/autodeploy.sh`, which: `git pull`s the latest config (compose files,
   GHCR override, Caddyfile), `docker compose pull`s the two `:latest` images,
   and — **only if a container isn't already running its release image** —
   recreates the stack via the GHCR override (`docker-compose.ghcr.yml`,
   `--no-build`, so the box runs the pre-built image and never compiles).
   Migrations + `collectstatic` run in the backend entrypoint as usual. A poll
   with nothing to do is a quiet no-op.

   **Why the check is phrased that way** (issue #104): it used to compare image
   digests before and after the pull, i.e. "did a new image arrive?" — which is
   not the same question as "is the box running it". Once an image had been
   pulled, every later run truthfully saw no change and skipped the deploy, so
   containers left on anything else (a `deploy.sh` fallback build, a container
   that died and was restarted from an old image) stayed there **indefinitely**,
   with `healthz` at 200 and the log reading `nothing to do.` Comparing each
   running container against the pulled image covers the new-image case as a
   side effect *and* self-heals drift from any cause.

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

The autodeploy unit carries `Environment=TIMELINE_REQUIRE_DATA_MOUNT=0` because
this is a single-disk host — see "Single-disk hosts" below for why.

**Changing `autodeploy.sh`?** Run its tests first — they cover the redeploy
decision (including the stall this section describes) with a stubbed `docker`, so
they need no daemon and take a second:

```bash
./deploy/tests/test_autodeploy.sh
```

### What version is the box actually running?

`healthz` answering 200 says the site is *up*, not that it's **current** — the
two came apart for six days in the incident above. To check the running release:

```bash
# From anywhere, logged in as a staff account (no SSH needed). Staff-only on
# purpose: the endpoint is a version string, and the source is public.
curl -s https://your-timeline.net/api/version/ -H "Cookie: <your session>"
# {"version": "v0.15.0"}   ("dev" = built from a working tree, not a release)
```

Easiest in practice: open `https://your-timeline.net/api/version/` in a browser
where you're logged in as the maintainer — DRF's browsable API renders it.

The version comes from `TIMELINE_VERSION`, baked into the backend image at build
time from the release tag, so it reports the **running code** — not what `main`
holds, and not what's sitting in GHCR. Both images also carry it as an
`org.opencontainers.image.version` label, so on the box:

```bash
# What each container is running, and whether that matches the release image.
docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml ps
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
  $(docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml ps -q backend web)
```

If those disagree with the latest release, just let the timer tick — autodeploy
now recreates drifted containers by itself. To force it immediately:

```bash
./deploy/autodeploy.sh
```

## DNS

One Cloudflare **A record**: `your-timeline.net` → the Lightsail **static IP**
(`13.135.109.0`). Set once, by hand. Nothing keeps it updated because nothing
needs to — a Lightsail static IP doesn't change, and it's free for as long as it
stays *attached to a running instance*. Detaching it, or deleting the instance
without releasing the IP, starts a small charge and is the usual cause of "why is
my idle AWS account billing me".

The record must be **DNS only (grey cloud)**, not Proxied. Caddy needs a direct
route for its Let's Encrypt HTTP-01 challenge; turning the orange cloud on breaks
certificate renewal.

> **The DDNS updater is gone — deliberately.** The home server needed one
> (`deploy/cloudflare-ddns.*`, removed in the Phase 11 cleanup) because its public
> IP moved. On a static IP it is not merely redundant but *dangerous*: it rewrites
> the A record to whatever public IP the machine it runs on can see. During the
> 2026-08-12 cutover the old box's timer was left enabled and dragged the domain
> back to the dead home connection within minutes, taking the live site down and
> holding it down every five minutes.
>
> **The symptom is deeply misleading:** TCP connects on 443 but the TLS handshake
> hangs — indistinguishable from the CGNAT black hole, so it reads as "the new
> server is broken" while that server happily returns 200 on loopback. Before
> blaming the box, always check where the name actually points:
>
> ```bash
> dig +short your-timeline.net @1.1.1.1                       # where is it now?
> curl --resolve your-timeline.net:443:13.135.109.0 \
>      -o /dev/null -w '%{http_code}\n' https://your-timeline.net/api/healthz/
> ```
>
> A 200 from the second command with a wrong answer from the first means DNS, not
> the server. **When retiring any host, disable its timers before moving DNS, not
> after.**

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
deliberate test *before* you have a provider, comment out `EMAIL_HOST` and
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

## There is no web admin in production — administer over SSH

`/admin/` returns **403 to everybody**, including you. Caddy's allow-list is
loopback plus the private LAN ranges (`10.0.0.0/8`, `192.168.0.0/16`); on a cloud
box no client can ever match it. That is the intended end state, not an oversight:
the Django admin login is the highest-value credential in the system, and on a
public host the safest thing it can do is not exist.

Administer with `manage.py` over SSH instead:

```bash
ssh timeline-aws
cd ~/TimeLine

# approve a pending sign-up
docker compose -f docker-compose.prod.yml exec -T backend python manage.py shell -c \
  "from django.contrib.auth import get_user_model as g; g().objects.filter(email='them@example.com').update(is_active=True)"

# anything else
docker compose -f docker-compose.prod.yml exec -T backend python manage.py <command>
```

Verify after any deploy that `/admin/` still 403s from the public internet — read
the response, not the config.

**Do not widen the allow-list to make the web admin reachable.** Two tempting
fixes are both wrong:

- **Adding the Docker bridge (`172.16.0.0/12`, or `172.18.0.1`).** The list
  excludes it *on purpose*, so the rule fails **closed**. Host-loopback traffic
  reaches Caddy as the bridge gateway, so an SSH tunnel to the published port
  looks like `172.18.0.1` — and if Docker's userland proxy ever SNATs
  published-port traffic, so does *the entire internet*. Allowing that address
  would turn a fail-closed rule into a fail-open one and put the admin login in
  front of the world.
- **Adding your own public IP.** It changes, and you'd be back here.

If you genuinely need the web UI, tunnel **past Caddy** straight to gunicorn so
SSH key auth is the gate, or put the box on a private network (Tailscale/
WireGuard) and allow that range. Neither is set up today.

## Uploaded media is authenticated

Post photos and avatars under `/media/` are **not world-readable**. Caddy asks the
backend (`forward_auth` → `/api/media-auth/`) before serving each file and returns
it only to a logged-in, active member — so a leaked media URL is useless to an
outsider, and a deactivated account's saved URLs stop resolving. Nothing to operate;
just don't be surprised that `curl https://your-timeline.net/media/...` returns 401
without a valid session cookie. (Per-author connection gating is a later, Phase 11
step; today any logged-in member can fetch a media file whose URL they already hold.)

## The backend runs unprivileged (and owns the media tree)

Gunicorn — and the migrations and `collectstatic` before it — run as the
container's `app` user, **uid 1000**, not root (issue #199). The point is blast
radius: a remote-code-execution bug in Django or any dependency then executes as
a user that cannot rewrite the application code under `/app` (still root-owned),
cannot chown its way out, and is a much longer step from owning the box. It
doesn't prevent the RCE; it turns "attacker owns the host" into "attacker owns
one process".

The container still *starts* as root to do one thing the app user can't do for
itself — `chown -R app:app /app/media`, i.e. `/srv/timeline/media` on the host —
and then re-execs itself under `setpriv` as `app`
(`backend/entrypoint.prod.sh`). Two consequences worth knowing:

- **No manual step gates a release.** Every photo uploaded before this change
  landed root-owned; the first boot of a release carrying it fixes the whole tree
  and every boot after that keeps it fixed. Nothing to run on the box.
- **uid 1000 is the deploy user (`ubuntu`).** That is the whole reason
  `deploy/restore.sh` can write media back during a disaster recovery — it runs
  as `ubuntu`, and the files it has to overwrite now belong to `ubuntu` (issue
  #197). If the box's deploy user is ever not uid 1000, the image must be rebuilt
  with `--build-arg APP_UID=…`, and the restore preflight will tell you loudly if
  that has been missed.

**When running a one-off command that touches media, pass `-u app`.**
`docker compose … exec` uses the *image's* default user, which is still root, so
a root-written file would sit in the media tree until the next boot repairs it:

```bash
docker compose -f docker-compose.prod.yml exec -u app backend python manage.py <cmd>
```

That includes the account-deletion one-liner below — deleting a user sweeps their
uploaded files off disk (`api/media_cleanup.py`). It happens to work as root
today, since root can unlink anything, but the habit is what keeps the tree
consistent. DB-only commands (`createsuperuser`, approving a sign-up, the
`flushexpiredtokens` timer, the `pushes` service) never touch media and are fine
as they are.

## Handling reports & deletion requests (moderation)

Members can flag content and delete their own accounts (Phase 7 legal gate).

- **Content reports.** A member's “Report” on a post or comment creates a report
  row. There is **no web admin in production** (see above), so review them over
  SSH. List the open queue:

  ```bash
  docker compose -f docker-compose.prod.yml exec -T backend python manage.py shell -c \
    "from api.models import Report; [print(r.id, r.status, r.reason, r.content_object) for r in Report.objects.filter(status='open')]"
  ```

  Read the flagged post/comment, delete it if it breaks the Terms, then set the
  report's **status** to `resolved` (or `dismissed` if there's nothing to do) to
  clear the queue. This is more awkward than the old LAN-only admin UI, and that
  is the accepted cost of not exposing an admin login on a public host — see the
  admin section above for the options if it ever becomes a real burden.

- **A reported *message* works differently, on purpose.** You can't open the
  message or its conversation — the admin shows no message text anywhere else
  (Phase 9b; see
  [reference/messaging.md](reference/messaging.md#moderation-a-report-is-the-only-window)).
  The report itself carries a **snapshot** of the flagged text, taken when it was
  reported, and that's all you get. So the action isn't “delete the content”
  (you can't, and deletion is the sender's own soft-delete) — it's judging the
  **person**: warn them, deactivate the account (`is_active` off in **Accounts ›
  Users**), or dismiss. Then set the status as above.

- **Account deletion is self-service and permanent.** A member deletes their own
  account from **Settings** (password-reconfirmed). It hard-deletes their account
  and content, removes their uploaded image files from `/srv/timeline/media`, and
  hands any group they solely administered to the longest-standing remaining
  member (a group they were the only member of is deleted). You don’t need to do
  anything. To action a deletion request over SSH instead (e.g. someone locked
  out), from inside the repo on the box:

  ```bash
  docker compose -f docker-compose.prod.yml exec -u app backend python manage.py shell -c \
    "from api.views import delete_account; from django.contrib.auth import get_user_model as g; delete_account(g().objects.get(email='them@example.com'))"
  ```

- **Backups caveat.** Deleted data can linger in the nightly encrypted R2 backups
  until they age out (~30 days) — this is stated in the privacy policy. There’s no
  need (and no clean way) to surgically scrub a single account from historical
  encrypted backups; they roll over on their own.

## Single-disk hosts (`TIMELINE_REQUIRE_DATA_MOUNT`)

`deploy.sh`, `autodeploy.sh` and `backup.sh` all begin by requiring
`/srv/timeline` to be a real **mount point**. That guard is right on a two-disk
machine — the old home box kept data on a separate NVMe, and "not mounted" would
have meant Postgres silently writing to the OS disk. Lightsail has **one** volume,
so `/srv/timeline` is an ordinary directory and the check can only ever fail.

Set `TIMELINE_REQUIRE_DATA_MOUNT=0` and the scripts assert the bind targets
**exist** instead — which is the part that still catches a real mistake, since
Docker's bind driver won't create them. It lives in the systemd units:

```ini
# /etc/systemd/system/timeline-autodeploy.service  and  backup.service
[Service]
Environment=TIMELINE_REQUIRE_DATA_MOUNT=0
```

and is passed inline for hand runs (`TIMELINE_REQUIRE_DATA_MOUNT=0
./deploy/deploy.sh`). `TIMELINE_DATA_MOUNT` moves the path if ever needed. Both
default to the stricter two-disk behaviour, so nothing changes for anyone
copying this setup onto a machine with a real data disk.

`backup.sh` additionally refuses to run if `MEDIA_DIR` is missing, **whatever the
host shape** — media goes off-site by `rclone sync`, so backing up an absent media
tree would mirror that emptiness and delete the photos the backup exists to
protect. Covered by `deploy/tests/test_backup_guards.sh`.

## Verifying data really is where it should be

After the first `up`, confirm Postgres + media resolve onto the data path:

```bash
docker volume inspect timeline-prod_postgres_data -f '{{ .Options.device }}'  # -> /srv/timeline/postgres
docker volume inspect timeline-prod_media        -f '{{ .Options.device }}'  # -> /srv/timeline/media
du -sh /srv/timeline/postgres /srv/timeline/media
```

A quick end-to-end check that the bind really works — write through the backend
container and see it land on the host:

```bash
docker exec -u app timeline-prod-backend-1 sh -c 'echo probe > /app/media/probe.txt'
# owner should be 1000 (the deploy user) — that's what makes a restore writable
sudo ls -ln /srv/timeline/media/probe.txt && docker exec -u app timeline-prod-backend-1 rm /app/media/probe.txt
```

## Reboot-survival

`restart: unless-stopped` on every service means the stack comes back after a
reboot. To prove it: `sudo reboot`, wait, then `ssh timeline-aws` and check
`docker compose -f docker-compose.prod.yml ps` shows everything `Up`, and the
site loads. Lightsail bills the instance whether it's running or stopped, so
there's rarely a reason to stop it; the static IP survives a stop/start anyway.

## Rollback

Every release is still on GHCR under its own tag, so the quickest rollback is to
run the previous one — no rebuild:

```bash
sudo systemctl stop timeline-autodeploy.timer   # or the next tick undoes this
TIMELINE_TAG=v0.25.0 ./deploy/autodeploy.sh     # pins BOTH images to that release
```

`TIMELINE_TAG` is read by the GHCR override *and* by autodeploy's drift check, so
the box compares itself against the tag it's meant to be running. Remember to
restart the timer once you've rolled forward again — while it's stopped, nothing
deploys.

Or rebuild from a git checkout (the fallback path — note the image-name caveat
under "Routine deploy"):

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
for the why. **Without the drain running, notifications still appear in the
in-app activity centre but no phone ever buzzes** — the rows just accumulate
unsent, which is the failure mode to recognise.

**There is nothing to install.** Since #354 the drain is the `pushes` service in
the compose stack: a resident process running `send_pushes --loop`, which sweeps
the outbox every two seconds. It comes up with `docker compose up -d` like any
other service, `restart: unless-stopped` brings it back after a crash or a
reboot, and autodeploy recreates it on release alongside `backend` and `web`.

```bash
# is it alive? a heartbeat a minute, plus a line per real send
docker compose -f docker-compose.prod.yml logs -f pushes
```

Prove the send path by hand — safe to run repeatedly, and sends nothing:

```bash
docker compose -f docker-compose.prod.yml exec -T backend \
  python manage.py send_pushes --dry-run
```

Safe to run by hand alongside the resident drain: it claims rows with
`select_for_update(skip_locked=True)`, so a manual run takes different rows
rather than double-sending. Without `--loop` the command makes exactly one pass
and exits, which is what a hand-run and every test does.

### One-time migration off the old timer

Before #354 this was `send-pushes.timer`, a systemd unit firing a fresh Django
process once a minute. Those unit files are gone from the repo, **but `git pull`
cannot remove them from `/etc/systemd/system`** — so a box set up before that
release goes on running the old oneshot alongside the new container until it is
told not to. Nothing breaks if both run (`skip_locked` means they take different
rows); it is a wasted process a minute and two places to look. Once, on the box:

```bash
sudo systemctl disable --now send-pushes.timer
sudo rm -f /etc/systemd/system/send-pushes.{service,timer}
sudo systemctl daemon-reload

# confirm it's gone, and that the container has taken over
systemctl list-timers --all | grep send-pushes     # expect no output
docker compose -f docker-compose.prod.yml logs --tail 20 pushes
```

Set `EXPO_ACCESS_TOKEN` in `.env.prod` at the same time — see
`.env.prod.example`. Without it Expo accepts unauthenticated sends, meaning
anyone who learns one of your users' push tokens could push to them under your
app's name.

### Reading the log

`Sent 1, requeued 0 (queued up to 2.1s).` means Expo **accepted** one message —
not that a phone buzzed; that only shows up in a later receipt line, e.g.
`Checked 1 receipt(s); reaped 0 dead device(s).` A non-zero "reaped" is normal
and healthy: it's a device whose app was deleted or whose token was retired,
being removed so we stop pushing into the void.

**"queued up to Ns" is our half of push latency**, from the row being written by
the web request to it going to Expo. It is the number to look at before tuning
anything (#354): Expo → APNs/FCM → device adds another 1–5s that we can neither
see nor control, so if a push feels slow while this line says 2s, the delay isn't
ours and a tighter `PUSH_DRAIN_INTERVAL_SECONDS` will not fix it. To split the
two legs, note this number and the moment the phone actually buzzes — the
difference is Expo's. Values well above the drain interval mean a message push
was deliberately held; see
[the two hold rules](reference/notifications.md#how-often-it-drains-354).

Receipts are asked about ~15 min after the send, so a quiet gap between the two
lines is expected. `Gave up on N receipt(s) past Expo's window.` means Expo never
answered within its 24h retention — worth a glance if it's routine, since it
suggests the drain isn't running often enough to catch its own tickets.

`Alive: 30 drain(s) since the last report.` is the loop's heartbeat, once a
minute. **It exists because a healthy quiet stretch and a wedged process produce
identical output otherwise — nothing** — and the symptom of a wedged drain
("nobody's phone buzzes") looks exactly like nobody having sent anything. If the
heartbeat stops, that's the alarm. It sometimes carries `, N message push(es)
currently held back`, which is normal: see
[the two hold rules](reference/notifications.md#how-often-it-drains-354). A count
that never falls to zero is not — that would mean a misconfigured
`PUSH_MESSAGE_COOLDOWN_SECONDS` or `PUSH_MESSAGE_GRACE_SECONDS`.

The per-pass "Nothing queued." line is deliberately suppressed in `--loop`; at
two seconds a pass it would be 43,000 lines a day. A hand-run still prints it.

`Drain failed: …` on stderr is one pass that raised. The loop logs it, drops its
database connection and carries on ten seconds later, so a single line after a
Postgres restart is expected and self-healing. A *repeating* one is not.

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

> **Scope:** the probe hits the public hostname pinned to loopback
> (`--resolve …:127.0.0.1`), which tests the whole local serving stack — Caddy,
> gunicorn and Postgres — but *not* the inbound path from the internet (public
> DNS, the Lightsail firewall). That gap is real: the 2026-08-12 DDNS incident
> took the site down for the outside world while this check stayed green, because
> locally everything was fine. If you want to cover it, add a monitor that
> resolves the name normally from somewhere else — healthchecks.io can't, since
> it only receives pings, so this would be a second service (e.g. an uptime
> checker that fetches the URL itself).

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

| Item | Cost | Notes |
|------|------|-------|
| **Lightsail instance** (2 GB / 2 vCPU / 60 GB / 3 TB transfer) | **$12 / mo** | The bill. Fixed price — the reason Lightsail was chosen over raw EC2. |
| Lightsail automatic snapshots | ~**$0.60 / mo** | Charged on used space (~12 GB), not the 60 GB allocation. |
| Static IP | £0 | Free **while attached to a running instance**. Detached or orphaned, it starts costing. |
| Domain `your-timeline.net` | ~**£10–15 / year** (~£1 / mo) | Renews annually. |
| Cloudflare DNS | £0 | Free plan. One static A record. |
| Cloudflare R2 (encrypted backups) | £0 | Well within the 10 GB free tier — check with `rclone size timeline-crypt:`. |
| healthchecks.io (uptime + backup) | £0 | Free tier (up to 20 checks). |
| Resend (outbound email) | £0 | Free tier (3,000 emails/mo). |
| GitHub Actions + GHCR (CI + image registry) | £0 | Free for a public repo. |
| Let's Encrypt TLS | £0 | Free, auto-renewed by Caddy. |
| Electricity | £0 | No longer our problem. |

**Rough total: ~£13 / month inc. VAT**, plus the ~£12/yr domain. AWS bills in USD;
your card issuer converts.

The 3 TB monthly transfer allowance is thousands of times current usage, and the
data set is small (a 13 MB database and 39 MB of media at cutover), so nothing
here is close to a limit. **A budget alert (`timeline-monthly`, $20) is set in AWS
Billing** — Lightsail is fixed-price, but a stray charge should page you rather
than appear on a statement.

The predecessor was a home PC costing ~£4–8/month in electricity. This is dearer,
and buys a machine that is reachable from the internet — which the home
connection stopped being when the ISP moved it behind CGNAT.

## Provisioning a fresh box

Only needed if rebuilding from nothing. Done once in the Lightsail console
(`https://lightsail.aws.amazon.com/`):

1. **Region `eu-west-2` (London)** — set it *before* creating anything; an
   instance can't be moved between regions, and keeping real personal data in the
   UK is what the privacy policy implies. Any availability zone is fine.
2. **Linux/Unix → "Linux Operating System" → Ubuntu 24.04 LTS.** Not the
   "Linux Apps" blueprints — those ship WordPress/LAMP stacks we'd only remove.
3. **SSH key: upload your existing public key** rather than letting AWS generate
   one. An AWS-generated `.pem` is offered as a single download; lose it and you
   lose access.
4. **Plan: $12/mo (2 GB RAM / 2 vCPU / 60 GB SSD), "Dual-stack".** Don't take the
   1 GB tier — enough to *run* the app, not to build an image or run a migration
   without the OOM killer intervening. Don't take IPv6-only; the A record needs
   IPv4.
5. **Attach a static IP** and point the `your-timeline.net` A record at it.
6. **Firewall: TCP 22, 80, 443 only.** Nothing else — never Postgres.
7. **Set a billing budget alert** in AWS Billing before walking away.
8. Add **2 GB of swap** — 2 GB of RAM is thin for a Vite build:
   `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`,
   then add it to `/etc/fstab`.
9. Install Docker from Docker's own apt repository (Ubuntu's package lags), add
   `ubuntu` to the `docker` group, then follow "One-time server setup" above.

Reading the firewall from outside is easier than it looks: `nc -zv <ip> <port>`
distinguishes the two failure modes — a **timeout** means a firewall dropped the
packet, **"connection refused"** means it reached the box and nothing was
listening.

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
- **Exposure = a cloud box with a static IP.** The Lightsail firewall allows
  **only 22/80/443**; never Postgres. SSH stays open to any source deliberately —
  password auth is off, so the key is the gate, and pinning a source address
  would lock you out from a changing VPN exit or a CGNAT'd home connection.
  Administration is `manage.py` over SSH; there is no web admin (see above).
- **Why this isn't the home server any more.** It ran on a wiped home PC until
  August 2026, on the reasoning that a port-forward plus dynamic DNS is free and
  fully reversible. That reasoning had one load-bearing assumption — that the ISP
  gives the house a real public IP — and it stopped being true. The replacement
  ISP uses **CGNAT**: the connection shares one address with many customers,
  behind a carrier NAT, so inbound traffic never reaches the router and **no
  port-forward can work at any price**. Confirmed by `tracepath` showing hop 2 in
  `100.64.0.0/10` (RFC 6598). Diagnosing this is nastier than it sounds: DNS and
  the DDNS updater look perfectly healthy, the box serves 200 on loopback, and
  from outside TCP connects on 443 while the TLS handshake hangs.
  A **Cloudflare Tunnel** would have worked around it — outbound-only, so CGNAT
  stops mattering — but it was a day of work that the AWS migration threw away
  anyway, so the migration was brought forward instead. If a home-hosted setup is
  ever revisited, **check for CGNAT first**: it decides whether the whole approach
  is viable.
- **No dynamic DNS.** A static IP needs none, and a DDNS updater on a retired host
  is actively dangerous — see the warning in the DNS section above.
- **Data under `/srv/timeline`, pinned explicitly.** Docker named volumes default
  to `/var/lib/docker/volumes`; ours are pinned to `/srv/timeline/{postgres,media}`
  so `docker inspect` reports the real location and the compose file records where
  data lives. On the home box that path was a separate 1 TB NVMe, which is where
  the mount-point guard came from; on Lightsail it's a directory on the single
  60 GB volume, hence `TIMELINE_REQUIRE_DATA_MOUNT=0`. Keep an eye on headroom —
  roughly 12 GB is OS and Docker, leaving ~48 GB, against 39 MB of media at
  cutover. If media ever approaches a few GB, revisit object storage.
- **Media stays on disk rather than S3, on purpose.** `django-storages` is wired
  up and `DJANGO_MEDIA_STORAGE=s3` would switch it (see `backend/config/settings.py`),
  but moving would trade Caddy's per-request `forward_auth` gate for **signed URLs
  that stay valid regardless of what happens to the account behind them** — a
  banned member's saved links would keep working until expiry, and every image URL
  would change on every page load, breaking client caching. At this size the
  privacy property is worth more than the durability. Deferring is cheap: Django
  stores *relative* paths, so a later move needs no database rewrite.
- **Continuous deploy is pull-based and release-triggered.** The box forwards only
  80/443 and SSH-by-key, and we don't hand CI production credentials, so CD is
  **outbound from the box** — GitHub never reaches in.
  So: `gh release create vX.Y.Z` → a workflow builds + pushes images to GHCR (using
  the built-in `GITHUB_TOKEN`, no PAT); a systemd timer on the box polls every
  ~5 min, `docker compose pull`s, and redeploys **whenever a container isn't
  already running the pulled image**. That test is deliberately about *containers*,
  not images: the original "has the digest changed?" version answered a question
  that stops being useful the moment the image is already on disk, and the box
  spent six days serving old code behind a healthy `healthz` because of it
  (issue #104). Convergence — "make reality match the release" — is checkable on
  every tick; "did something new arrive?" is a one-shot event you can miss forever.
  Triggering on *release* (not every merge) keeps a deploy a deliberate human
  action with a version/changelog, and fork PRs can't publish releases so untrusted
  code never builds our images. Chosen a systemd timer over Watchtower for
  consistency with the box's other timers (backups, pushes, health) and transparency. Config
  (Caddyfile, compose files) travels via `git pull`; only the heavy image build is
  offloaded to CI, and the box stays on `main` so the manual `deploy.sh`
  build-from-source path still works as a fallback. **Security:** the whole
  pipeline's trust reduces to control of the GitHub account (2FA is the crown-jewel
  control); the box holds no registry write creds and images bake nothing secret
  (real secrets are injected at runtime from `.env.prod`).
- **Backups: encrypted to Cloudflare R2, media mirrored not snapshotted.** See
  `backup-restore.md` for the runbook. R2 was chosen (over B2 / self-managed)
  because it reuses the Cloudflare account, has 10 GB free + zero egress, and is
  S3-compatible.
  `rclone crypt` encrypts before anything leaves the box, and R2 is deliberately
  a *different provider* from the host — backups shouldn't share a blast radius
  with the thing they protect. Media is *mirrored*
  (not snapshotted) so off-site size ≈ live media, with changed/deleted files
  diverted to a dated `media-archive/` (30-day window) so a local wipe can't
  propagate to the backup.
- **Security hardening (from `/security-review`, no HIGH findings).** Three gaps
  were closed: (1) **uploaded media auth-gated** via Caddy `forward_auth` →
  `/api/media-auth/` (logged-in active members only; see `reference/feed-and-posts.md`);
  (2) **Django `/admin/` closed off** by a Caddy `remote_ip` allow-list,
  deliberately **fail-closed** — it *excludes* Docker's bridge range, so a NAT
  misconfig locks admin out (caught instantly) rather than silently opening it to
  the world; (3) **sign-up enumeration closed** (see `reference/accounts.md`).
  The allow-list was written for the home LAN. On a cloud host **nothing matches
  it**, so `/admin/` now 403s universally and administration moved to `manage.py`
  over SSH — a strengthening, kept on purpose rather than worked around.
- **The backend process is unprivileged, and that is also what makes the restore
  work.** Gunicorn runs as uid 1000, matching the deploy user, after a root-only
  bootstrap step that aligns the media tree's ownership (see "The backend runs
  unprivileged"). It was one mistake with two faces: root-written media was both
  the security exposure (#199) and the reason disaster recovery couldn't write
  media back (#197). Caddy stays root because the official image needs it to bind
  80/443, and it only ever reads media, never writes it.
- **Uptime = an on-box active probe + a dead-man's switch.** healthchecks.io is
  *passive* (it waits for pings, it does not probe your URL), so the active half
  lives on our side: a 5-min timer curls `GET /api/healthz/` (public, runs
  `SELECT 1` so "gunicorn up but Postgres down" is caught; 503 on DB error) and
  pings success/`/fail`. The probe hits the public hostname **pinned to loopback**
  (`curl --resolve …:127.0.0.1`), which exercises the real certificate, routing
  and DB without depending on DNS. That last part is the known blind spot: on
  2026-08-12 a stale DDNS updater pointed the domain at a dead host and this check
  stayed green throughout, because locally nothing was wrong. **A green uptime
  check is not proof the site is reachable.** Closing that properly needs a
  probe that resolves the name normally from somewhere else. If the box is down
  the timer can't run at all, so the missing ping goes overdue → the dead-man's
  alert fires. No `Persistent=true` on
  this timer (a catch-up ping would falsely claim the site was up during an
  outage).
