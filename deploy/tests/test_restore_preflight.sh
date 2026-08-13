#!/usr/bin/env bash
# Tests for deploy/restore.sh's preflight guard (issue #197).
#
# Run it from anywhere:  ./deploy/tests/test_restore_preflight.sh
# CI runs it in the "deploy-scripts" job (.github/workflows/main.yml).
#
# HOW IT WORKS, two ways. restore.sh only restores when executed directly, so
# most cases *source* it (with CONFIG pointing at a temp env file, which is where
# the script reads its settings) and call `check_media_writable` on their own.
# The last few cases run the script for real with stub `docker` and `rclone`
# commands first on PATH, because the thing they check is not a return value but
# an ORDER — that nothing destructive is issued before the checks pass. Either
# way the tests stay away from Postgres, rclone and the real R2 remote entirely.
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

# Fake `docker` and `rclone` for the whole-script cases below. Deliberately
# minimal — they only have to answer the three questions restore.sh asks before
# it becomes destructive, and log every call so the tests can assert on what was
# NOT issued.
install_stubs() {
  mkdir -p "$STATE/bin"
  cat >"$STATE/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_STATE/calls.log"
# `compose exec -T db sh -c 'printf %s "$POSTGRES_DB"'` — the live DB name.
case "$*" in
  *"exec -T db"*) printf %s "timeline" ;;
esac
exit 0
STUB
  cat >"$STATE/bin/rclone" <<'STUB'
#!/usr/bin/env bash
echo "rclone $*" >>"$STUB_STATE/calls.log"
case "${1:-}" in
  lsf) echo "db-2026-08-01T03-30-05Z.dump" ;;
  # pg_dump custom-format magic, which the preflight reads to prove the crypt
  # remote really decrypts.
  cat) printf 'PGDMP' ;;
esac
exit 0
STUB
  chmod +x "$STATE/bin/docker" "$STATE/bin/rclone"
  : >"$STATE/calls.log"
}

# Run the real script end to end against the stubs. $@ = its arguments.
# LIVE_MEDIA_DIR is pointed at the temp world so "restoring over production" can
# be exercised without a production to restore over.
run_script() {
  (
    export CONFIG="$STATE/restore.env"
    export STUB_STATE="$STATE"
    export LIVE_MEDIA_DIR="$STATE/data/media"
    export PATH="$STATE/bin:$PATH"
    # The confirmation phrase, so a regression that reordered the preflight below
    # the app stop would actually get that far and be caught.
    printf 'restore production\n' | "$SCRIPT" "$@"
  ) >"$STATE/out.log" 2>&1
  printf '%s' "$?" >"$STATE/exit_code"
}

