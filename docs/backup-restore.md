# Backups & restore (home-server production)

How TimeLine's data is backed up off the box and how to restore it. The *why*
(R2, encrypted, media mirrored not snapshotted) lives in `docs/deploy.md`
("Why it's built this way"); this is the *how*.

**What's protected, and why both halves matter:**

| Thing        | How                                    | Where it lands |
|--------------|----------------------------------------|----------------|
| Database     | nightly `pg_dump` (custom format)      | R2, `db/`, encrypted, ~30 daily dumps |
| Uploaded media | nightly `rclone sync` (one mirror)   | R2, `media/`, encrypted |

The DB references media by path, so restoring one without the other gives you
broken images — both are backed up together, every night.

**Design choices worth knowing:**
- Everything is **encrypted before it leaves the house** (`rclone crypt`), so
  Cloudflare only ever holds ciphertext.
- Media is **mirrored, not snapshotted**: off-site media storage ≈ your *live*
  media size, not multiplied by retention. DB dumps are tiny, so a long daily
  history is cheap. This keeps a small beta comfortably inside R2's 10 GB free
  tier; past that, R2 is ~$0.015/GB-month with **zero egress**.
- Files changed/deleted locally are moved to a dated `media-archive/` on R2
  (kept 30 days) rather than deleted — so a local wipe can't erase the backup.

---

## One-time setup (on the box)

### 1. Create the R2 bucket + an API token

In the Cloudflare dashboard → **R2**:

