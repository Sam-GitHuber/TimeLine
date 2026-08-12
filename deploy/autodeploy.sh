#!/usr/bin/env bash
# Continuous deploy (pull-based) for the TimeLine home server.
#
# Run on a schedule by timeline-autodeploy.timer. Each run:
#   1. syncs config from main (compose files, GHCR override, Caddyfile),
#   2. pulls the latest release images from GHCR,
#   3. and ONLY IF a container isn't already running that image, recreates the
#      stack.
# The backend entrypoint (entrypoint.prod.sh) runs migrations + collectstatic on
# start, so a redeploy needs nothing else by hand.
#
# This is the "pull-based" half of continuous deploy: the box reaches OUT to
# GHCR, so GitHub never has to connect in (the box forwards only 80/443, not
# SSH). Publishing a GitHub Release makes CI push new images; this script is what
# notices them. A run with nothing to do is a quiet no-op.
#
# WHY THE CHECK ASKS ABOUT CONTAINERS, NOT IMAGES (issue #104)
# ------------------------------------------------------------
# This script used to diff *image* digests around the pull and redeploy only when
# they changed. That answers "did a new image arrive?" — never "are the
# containers running the image we have?" — so once an image had been pulled,
# every later run correctly saw no change and skipped `up` entirely. If the
# containers were on something else (very easily: the fallback deploy/deploy.sh
# builds `timeline-prod-backend` locally, a different image name this script
# never inspected), the box ran old code indefinitely while every signal —
# healthz 200, "deploy complete." in this log, a green release workflow — read as
# healthy. That happened for real on 2026-07-20.
#
# So the question we ask now is the one that actually matters: *is each service's
# running container built from the release image we just pulled?* That covers the
# new-image case as a side effect (a new image means the running container no
# longer matches it), and it self-heals container drift from any cause —
# including a fallback deploy.sh run, a manual `docker run`, or a container that
# died and never came back.
#
# The manual deploy/deploy.sh (build-on-box from source) remains the fallback.
#
# Everything is in functions so the whole script is parsed before a `git pull`
# can change it on disk mid-run (same guard as deploy.sh). Sourcing the file
# defines those functions without deploying anything, which is how
# deploy/tests/test_autodeploy.sh drives the decision logic against a stub
# `docker`.
set -euo pipefail

COMPOSE_FILES=(-f docker-compose.prod.yml -f docker-compose.ghcr.yml)
DATA_MOUNT="${TIMELINE_DATA_MOUNT:-/srv/timeline}"

# Is DATA_MOUNT expected to be a SEPARATE DISK? On the home box it is: data
# lives on a 1 TB NVMe while the OS is on a small SSD, so "not mounted" means
# Postgres would silently write to the wrong disk — worth aborting over.
#
# A single-disk host (the AWS Lightsail instance, one 58 GB volume) has no wrong
# disk to write to, so there the mount check can only ever fail. Set
# TIMELINE_REQUIRE_DATA_MOUNT=0 there — via `Environment=` in
# timeline-autodeploy.service — and the check below falls back to asserting the
# data directories exist, which is the part that still protects anything.
#
# Defaults to 1 so the home box, and anyone copying this setup, keeps the
# stricter check without having to know this variable exists.
REQUIRE_DATA_MOUNT="${TIMELINE_REQUIRE_DATA_MOUNT:-1}"

# Which release to run. The GHCR override interpolates TIMELINE_TAG too, so this
# export is what keeps the tag this script *inspects* and the tag compose
# *deploys* the same one — otherwise a pinned `TIMELINE_TAG=v0.14.0
# ./deploy/autodeploy.sh` (the rollback path) would compare containers against
# :latest and redeploy on every run.
TIMELINE_TAG="${TIMELINE_TAG:-latest}"
export TIMELINE_TAG

# Services to keep deployed, and the image each one should be running. Index i of
# SERVICES pairs with index i of IMAGES. (db is deliberately absent: it runs
# stock postgres:16 from the prod compose file, isn't part of a release, and must
# not be recreated on every deploy.)
SERVICES=(backend web)
IMAGES=(
  "ghcr.io/sam-githuber/timeline-backend:${TIMELINE_TAG}"
  "ghcr.io/sam-githuber/timeline-web:${TIMELINE_TAG}"
)

# Spelled out rather than `date -Is`: -I is GNU-only, and the test harness runs
# on macOS too, where BSD date rejects it and every log line grows an error.
log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') autodeploy: $*"; }

