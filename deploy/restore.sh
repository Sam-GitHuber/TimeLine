#!/usr/bin/env bash
# Restore TimeLine from an off-site backup (Phase 7).
#
# This is the OTHER half of backup.sh — a backup you've never restored is not a
# backup. Use it two ways:
#
#   1. TEST (safe, non-destructive) — restore into a scratch database + scratch
#      media dir and verify, WITHOUT touching production. This is how you prove
#      the backups actually work (Phase 7 DoD). See docs/backup-restore.md.
#         TARGET_DB=timeline_restore_test ./deploy/restore.sh latest
#      (Set TARGET_DB alone and the media dir defaults to a scratch path too —
#       you can't accidentally clobber live media by forgetting TARGET_MEDIA_DIR.)
#
#   2. REAL disaster recovery — restore into the LIVE database + media. This
#      OVERWRITES current data and requires typing a confirmation phrase. The
#      app (backend + web) is stopped for the duration so nothing writes to the
#      database mid-restore, then brought back up automatically on success.
#         ./deploy/restore.sh            # interactive: pick a dump, restore to prod
#
#   3. PREFLIGHT — run every check the real restore does before it becomes
#      destructive, against the REAL production targets, and stop there. It does
#      not stop the app, write to the database or sync media. This is how the
#      monthly rehearsal covers the live path without restoring over it (#197):
#         ./deploy/restore.sh --preflight
#
# Config (the rclone remote, compose file) is read from the same env file as
# backup.sh: /etc/timeline/backup.env.
set -euo pipefail

CONFIG="${CONFIG:-/etc/timeline/backup.env}"
if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: config $CONFIG not found." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG"

: "${RCLONE_REMOTE:?set RCLONE_REMOTE in $CONFIG}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

# Restore targets. Both default to PRODUCTION; override via env for a safe test.
#   TARGET_DB        — database name to restore into (default: the live DB)
#   TARGET_MEDIA_DIR — directory to restore media into (default: the live media)
#
# Safety: if TARGET_DB names a scratch DB but TARGET_MEDIA_DIR was left unset, a
# forgotten var must NOT silently restore media over live — that would defeat a
# "test". Derive a scratch media dir from the DB name instead, so a test that
# only overrides the DB stays entirely off production.
#
# It lives under LOCAL_STAGE (the deploy user owns that, on the NVMe data disk) —
# NOT directly under /srv/timeline, which is root-owned and would make `mkdir`
# fail for the non-root deploy user this script runs as.
if [[ -n "${TARGET_DB:-}" && -z "${TARGET_MEDIA_DIR:-}" ]]; then
  TARGET_MEDIA_DIR="${LOCAL_STAGE:-/srv/timeline/backups}/restore-${TARGET_DB}-media"
fi
TARGET_MEDIA_DIR="${TARGET_MEDIA_DIR:-/srv/timeline/media}"

# --preflight: run the checks, report, change nothing. Anything else is the dump
# to restore.
PREFLIGHT_ONLY=0
if [[ "${1:-}" == "--preflight" ]]; then
  PREFLIGHT_ONLY=1
  shift
fi
WHICH="${1:-latest}"   # a DB dump filename (as shown by --list) or "latest"

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

# Why the media target might not be writable, and how to fix it. Its own
# function only so both failure paths below print the same thing.
media_permission_hint() {
  echo "       The backend container aligns that tree to uid 1000 — the deploy" >&2
  echo "       user — every time it boots (backend/entrypoint.prod.sh). If it is" >&2
  echo "       still root-owned, the box has not yet run a release carrying that" >&2
  echo "       change. One-off fix:" >&2
  echo "         sudo chown -R 1000:1000 $1" >&2
}

