#!/usr/bin/env bash
# Tests for deploy/backup.sh's preconditions.
#
# Run it from anywhere:  ./deploy/tests/test_backup_guards.sh
# CI runs it in the "deploy-scripts" job (.github/workflows/main.yml).
#
# HOW IT WORKS. backup.sh only runs a backup when executed directly, so this
# harness *sources* it (passing a temp config as $1, which is what the script
# reads its settings from) and calls `check_preconditions` on its own. That
# keeps the tests away from Postgres, rclone and the real R2 remote entirely.
#
# WHY THESE MATTER. The guards decide whether a backup is allowed to proceed,
# and the media one is the single most destructive failure mode in the whole
# script: media is pushed with `rclone sync`, so running with an empty or
# missing media directory would mirror that emptiness off-site and delete the
# photos it exists to protect. The dated archive would hold them for
# MEDIA_ARCHIVE_KEEP_DAYS, but that is a recovery window, not a safety net.
#
# Deliberately plain bash, matching test_autodeploy.sh — no framework, runs the
# same on the box, on macOS (bash 3.2) and in CI.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../backup.sh"

TESTS_RUN=0
FAILURES=0
CURRENT=""
STATE=""

new_world() {
  CURRENT="$1"
  STATE="$(mktemp -d "${TMPDIR:-/tmp}/backup-test.XXXXXX")"
  mkdir -p "$STATE/data"
  # A minimal config: enough for backup.sh to source without tripping its own
  # required-value checks. Nothing here points at anything real.
  cat >"$STATE/backup.env" <<EOF
RCLONE_REMOTE=test-remote:
MEDIA_DIR=$STATE/data/media
LOCAL_STAGE=$STATE/data/backups
COMPOSE_FILE=docker-compose.prod.yml
HEALTHCHECK_URL=
EOF
}

# $1 = TIMELINE_REQUIRE_DATA_MOUNT ("" leaves it unset, to test the default)
run_guard() {
  (
    if [[ -n "$1" ]]; then
      export TIMELINE_REQUIRE_DATA_MOUNT="$1"
    else
      unset TIMELINE_REQUIRE_DATA_MOUNT
    fi
    export TIMELINE_DATA_MOUNT="$STATE/data"
    # shellcheck source=../backup.sh
    source "$SCRIPT" "$STATE/backup.env"
    check_preconditions
  ) >"$STATE/out.log" 2>&1
  printf '%s' "$?" >"$STATE/exit_code"
}

fail() {
  FAILURES=$((FAILURES + 1))
  echo "FAIL: $CURRENT — $1"
  echo "--- output ---"
  sed 's/^/    /' "$STATE/out.log"
}

assert_ok() {
  local code; code="$(cat "$STATE/exit_code")"
  [[ "$code" == "0" ]] || fail "expected exit 0, got $code"
}

assert_fails() {
  local code; code="$(cat "$STATE/exit_code")"
  [[ "$code" != "0" ]] || fail "expected a non-zero exit, got 0"
}

assert_output_contains() {
  grep -q -- "$1" "$STATE/out.log" || fail "expected output to mention: $1"
}

finish_case() {
  TESTS_RUN=$((TESTS_RUN + 1))
  rm -rf "$STATE"
}

# --- cases -------------------------------------------------------------------

# Single-disk host (AWS), media present: the ordinary case there — back up even
# though nothing is mounted at the data path.
test_single_disk_ok() {
  new_world "single_disk_ok"
  mkdir -p "$STATE/data/media"
  run_guard 0
  assert_ok
  finish_case
}

# THE DANGEROUS ONE. Single-disk host with the media directory gone (a failed
# restore, a typo'd path, a volume that didn't mount). Without this check the
# next `rclone sync` mirrors an empty tree over the off-site copy and takes
# every photo with it.
test_single_disk_missing_media_aborts() {
  new_world "single_disk_missing_media_aborts"
  # data/ exists, data/media deliberately does not
  run_guard 0
  assert_fails
  assert_output_contains "does not exist"
  assert_output_contains "Refusing to sync an empty tree"
  finish_case
}

# The home box's default: a plain directory is not a mount point, so a data disk
# that failed to mount must abort rather than back up whatever the OS disk holds.
test_requires_mount_by_default() {
  new_world "requires_mount_by_default"
  mkdir -p "$STATE/data/media"
  run_guard 1
  assert_fails
  assert_output_contains "is not mounted"
  finish_case
}

# With the variable UNSET the strict check must still apply — otherwise a future
# edit could flip the default and silently drop the home box's protection with
# every other case here still green.
test_default_is_strict() {
  new_world "default_is_strict"
  mkdir -p "$STATE/data/media"
  run_guard ""
  assert_fails
  assert_output_contains "is not mounted"
  finish_case
}

# Sourcing must NOT run a backup — the harness above depends on it, and so does
# anyone poking at the script interactively.
test_sourcing_does_not_back_up() {
  new_world "sourcing_does_not_back_up"
  mkdir -p "$STATE/data/media"
  ( source "$SCRIPT" "$STATE/backup.env" ) >"$STATE/out.log" 2>&1
  printf '%s' "$?" >"$STATE/exit_code"
  assert_ok
  grep -qi "Backup complete\|Dumping\|Uploading" "$STATE/out.log" &&
    fail "sourcing the script ran a backup"
  finish_case
}

test_single_disk_ok
test_single_disk_missing_media_aborts
test_requires_mount_by_default
test_default_is_strict
test_sourcing_does_not_back_up

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "ok — $TESTS_RUN backup guard cases passed"
  exit 0
fi
echo "$FAILURES of $TESTS_RUN backup guard cases failed"
exit 1