# Refuse to deploy unless the data location is sound. Two host shapes:
#
#   REQUIRE_DATA_MOUNT=1 (default, home box)  — DATA_MOUNT must be a real mount
#     point, i.e. the data disk is actually mounted. Its subdirectories are
#     guaranteed to be on the right disk once that holds.
#   REQUIRE_DATA_MOUNT=0 (single-disk host)   — there is no separate disk to
#     mount, so instead assert the two bind-mount targets exist. Docker's local
#     bind driver does NOT create them; without this the stack fails later with
#     an opaque "no such file or directory".
#
# A separate function (rather than inline in main) so deploy/tests can drive it
# directly — main() also pulls, deploys and talks to GHCR, which tests can't.
check_data_location() {
  if [[ "$REQUIRE_DATA_MOUNT" == "1" ]]; then
    if ! mountpoint -q "$DATA_MOUNT"; then
      log "ERROR: data disk $DATA_MOUNT is not mounted; aborting."
      log "       (Single-disk host? Set TIMELINE_REQUIRE_DATA_MOUNT=0.)"
      return 1
    fi
    return 0
  fi

  local dir
  for dir in "$DATA_MOUNT/postgres" "$DATA_MOUNT/media"; do
    if [[ ! -d "$dir" ]]; then
      log "ERROR: data directory $dir does not exist; aborting."
      log "       Create it once: sudo mkdir -p $DATA_MOUNT/{postgres,media}"
      return 1
    fi
  done
}

image_id() {
  # Local image ID for an image reference; empty if the image isn't on the box.
  docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true
}

container_image_id() {
  # Image ID the named service's running container was created from; empty if
  # there is no running container for it. `compose ps -q` lists running
  # containers only, so a stopped/missing container reads as empty — which is
  # itself a reason to redeploy.
  local cid
  cid="$(docker compose "${COMPOSE_FILES[@]}" ps -q "$1" 2>/dev/null | head -n 1 || true)"
  [[ -n "$cid" ]] || return 0
  docker container inspect --format '{{.Image}}' "$cid" 2>/dev/null || true
}

drift_reasons() {
  # Print one line per service that is NOT running its release image. No output
  # means the box is already running the release, and there is nothing to do.
  local i service image want have
  for i in "${!SERVICES[@]}"; do
    service="${SERVICES[$i]}"
    image="${IMAGES[$i]}"

    want="$(image_id "$image")"
    if [[ -z "$want" ]]; then
      # Shouldn't happen after a successful pull; redeploy anyway so `up` fails
      # loudly rather than this script reporting success on a missing image.
      echo "$service: release image $image is not present on the box"
      continue
    fi

    have="$(container_image_id "$service")"
    if [[ -z "$have" ]]; then
      echo "$service: no running container"
    elif [[ "$have" != "$want" ]]; then
      echo "$service: container is running ${have#sha256:}, release image is ${want#sha256:}"
    fi
  done
}

converge() {
  # Pull the release images, then make the running containers match them.
  docker compose "${COMPOSE_FILES[@]}" pull --quiet "${SERVICES[@]}"

  local reasons reason
  reasons="$(drift_reasons)"

  if [[ -z "$reasons" ]]; then
    log "containers already running release ${TIMELINE_TAG}; nothing to do."
    return 0
  fi

  while IFS= read -r reason; do
    log "redeploy needed — $reason"
  done <<<"$reasons"

  # --force-recreate because the drift we're correcting is exactly the case
  # compose's own "has anything changed?" heuristic can miss: a container created
  # from a different image name (deploy.sh's local build) under a different
  # compose invocation. Recreating unconditionally here is cheap — we only get
  # here when something is already wrong — and it's what makes convergence
  # guaranteed rather than best-effort. It applies only to the services named on
  # the command line: compose does not cascade it to dependencies, so Postgres is
  # never recreated by a deploy.
  docker compose "${COMPOSE_FILES[@]}" up -d --no-build --force-recreate "${SERVICES[@]}"
  docker compose "${COMPOSE_FILES[@]}" ps
  docker image prune -f >/dev/null
  log "deploy complete: ${SERVICES[*]} now running release ${TIMELINE_TAG}."
}

main() {
  cd "$(dirname "$0")/.."

  # Same safety guards as deploy.sh: never deploy without the data location
  # sound or the secrets file present.
  check_data_location || exit 1
  if [[ ! -f .env.prod ]]; then
    log "ERROR: .env.prod not found in $(pwd); aborting."
    exit 1
  fi

  # Keep declarative config (compose, GHCR override, Caddyfile) in step with the
  # images. The box tracks main; a release is cut from main, so at deploy time
  # main's config matches the released image. ff-only so a dirty/forked checkout
  # fails loudly rather than deploying a surprise.
  git pull --ff-only

  converge
}

# Executed directly -> deploy. Sourced (the test harness) -> just define the
# functions above.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