# Prove the media target can actually be written BEFORE anything destructive
# happens. This is the check whose absence made a real restore a mid-incident
# surprise (issue #197): the media sync is the LAST step of a restore, so
# without it the app is already stopped and the database already overwritten by
# the time a permissions problem shows itself — the worst possible moment to
# start debugging one.
#
# A separate function so deploy/tests/test_restore_preflight.sh can drive it
# without rclone, Docker or a real backup — the same shape as backup.sh's
# check_preconditions.
check_media_writable() {
  local dir="$1"
  if [[ ! -d "$dir" ]] && ! mkdir -p "$dir" 2>/dev/null; then
    echo "ERROR: cannot create the media target $dir (running as $(id -un))." >&2
    media_permission_hint "$dir"
    return 1
  fi
  # Writing is the only honest test: the directory can be readable, listable and
  # still refuse a new file, which is exactly the case that broke.
  local probe="$dir/.restore-write-probe.$$"
  if ! touch "$probe" 2>/dev/null; then
    echo "ERROR: cannot write into the media target $dir (running as $(id -un))." >&2
    media_permission_hint "$dir"
    return 1
  fi
  rm -f "$probe"
}

# --- cleanup / safety-net ---------------------------------------------------
# Globals so the EXIT trap (which runs outside main's scope) can see them.
tmp=""
app_stopped=0
restore_ok=0
cleanup() {
  [[ -n "$tmp" ]] && rm -rf "$tmp"
  # If we stopped the app for a live restore and never reached the successful
  # restart, leave a loud, copy-pasteable way to bring it back — don't strand
  # the operator with the site down and no hint.
  if (( app_stopped )) && (( ! restore_ok )); then
    echo >&2
    echo "!! Restore did not finish and the app is STILL STOPPED." >&2
    echo "   Once you've sorted out the problem, bring it back up with:" >&2
    echo "     docker compose -f $COMPOSE_FILE up -d" >&2
  fi
}
trap cleanup EXIT

