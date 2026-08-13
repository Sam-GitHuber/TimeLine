#!/usr/bin/env bash
# Tests for deploy/restore.sh's preflight guard (issue #197).
#
# Run it from anywhere:  ./deploy/tests/test_restore_preflight.sh
# CI runs it in the "deploy-scripts" job (.github/workflows/main.yml).
#
# HOW IT WORKS. restore.sh only restores when executed directly, so this harness
# *sources* it (with CONFIG pointing at a temp env file, which is where the
# script reads its settings) and calls `check_media_writable` on its own. That
# keeps the tests away from Postgres, rclone and the real R2 remote entirely.
#
# WHY THIS MATTERS. restore.sh syncs media LAST, after it has stopped the app and
# run `pg_restore --clean`. Before this guard existed, a media directory the
# deploy user couldn't write to — which is what the box actually had, because the
# backend container wrote every photo there as root (#199) — surfaced as a failure
# at the very end of a real disaster recovery: site down, database already
# replaced, permissions to debug under pressure. The guard's whole job is to turn
# that into a refusal that costs nothing, so what's tested here is that it says no
# in the cases that would otherwise get that far.
#
# Deliberately plain bash, matching test_backup_guards.sh — no framework, runs
# the same on the box, on macOS (bash 3.2) and in CI.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../restore.sh"

TESTS_RUN=0
FAILURES=0
CURRENT=""
STATE=""

# Permission bits don't apply to root, so the "can't write" cases can only be
# tested as an ordinary user. CI runs as `runner` and the box's deploy user is
# `ubuntu`, so this normally stays 0 — it exists so a root shell reports skips
# rather than silent false passes.
IS_ROOT=0
[[ "$(id -u)" -eq 0 ]] && IS_ROOT=1
SKIPPED=0

new_world() {
  CURRENT="$1"
  STATE="$(mktemp -d "${TMPDIR:-/tmp}/restore-test.XXXXXX")"
  mkdir -p "$STATE/data"
  # A minimal config: enough for restore.sh to source without tripping its own
  # required-value checks. Nothing here points at anything real.
  cat >"$STATE/restore.env" <<EOF
RCLONE_REMOTE=test-remote:
LOCAL_STAGE=$STATE/data/backups
COMPOSE_FILE=docker-compose.prod.yml
EOF
}

# $1 = the media directory to check. Runs in a subshell because restore.sh sets
# `set -e` when sourced, which we don't want in the harness itself.
run_guard() {
  (
    export CONFIG="$STATE/restore.env"
    # shellcheck source=../restore.sh
    source "$SCRIPT"
    check_media_writable "$1"
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
  # chmod back, or a read-only directory defeats the cleanup.
  chmod -R u+rwX "$STATE" 2>/dev/null
  rm -rf "$STATE"
}

# Doesn't count towards TESTS_RUN — a skipped case proved nothing.
skip_case() {
  SKIPPED=$((SKIPPED + 1))
  echo "SKIP: $CURRENT — $1"
  chmod -R u+rwX "$STATE" 2>/dev/null
  rm -rf "$STATE"
}

# --- cases -------------------------------------------------------------------

# The ordinary case: the live media directory exists and the deploy user owns it
# (what the backend entrypoint now guarantees). Nothing to report, restore
# proceeds.
test_writable_dir_passes() {
  new_world "writable_dir_passes"
  mkdir -p "$STATE/data/media"
  run_guard "$STATE/data/media"
  assert_ok
  finish_case
}

# THE ONE THIS EXISTS FOR. The directory is there and listable, but not writable
# by the user running the restore — a root-owned /srv/timeline/media, exactly the
# state the box was in. Checking `-d` alone would have passed this.
test_unwritable_dir_aborts() {
  new_world "unwritable_dir_aborts"
  if (( IS_ROOT )); then skip_case "runs as root; permission bits don't apply"; return; fi
  mkdir -p "$STATE/data/media"
  chmod 500 "$STATE/data/media"
  run_guard "$STATE/data/media"
  assert_fails
  assert_output_contains "cannot write into the media target"
  # The message has to carry the fix, because it's read mid-disaster.
  assert_output_contains "sudo chown -R 1000:1000"
  finish_case
}

# A scratch target that doesn't exist yet is fine — the restore would create it,
# so the guard must not refuse a first test restore into a fresh path.
test_missing_dir_is_created() {
  new_world "missing_dir_is_created"
  run_guard "$STATE/data/restore-scratch-media"
  assert_ok
  [[ -d "$STATE/data/restore-scratch-media" ]] || fail "expected the target to be created"
  finish_case
}

# ...but a target whose PARENT can't be written is a refusal, not a `mkdir`
# error thrown at the operator halfway through.
test_uncreatable_dir_aborts() {
  new_world "uncreatable_dir_aborts"
  if (( IS_ROOT )); then skip_case "runs as root; permission bits don't apply"; return; fi
  mkdir -p "$STATE/data/locked"
  chmod 500 "$STATE/data/locked"
  run_guard "$STATE/data/locked/media"
  assert_fails
  assert_output_contains "cannot create the media target"
  finish_case
}

# The probe file must not be left behind: the media tree is mirrored off-site by
# backup.sh's `rclone sync`, so litter here propagates to R2.
test_probe_file_is_cleaned_up() {
  new_world "probe_file_is_cleaned_up"
  mkdir -p "$STATE/data/media"
  run_guard "$STATE/data/media"
  assert_ok
  if [[ -n "$(ls -A "$STATE/data/media")" ]]; then
    fail "expected the media dir to be left empty, found: $(ls -A "$STATE/data/media")"
  fi
  finish_case
}

# Sourcing must NOT run a restore — the harness above depends on it, and a
# restore is the single most destructive thing in this repo.
test_sourcing_does_not_restore() {
  new_world "sourcing_does_not_restore"
  (
    export CONFIG="$STATE/restore.env"
    source "$SCRIPT"
  ) >"$STATE/out.log" 2>&1
  printf '%s' "$?" >"$STATE/exit_code"
  assert_ok
  grep -qi "Restoring database\|Stopping app\|Downloading dump" "$STATE/out.log" &&
    fail "sourcing the script started a restore"
  finish_case
}

test_writable_dir_passes
test_unwritable_dir_aborts
test_missing_dir_is_created
test_uncreatable_dir_aborts
test_probe_file_is_cleaned_up
test_sourcing_does_not_restore

echo
SKIP_NOTE=""
(( SKIPPED )) && SKIP_NOTE=" ($SKIPPED skipped)"
if [[ "$FAILURES" -eq 0 ]]; then
  echo "ok — $TESTS_RUN restore preflight cases passed${SKIP_NOTE}"
  exit 0
fi
echo "$FAILURES of $TESTS_RUN restore preflight cases failed"
exit 1
