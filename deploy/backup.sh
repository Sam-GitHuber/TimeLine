#!/usr/bin/env bash
# Nightly off-site backup for the TimeLine home server (Phase 7).
#
# Backs up the two things that hold real user data:
#   1. The Postgres database — a logical `pg_dump` (custom format), taken from
#      inside the running `db` container. Portable and restorable with
#      pg_restore; far safer than copying Postgres's raw data files.
#   2. Uploaded media — the WHOLE of /srv/timeline/media, which the DB
#      references by path, so a DB-only backup would restore broken images.
#      **Whole tree on purpose, never an enumerated list of subdirectories.**
#      New kinds of upload arrive with new features (avatars, post photos, group
#      images, and chat photos as of Phase 9b M7, under media/messages/), and a
#      hardcoded list would silently stop backing one of them up — a data-loss
#      bug that only surfaces the day you need the backup. Adding an upload path
#      to the app must never require editing this script.
#
# Everything is pushed to an ENCRYPTED rclone remote (Cloudflare R2 behind an
# rclone `crypt` wrapper), so the copy that leaves the house is encrypted at
# rest. See docs/backup-restore.md for the one-time R2 + rclone setup.
#
# Storage strategy (why this fits a small beta in R2's free tier):
#   - DB dumps are tiny (compressed SQL) → keep a long DAILY history cheaply.
#   - Media is append-only → `rclone sync` keeps ONE mirror (~= live size), not
#     a full copy per night. Changed/deleted files are moved to a dated archive
#     rather than deleted, so a local wipe can't erase the backup.
#
# Run by backup.timer (systemd), nightly. Run as the deploy user (the one in the
# `docker` group and whose ~/.config/rclone holds the remote) — NOT root.
# Config is sourced from an env file outside the repo (see backup.env.example).
#   Default config path: /etc/timeline/backup.env
#
# Manual run (also how you'd take an ad-hoc backup before a risky deploy):
#   ./deploy/backup.sh
set -euo pipefail

CONFIG="${1:-/etc/timeline/backup.env}"
if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: config $CONFIG not found. Copy deploy/backup.env.example to it." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG"

# --- config with sensible defaults -----------------------------------------
: "${RCLONE_REMOTE:?set RCLONE_REMOTE in $CONFIG (the crypt remote, e.g. timeline-crypt:)}"
MEDIA_DIR="${MEDIA_DIR:-/srv/timeline/media}"
LOCAL_STAGE="${LOCAL_STAGE:-/srv/timeline/backups}"
LOCAL_KEEP="${LOCAL_KEEP:-7}"
DB_KEEP_DAYS="${DB_KEEP_DAYS:-30}"
MEDIA_ARCHIVE_KEEP_DAYS="${MEDIA_ARCHIVE_KEEP_DAYS:-30}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DATA_MOUNT="${TIMELINE_DATA_MOUNT:-/srv/timeline}"

# Whether DATA_MOUNT is expected to be a separate disk — see the long note in
# deploy/autodeploy.sh. 1 (default) = home box, two disks, the mount must be up.
# 0 = single-disk host (AWS Lightsail), where the mount check can only ever fail;
# the MEDIA_DIR check below is what still catches a real mistake there.
REQUIRE_DATA_MOUNT="${TIMELINE_REQUIRE_DATA_MOUNT:-1}"

# Refuse to back up unless the data we'd read is real data. A separate function
# so deploy/tests/test_backup_guards.sh can drive it without running a backup —
# main() dumps Postgres and talks to R2, which tests can't.
check_preconditions() {
  # Safety: never run if the NVMe data disk isn't mounted — the DB/media we'd
  # try to read wouldn't be the real data, and LOCAL_STAGE would land on the OS
  # SSD. deploy.sh guards the same way. Skipped on a single-disk host, where
  # there is no other disk to read the wrong data from.
  if [[ "$REQUIRE_DATA_MOUNT" == "1" ]] && ! mountpoint -q "$DATA_MOUNT"; then
    echo "ERROR: data disk $DATA_MOUNT is not mounted. Aborting backup." >&2
    echo "       (Single-disk host? Set TIMELINE_REQUIRE_DATA_MOUNT=0.)" >&2
    return 1
  fi

  # Whatever the host shape, refuse to back up a media tree that isn't there —
  # otherwise `rclone sync` would faithfully mirror an EMPTY directory over the
  # off-site copy and delete every photo in it. The archive (see
  # MEDIA_ARCHIVE_KEEP_DAYS) would hold them for a while, but this is the one
  # failure in this script that can destroy the backup it is meant to protect.
  # It matters most on a single-disk host, where the mount check above is off
  # and this is the only thing standing between a missing directory and a
  # wiped off-site mirror.
  if [[ ! -d "$MEDIA_DIR" ]]; then
    echo "ERROR: media dir $MEDIA_DIR does not exist. Aborting backup." >&2
    echo "       Refusing to sync an empty tree over the off-site copy." >&2
    return 1
  fi
}