1. **Create bucket** — name it `timeline-backups`. Pick a location near you.
2. **Manage R2 API Tokens** → **Create API token**:
   - Permission: **Object Read & Write**
   - Scope it to the `timeline-backups` bucket only (least privilege).
   - Save the **Access Key ID**, **Secret Access Key**, and the **S3 endpoint**
     (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`) — shown once.

### 2. Install rclone

```bash
sudo -v ; curl https://rclone.org/install.sh | sudo bash
rclone version
```

### 3. Configure two rclone remotes

We layer two remotes: a raw R2 one, and a `crypt` one that wraps it and does the
encryption. **backup.sh only ever talks to the crypt remote.**

First generate a strong crypt password and salt — **write these down in your
password manager now** (see the warning below):

```bash
openssl rand -base64 32     # -> use as the crypt PASSWORD
openssl rand -base64 32     # -> use as the crypt SALT (password2)
```

Then create both remotes (fill in the three R2 values and the two secrets):

```bash
# Raw R2 (S3-compatible). Region is literally "auto" for R2.
# no_check_bucket=true is REQUIRED: the API token is scoped to just this bucket
# (least privilege), so it lacks the account-level CreateBucket permission rclone
# otherwise tries to use on first upload — without this flag you get a 403
# "AccessDenied / CreateBucket" on the first write.
rclone config create timeline-r2 s3 \
  provider=Cloudflare \
  access_key_id=YOUR_R2_ACCESS_KEY_ID \
  secret_access_key=YOUR_R2_SECRET_ACCESS_KEY \
  endpoint=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com \
  region=auto \
  no_check_bucket=true

# Encryption layer, pointed at a path inside the bucket. rclone obscures the
# passwords into the config automatically when created this way.
rclone config create timeline-crypt crypt \
  remote=timeline-r2:timeline-backups \
  filename_encryption=standard \
  directory_name_encryption=true \
  password=YOUR_CRYPT_PASSWORD \
  password2=YOUR_CRYPT_SALT
```

Verify it works end to end (writes + reads back through the encryption):

```bash
echo "hello $(date)" > /tmp/canary.txt
rclone copy /tmp/canary.txt timeline-crypt:canary/
rclone cat timeline-crypt:canary/canary.txt      # should print your line
rclone delete timeline-crypt:canary/ && rm /tmp/canary.txt
```

> ### ⚠️ Save the keys OFF the box — this is the one thing you cannot lose
> The rclone config (`~/.config/rclone/rclone.conf`) holds the crypt password in
> a **reversible** ("obscured", not encrypted) form. Anyone with that file can
> decrypt the backups — and if you lose it *and* the passwords, the backups are
> **permanently unrecoverable** (that's the point of encryption).
>
> So, right now: store the **crypt password + salt** and the **R2 keys** in your
> password manager, and keep a copy of `rclone.conf` somewhere safe that is
> **not** this server (e.g. an encrypted note). Treat `rclone.conf` as a secret:
> ```bash
> chmod 600 ~/.config/rclone/rclone.conf
> ```

### 4. Create the backup config

```bash
sudo mkdir -p /etc/timeline
sudo cp deploy/backup.env.example /etc/timeline/backup.env
sudo nano /etc/timeline/backup.env      # defaults are fine; set HEALTHCHECK_URL if you have one
# The backup runs as the DEPLOY USER (not root), so it must be able to READ this
# file — hand it to that user and keep it locked to just them:
sudo chown "$USER:$USER" /etc/timeline/backup.env
sudo chmod 600 /etc/timeline/backup.env
```

Also create the local staging dir the backup writes dumps to before upload. It
sits under the root-owned `/srv/timeline`, so create it and give it to the
deploy user (otherwise the backup's `mkdir` fails):

```bash
sudo mkdir -p /srv/timeline/backups
sudo chown "$USER:$USER" /srv/timeline/backups
```

### 5. First backup by hand

```bash
./deploy/backup.sh
```

Confirm the objects actually landed in R2 (names are encrypted, so list through
the crypt remote to see real names):

```bash
rclone lsf timeline-crypt:db/            # -> db-2026-...Z.dump
rclone ls  timeline-crypt:media/ | head  # -> your media files
rclone size timeline-crypt:              # total off-site size
```

### 6. Install the nightly timer

```bash
sudo cp deploy/backup.service deploy/backup.timer /etc/systemd/system/
sudo nano /etc/systemd/system/backup.service   # set User= and ExecStart= path
sudo systemctl daemon-reload
sudo systemctl enable --now backup.timer

systemctl list-timers backup.timer --no-pager   # shows next run
journalctl -u backup.service --no-pager -n 30    # last run's log
```

---

## Test the restore (do this before inviting anyone — it's the real DoD item)

**A backup you've never restored is not a backup.** This restores into a
**scratch** database and a **scratch** media dir, so production is never touched.

First, note the live numbers to compare against:

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM accounts_user;"'
find /srv/timeline/media -type f | wc -l
```

Now restore the latest backup into scratch targets and verify. Setting
`TARGET_DB` alone is enough — the media dir defaults to a matching scratch path
under the staging dir (`/srv/timeline/backups/restore-<TARGET_DB>-media`), so
there's no way to forget it and accidentally overwrite live media:

```bash
TARGET_DB=timeline_restore_test ./deploy/restore.sh latest
```

It prints the restored **user count** and **media file count** at the end —
they should match the live numbers above. To prove the media came back intact
(not just present), compare checksums of the live vs restored files — the two
sorted lists must be identical:

```bash
find /srv/timeline/media -type f -exec md5sum {} \; | awk '{print $1}' | sort
find /srv/timeline/backups/restore-timeline_restore_test-media -type f -exec md5sum {} \; | awk '{print $1}' | sort
```

Clean up the scratch copies:

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  sh -c 'dropdb -U "$POSTGRES_USER" timeline_restore_test'
rm -rf /srv/timeline/backups/restore-timeline_restore_test-media
```

> **Media round-trip caveat:** this test only proves what's in the backup at the
> time you run it. If you test with an empty media tree, you've only proven the
> DB path — re-run it once real photos exist so the media encrypt→R2→restore
> round-trip is exercised with actual files (the checksum check above is how).

Re-run this test occasionally (e.g. monthly) — backups rot silently otherwise.

---

## Real disaster recovery (restore over production)

Only when live data is actually lost/corrupt. This **overwrites** the live DB
and media and asks you to type a confirmation phrase.

The script **stops the app** (`backend` + `web`) for the duration so nothing
writes to the database while `pg_restore` is dropping and recreating objects,
then brings it back up automatically once the restore succeeds. `db` stays up
(the restore runs through it). If the restore aborts partway, the app is left
stopped on purpose — the script prints the `docker compose … up -d` command to
bring it back once you've resolved the problem.

On a rebuilt box, first do the normal deploy setup (`docs/deploy.md`) so the
stack + rclone config exist, then:

```bash
./deploy/restore.sh              # interactive: restores the latest dump to prod
# or a specific dump:
./deploy/restore.sh db-2026-07-10T03-30-05Z.dump
```

(List available dumps with `rclone lsf timeline-crypt:db/`.)

---

## Monitoring & retention

- **Silent failure is the danger.** Set `HEALTHCHECK_URL` in `backup.env` to a
  free [healthchecks.io](https://healthchecks.io) check; backup.sh pings it only
  on success, so a *missing* ping alerts you. Also glance at
  `journalctl -u backup.service` now and then.
- **Retention** is set in `backup.env`: `DB_KEEP_DAYS` (default 30) daily DB
  dumps off-site, `MEDIA_ARCHIVE_KEEP_DAYS` (default 30) for changed/deleted
  media, `LOCAL_KEEP` (default 7) recent dumps on the local disk for fast
  restore.
- **Cost:** for a small beta this stays within R2's 10 GB free tier. Check
  actual usage any time with `rclone size timeline-crypt:` and the R2 dashboard.
