#!/usr/bin/env bash
# Restore TimeLine from an off-site backup (Phase 7).
#
# This is the OTHER half of backup.sh — a backup you've never restored is not a
# backup. Use it two ways:
#
#   1. TEST (safe, non-destructive) — restore into a scratch database + scratch
#      media dir and verify, WITHOUT touching production. This is how you prove
#      the backups actually work (Phase 7 DoD). See docs/backup-restore.md.
#         TARGET_DB=timeline_restore_test \
#         TARGET_MEDIA_DIR=/srv/timeline/restore-test-media \
#           ./deploy/restore.sh latest
#
#   2. REAL disaster recovery — restore into the LIVE database + media. This
#      OVERWRITES current data and requires typing a confirmation phrase.
#         ./deploy/restore.sh            # interactive: pick a dump, restore to prod
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

# Restore targets. Default to PRODUCTION; override via env for the safe test.
#   TARGET_DB        — database name to restore into (default: the live DB)
#   TARGET_MEDIA_DIR — directory to restore media into (default: the live media)
TARGET_MEDIA_DIR="${TARGET_MEDIA_DIR:-/srv/timeline/media}"

WHICH="${1:-latest}"   # a DB dump filename (as shown by --list) or "latest"

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

main() {
  cd "$(dirname "$0")/.."

  # Resolve which live DB name we're targeting (read from the container env if
  # TARGET_DB wasn't overridden, so a plain prod restore "just works").
  local live_db target_db
  live_db="$(dc exec -T db sh -c 'printf %s "$POSTGRES_DB"')"
  target_db="${TARGET_DB:-$live_db}"

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

  # --- confirmation ---------------------------------------------------------
  # Only a restore into the LIVE data is destructive; make the operator type it.
  if [[ "$target_db" == "$live_db" || "$TARGET_MEDIA_DIR" == /srv/timeline/media ]]; then
    echo
    echo "This will OVERWRITE the data shown above. This cannot be undone."
    read -r -p "Type 'restore production' to proceed: " reply
    [[ "$reply" == "restore production" ]] || { echo "Aborted."; exit 1; }
  fi

  # --- fetch the dump locally ----------------------------------------------
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
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
  echo "==> Restoring media into ${TARGET_MEDIA_DIR}..."
  mkdir -p "$TARGET_MEDIA_DIR"
  rclone copy "${RCLONE_REMOTE}media/" "$TARGET_MEDIA_DIR/" --transfers 8

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

main "$@"
