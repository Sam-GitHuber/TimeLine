#!/usr/bin/env bash
# Tests for deploy/autodeploy.sh's redeploy decision (issue #104).
#
# Run it from anywhere:  ./deploy/tests/test_autodeploy.sh
# CI runs it in the "deploy-scripts" job (.github/workflows/main.yml).
#
# HOW IT WORKS. autodeploy.sh only runs a deploy when executed directly, so this
# harness *sources* it to get its functions, puts a stub `docker` (see
# stub-docker.sh) first on PATH, and calls `converge` — the real pull → inspect →
# decide → up path, with the docker calls faked. Each case sets up a small world
# ("this image is on the box, this container is running that image") and asserts
# whether `up` was called.
#
# The case that matters most is `container_drift`: image unchanged, container
# running something else. That is the exact state the box was in on 2026-07-20,
# and the old image-digest check reported "nothing to do" through all of it.
#
# Deliberately plain bash + a PATH stub — no test framework, nothing to install,
# runs the same on the box, on macOS (bash 3.2: no mapfile/associative arrays)
# and in CI.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../autodeploy.sh"
STUB="$HERE/stub-docker.sh"

BACKEND_IMAGE="ghcr.io/sam-githuber/timeline-backend:latest"
WEB_IMAGE="ghcr.io/sam-githuber/timeline-web:latest"

TESTS_RUN=0
FAILURES=0
CURRENT=""

# --- world building ----------------------------------------------------------

sanitize() { printf '%s' "$1" | tr '/:' '__'; }

new_world() {
  CURRENT="$1"
  STATE="$(mktemp -d "${TMPDIR:-/tmp}/autodeploy-test.XXXXXX")"
  mkdir -p "$STATE/bin" "$STATE/images" "$STATE/running" "$STATE/containers" \
    "$STATE/pull_delivers"
  cp "$STUB" "$STATE/bin/docker"
  chmod +x "$STATE/bin/docker"
  : >"$STATE/calls.log"
}

# An image that is already on the box.
have_image() { printf '%s' "$2" >"$STATE/images/$(sanitize "$1")"; }

# A running container for a service, created from the given image ID.
running_container() {
  printf '%s' "$2" >"$STATE/running/$1"
  printf '%s' "$3" >"$STATE/containers/$2"
}

# What `docker compose pull` will put on the box for this image.
pull_delivers() { printf '%s' "$2" >"$STATE/pull_delivers/$(sanitize "$1")"; }

# Source autodeploy.sh with the stub on PATH and run its converge step.
run_converge() {
  (
    PATH="$STATE/bin:$PATH"
    export PATH
    export STUB_STATE="$STATE"
    # shellcheck source=../autodeploy.sh
    source "$SCRIPT"
    converge
  ) >"$STATE/out.log" 2>&1
  printf '%s' "$?" >"$STATE/exit_code"
}

# --- assertions --------------------------------------------------------------

fail() {
  FAILURES=$((FAILURES + 1))
  echo "FAIL: $CURRENT — $1"
  echo "--- output ---"
  sed 's/^/    /' "$STATE/out.log"
  echo "--- docker calls ---"
  sed 's/^/    /' "$STATE/calls.log"
}

assert_exit_ok() {
  local code
  code="$(cat "$STATE/exit_code")"
  [[ "$code" == "0" ]] || fail "expected exit 0, got $code"
}

assert_deployed() {
  if ! grep -q ' up -d ' "$STATE/calls.log"; then
    fail "expected a redeploy (docker compose up), but none happened"
    return
  fi
  grep -q -- '--force-recreate' "$STATE/calls.log" ||
    fail "redeployed without --force-recreate, so a drifted container may survive"
}

assert_not_deployed() {
  ! grep -q ' up -d ' "$STATE/calls.log" ||
    fail "redeployed when the containers were already on the release image"
}

assert_output_contains() {
  grep -q -- "$1" "$STATE/out.log" || fail "expected output to mention: $1"
}

finish_case() {
  TESTS_RUN=$((TESTS_RUN + 1))
  rm -rf "$STATE"
}