main() {
  # Work from the repo root regardless of where this was invoked (so the
  # relative COMPOSE_FILE resolves), mirroring deploy.sh.
  cd "$(dirname "$0")/.."

  check_preconditions || exit 1

  local ts dump_file
  ts="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  mkdir -p "$LOCAL_STAGE"
  dump_file="$LOCAL_STAGE/db-$ts.dump"

  # --- 1. Dump the database -------------------------------------------------
  # pg_dump runs INSIDE the db container, so it reads POSTGRES_USER/DB straight
  # from the container's own env — this script never needs the DB credentials.
  # -Fc = custom format: compressed, and restorable selectively with pg_restore.
  # -T (no TTY) keeps the stream clean so it redirects to a file intact.
  echo "==> Dumping database -> $dump_file"
  if ! docker compose -f "$COMPOSE_FILE" exec -T db \
        sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$dump_file"; then
    echo "ERROR: pg_dump failed." >&2
    rm -f "$dump_file"
    exit 1
  fi
  # A truncated/empty dump is worse than no dump (it can overwrite a good one on
  # rotation). Sanity-check the size before trusting it.
  local size
  size="$(stat -c %s "$dump_file")"
  if (( size < 1024 )); then
    echo "ERROR: dump is suspiciously small (${size} bytes). Aborting." >&2
    rm -f "$dump_file"
    exit 1
  fi
  echo "    dump ok (${size} bytes)"

  # --- 2. Push the DB dump off-site (encrypted) -----------------------------
  echo "==> Uploading DB dump to ${RCLONE_REMOTE}db/"
  rclone copy "$dump_file" "${RCLONE_REMOTE}db/" --transfers 4

  # --- 3. Mirror media off-site (encrypted) ---------------------------------
  # `sync` keeps R2 == the live media tree (one copy). --backup-dir diverts any
  # file that sync would overwrite/delete into a dated archive folder instead,
  # so accidental local deletions are recoverable and can't be mirrored away.
  echo "==> Syncing media to ${RCLONE_REMOTE}media/"
  rclone sync "$MEDIA_DIR/" "${RCLONE_REMOTE}media/" \
    --backup-dir "${RCLONE_REMOTE}media-archive/$ts" \
    --transfers 8

  # --- 4. Prune old copies --------------------------------------------------
  echo "==> Pruning old backups"
  # Off-site DB dumps older than the retention window.
  rclone delete "${RCLONE_REMOTE}db/" --min-age "${DB_KEEP_DAYS}d" || true
  # Off-site media-archive (changed/deleted files) older than its window.
  rclone delete "${RCLONE_REMOTE}media-archive/" --min-age "${MEDIA_ARCHIVE_KEEP_DAYS}d" || true
  rclone rmdirs "${RCLONE_REMOTE}media-archive/" --leave-root || true
  # Local staged dumps: keep the newest LOCAL_KEEP, delete the rest. The
  # trailing `|| true` matters: under `set -o pipefail`, if the glob ever
  # matches nothing `ls` exits non-zero and would abort the script here —
  # skipping the success healthcheck ping below and faking a backup failure.
  # shellcheck disable=SC2012
  ls -1t "$LOCAL_STAGE"/db-*.dump 2>/dev/null | tail -n +"$((LOCAL_KEEP + 1))" | xargs -r rm -f || true

  # --- 5. Success signal ----------------------------------------------------
  # Only pinged on full success (this line is only reached if nothing above
  # exited non-zero, thanks to `set -e`). A missed ping => alert => no silent
  # backup rot. Failures to reach the URL must not fail the backup itself.
  if [[ -n "${HEALTHCHECK_URL:-}" ]]; then
    curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null 2>&1 || echo "WARN: healthcheck ping failed" >&2
  fi

  echo "==> Backup complete ($ts)."
}

# Executed directly -> run a backup. Sourced (deploy/tests/test_backup_guards.sh)
# -> just define the functions above, so the guards can be tested without
# dumping Postgres or touching R2. Mirrors deploy/autodeploy.sh.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