assert_not_called() {
  if grep -q -- "$1" "$STATE/calls.log" 2>/dev/null; then
    fail "expected NOT to run: $1 (calls: $(tr '\n' '; ' <"$STATE/calls.log"))"
  fi
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
  # The message has to carry the fix, because it's read mid-disaster — and the
  # uid has to be the one actually running the restore, not a hardcoded 1000,
  # since a scratch target has nothing to do with the backend container.
  assert_output_contains "sudo chown -R $(id -u):$(id -g)"
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

# A root-owned SUBdirectory is just as fatal as a root-owned top: `rclone sync`
# writes deep inside media/. A probe at the top would pass this straight through,
# which is how the guard could have shipped looking correct and still failed the
# restore it exists to protect.
test_foreign_owned_subdir_aborts() {
  new_world "foreign_owned_subdir_aborts"
  mkdir -p "$STATE/data/media/posts"
  # Can't chown without root, so fake the same condition the other way: ask the
  # guard to accept a tree while pretending we are a different uid.
  (
    export CONFIG="$STATE/restore.env"
    # shellcheck source=../restore.sh
    source "$SCRIPT"
    # id -u is what the guard compares against; override it for this subshell so
    # every path in the tree looks foreign-owned.
    id() { if [[ "${1:-}" == "-u" ]]; then echo 999999; else command id "$@"; fi; }
    check_media_writable "$STATE/data/media"
  ) >"$STATE/out.log" 2>&1
  printf '%s' "$?" >"$STATE/exit_code"
  assert_fails
  assert_output_contains "is not owned by"
  finish_case
}

# --- whole-script ordering cases ---------------------------------------------

# THE INVARIANT THIS PR EXISTS FOR. With the media target unwritable, the script
# must refuse having issued NOTHING destructive — no `compose stop`, no
# pg_restore. Move the preflight below the stop and this is the case that fails.
test_refuses_before_stopping_the_app() {
  new_world "refuses_before_stopping_the_app"
  if (( IS_ROOT )); then skip_case "runs as root; permission bits don't apply"; return; fi
  install_stubs
  mkdir -p "$STATE/data/media"
  chmod 500 "$STATE/data/media"
  run_script
  assert_fails
  assert_output_contains "cannot write into the media target"
  # ...and for the LIVE tree specifically, the explanation of why it's like that.
  assert_output_contains "aligns this tree to its own uid"
  assert_not_called "stop backend web"
  assert_not_called "pg_restore"
  finish_case
}

# --preflight stops after the checks: no stop, no restore, no media sync, exit 0.
test_preflight_only_changes_nothing() {
  new_world "preflight_only_changes_nothing"
  install_stubs
  mkdir -p "$STATE/data/media"
  run_script --preflight
  assert_ok
  assert_output_contains "Preflight OK"
  assert_not_called "stop backend web"
  assert_not_called "pg_restore"
  assert_not_called "rclone sync"
  finish_case
}

# The flag has to win wherever it appears. `restore.sh latest --preflight` reads
# as check-only to anyone typing it, and previously ran a real restore.
test_preflight_flag_is_positional_independent() {
  new_world "preflight_flag_is_positional_independent"
  install_stubs
  mkdir -p "$STATE/data/media"
  run_script latest --preflight
  assert_ok
  assert_output_contains "Preflight OK"
  assert_not_called "stop backend web"
  finish_case
}

# An unknown flag must be refused, not silently taken as a dump name — a typo'd
# --preflight would otherwise restore.
test_unknown_flag_refused() {
  new_world "unknown_flag_refused"
  install_stubs
  mkdir -p "$STATE/data/media"
  run_script --prefligth
  assert_fails
  assert_output_contains "unknown option"
  assert_not_called "stop backend web"
  finish_case
}

# A dump that lists but doesn't decrypt (wrong crypt password, truncated upload)
# must be caught here, not after pg_restore --clean has dropped the schema.
test_undecryptable_dump_aborts() {
  new_world "undecryptable_dump_aborts"
  install_stubs
  mkdir -p "$STATE/data/media"
  # `rclone cat` returns bytes that aren't a pg_dump archive.
  cat >"$STATE/bin/rclone" <<'STUB'
#!/usr/bin/env bash
echo "rclone $*" >>"$STUB_STATE/calls.log"
case "${1:-}" in
  lsf) echo "db-2026-08-01T03-30-05Z.dump" ;;
  cat) printf '\x00\x01\x02\x03\x04' ;;
esac
exit 0
STUB
  chmod +x "$STATE/bin/rclone"
  run_script
  assert_fails
  assert_output_contains "does not read back as a"
  assert_not_called "stop backend web"
  finish_case
}

test_writable_dir_passes
test_unwritable_dir_aborts
test_missing_dir_is_created
test_uncreatable_dir_aborts
test_probe_file_is_cleaned_up
test_foreign_owned_subdir_aborts
test_sourcing_does_not_restore
test_refuses_before_stopping_the_app
test_preflight_only_changes_nothing
test_preflight_flag_is_positional_independent
test_unknown_flag_refused
test_undecryptable_dump_aborts

echo
SKIP_NOTE=""
(( SKIPPED )) && SKIP_NOTE=" ($SKIPPED skipped)"
if [[ "$FAILURES" -eq 0 ]]; then
  echo "ok — $TESTS_RUN restore preflight cases passed${SKIP_NOTE}"
  exit 0
fi
echo "$FAILURES of $TESTS_RUN restore preflight cases failed"
exit 1