# --- cases -------------------------------------------------------------------

# Everything already on the release image: a poll must be a quiet no-op, or the
# box would recreate its containers (brief downtime) every five minutes.
test_nothing_to_do() {
  new_world "nothing_to_do"
  have_image "$BACKEND_IMAGE" sha256:aaa
  have_image "$WEB_IMAGE" sha256:bbb
  running_container backend c_backend sha256:aaa
  running_container web c_web sha256:bbb

  run_converge
  assert_exit_ok
  assert_not_deployed
  assert_output_contains "nothing to do"
  finish_case
}

# The ordinary release: pull brings a new backend image, so the running
# container no longer matches it.
test_new_release_image() {
  new_world "new_release_image"
  have_image "$BACKEND_IMAGE" sha256:aaa
  have_image "$WEB_IMAGE" sha256:bbb
  running_container backend c_backend sha256:aaa
  running_container web c_web sha256:bbb
  pull_delivers "$BACKEND_IMAGE" sha256:new

  run_converge
  assert_exit_ok
  assert_deployed
  assert_output_contains "redeploy needed"
  finish_case
}

# THE REGRESSION TEST FOR #104. The release image is on the box and unchanged by
# the pull, but the container is running something else entirely (here: the
# locally-built image a deploy.sh fallback leaves behind). The old image-digest
# check saw "no new image" and reported "nothing to do" — forever.
test_container_drift() {
  new_world "container_drift"
  have_image "$BACKEND_IMAGE" sha256:aaa
  have_image "$WEB_IMAGE" sha256:bbb
  running_container backend c_backend sha256:localbuild
  running_container web c_web sha256:bbb

  run_converge
  assert_exit_ok
  assert_deployed
  assert_output_contains "container is running localbuild"
  finish_case
}

# A container that died and never came back: `compose ps -q` yields nothing, and
# that is a redeploy, not a no-op.
test_missing_container() {
  new_world "missing_container"
  have_image "$BACKEND_IMAGE" sha256:aaa
  have_image "$WEB_IMAGE" sha256:bbb
  running_container backend c_backend sha256:aaa
  # web has no container at all.

  run_converge
  assert_exit_ok
  assert_deployed
  assert_output_contains "web: no running container"
  finish_case
}

# First run on a fresh box (or a pull that somehow left no image): don't claim
# success. Redeploy so `up` surfaces the problem loudly.
test_missing_image() {
  new_world "missing_image"
  have_image "$WEB_IMAGE" sha256:bbb
  running_container web c_web sha256:bbb

  run_converge
  # No assert_exit_ok here on purpose: against a real docker, `up --no-build`
  # with no image fails, and failing loudly is the point. The stub can't model
  # that, so this case only asserts the decision — redeploy, don't claim success.
  assert_deployed
  assert_output_contains "is not present on the box"
  finish_case
}

# A pinned rollback (TIMELINE_TAG=v0.14.0) must compare containers against the
# pinned tag — the same one compose deploys — not against :latest.
test_pinned_tag() {
  new_world "pinned_tag"
  have_image "ghcr.io/sam-githuber/timeline-backend:v0.14.0" sha256:old
  have_image "ghcr.io/sam-githuber/timeline-web:v0.14.0" sha256:oldweb
  running_container backend c_backend sha256:old
  running_container web c_web sha256:oldweb

  (
    PATH="$STATE/bin:$PATH"
    export PATH
    export STUB_STATE="$STATE"
    export TIMELINE_TAG="v0.14.0"
    # shellcheck source=../autodeploy.sh
    source "$SCRIPT"
    converge
  ) >"$STATE/out.log" 2>&1
  printf '%s' "$?" >"$STATE/exit_code"

  assert_exit_ok
  assert_not_deployed
  assert_output_contains "release v0.14.0"
  finish_case
}

test_nothing_to_do
test_new_release_image
test_container_drift
test_missing_container
test_missing_image
test_pinned_tag

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "ok — $TESTS_RUN autodeploy cases passed"
  exit 0
fi
echo "$FAILURES of $TESTS_RUN autodeploy cases failed"
exit 1