main() {
  cd "$(dirname "$0")/.."

  # Resolve which live DB name we're targeting (read from the container env if
  # TARGET_DB wasn't overridden, so a plain prod restore "just works").
  local live_db target_db
  live_db="$(dc exec -T db sh -c 'printf %s "$POSTGRES_DB"')"
  target_db="${TARGET_DB:-$live_db}"

  # Are we touching live production data (DB and/or media)? Drives both the
  # confirmation prompt and whether we quiesce the app.
  local restoring_live=0
  if [[ "$target_db" == "$live_db" || "$TARGET_MEDIA_DIR" == /srv/timeline/media ]]; then
    restoring_live=1
  fi

  # --- pick the DB dump -----------------------------------------------------
  local dump_name
  if [[ "$WHICH" == "latest" ]]; then
    # rclone shows DECRYPTED names through the crypt remote; newest last.
    dump_name="$(rclone lsf "${RCLONE_REMOTE}db/" --include 'db-*.dump' | sort | tail -1)"
    [[ -n "$dump_name" ]] || { echo "ERROR: no DB dumps found at ${RCLONE_REMOTE}db/" >&2; exit 1; }
  else
    dump_name="$WHICH"
  fi
  echo "==> DB dump:      ${RCLONE_REMOTE}db/${dump_name}"
  echo "==> Target DB:    ${target_db}$( [[ "$target_db" == "$live_db" ]] && echo '   <-- LIVE PRODUCTION DATABASE' )"
  echo "==> Target media: ${TARGET_MEDIA_DIR}$( [[ "$TARGET_MEDIA_DIR" == /srv/timeline/media ]] && echo '   <-- LIVE PRODUCTION MEDIA' )"

  # --- preflight: everything that must hold BEFORE we become destructive ----
  # The ORDER is the point, more than the checks themselves. Below this block
  # the script stops the app and runs `pg_restore --clean`; a failure after that
  # leaves the site down with a half-replaced database and an operator debugging
  # permissions mid-incident. Every reason to refuse belongs here, where
  # refusing still costs nothing.
  echo
  echo "==> Preflight..."
  check_media_writable "$TARGET_MEDIA_DIR" || exit 1
  echo "    media target is writable"
  # Catches a mistyped dump name now rather than after the app is stopped. For
  # "latest" this is redundant (the name came from a listing) — one cheap call
  # is worth not having two paths to reason about.
  if ! rclone lsf "${RCLONE_REMOTE}db/" --include "$dump_name" | grep -q .; then
    echo "ERROR: dump '${dump_name}' not found at ${RCLONE_REMOTE}db/." >&2
    exit 1
  fi
  echo "    dump is present off-site"

  if (( PREFLIGHT_ONLY )); then
    echo
    echo "==> Preflight OK — the real restore path is clear. Nothing was changed."
    exit 0
  fi

  # --- confirmation ---------------------------------------------------------
  # Only a restore into the LIVE data is destructive; make the operator type it.
  if (( restoring_live )); then
    echo
    echo "This will OVERWRITE the data shown above. This cannot be undone."
    read -r -p "Type 'restore production' to proceed: " reply
    [[ "$reply" == "restore production" ]] || { echo "Aborted."; exit 1; }
  fi

  # --- quiesce the app (live restore only) ----------------------------------
  # pg_restore --clean drops & recreates every object; if gunicorn is still
  # connected and writing, that means blocked DROPs and half-restored reads.
  # Stop the writers (backend + Caddy) but keep `db` up — pg_restore runs
  # through it. Restarted automatically once the restore succeeds (below).
  if (( restoring_live )); then
    echo "==> Stopping app (backend, web) so nothing writes during the restore..."
    dc stop backend web
    app_stopped=1
  fi

  # --- fetch the dump locally ----------------------------------------------
  tmp="$(mktemp -d)"
  echo "==> Downloading dump..."
  rclone copy "${RCLONE_REMOTE}db/${dump_name}" "$tmp/"

  # --- restore the database -------------------------------------------------
  # Ensure the target DB exists (createdb is a no-op-safe failure if it already
  # does; we ignore that). Then pg_restore with --clean --if-exists so it drops
  # and recreates objects idempotently, whether the target was empty or not.
  echo "==> Ensuring database '${target_db}' exists..."
  dc exec -T db sh -c "createdb -U \"\$POSTGRES_USER\" '${target_db}'" 2>/dev/null || true
  echo "==> Restoring database into '${target_db}'..."
  dc exec -T db sh -c \
    "pg_restore -U \"\$POSTGRES_USER\" -d '${target_db}' --clean --if-exists --no-owner" \
    < "$tmp/${dump_name}"

  # --- restore media --------------------------------------------------------
  # `sync` (not copy) so the target ends up an EXACT match of the backed-up
  # media — files deleted since the backup don't linger as orphans the DB no
  # longer references. This is the download direction only; it does not touch
  # the off-site R2 mirror, so the space-efficient one-copy backup is unchanged.
  echo "==> Restoring media into ${TARGET_MEDIA_DIR}..."
  mkdir -p "$TARGET_MEDIA_DIR"
  rclone sync "${RCLONE_REMOTE}media/" "$TARGET_MEDIA_DIR/" --transfers 8

  # --- bring the app back up (live restore only) ----------------------------
  if (( app_stopped )); then
    echo "==> Restore succeeded — bringing the app back up..."
    dc up -d
  fi
  restore_ok=1

  echo
  echo "==> Restore complete."
  echo "    DB rows (users):    $(dc exec -T db sh -c "psql -U \"\$POSTGRES_USER\" -d '${target_db}' -tAc 'SELECT count(*) FROM accounts_user;'" 2>/dev/null || echo '?')"
  echo "    Media files:        $(find "$TARGET_MEDIA_DIR" -type f | wc -l | tr -d ' ')"
  if [[ "$target_db" != "$live_db" ]]; then
    echo
    echo "    (Test restore. Clean up when done:"
    echo "       docker compose -f $COMPOSE_FILE exec -T db sh -c 'dropdb -U \"\$POSTGRES_USER\" ${target_db}'"
    echo "       rm -rf ${TARGET_MEDIA_DIR} )"
  fi
}

# Executed directly -> run a restore. Sourced (deploy/tests/test_restore_preflight.sh)
# -> just define the functions above, so the preflight guards can be tested
# without rclone, Docker or a real backup. Mirrors deploy/backup.sh.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
