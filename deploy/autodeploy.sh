#!/usr/bin/env bash
# Continuous deploy (pull-based) for the TimeLine home server.
#
# Run on a schedule by timeline-autodeploy.timer. Each run:
#   1. syncs config from main (compose files, GHCR override, Caddyfile),
#   2. pulls the latest release images from GHCR,
#   3. and ONLY IF an image actually changed, recreates the stack.
# The backend entrypoint (entrypoint.prod.sh) runs migrations + collectstatic on
# start, so a redeploy needs nothing else by hand.
#
# This is the "pull-based" half of continuous deploy: the box reaches OUT to
# GHCR, so GitHub never has to connect in (the box forwards only 80/443, not
# SSH). Publishing a GitHub Release makes CI push new images; this script is what
# notices them. A run with no new release is a quiet no-op.
#
# The manual deploy/deploy.sh (build-on-box from source) remains the fallback.
#
# Everything is in one function so the whole script is parsed before a `git pull`
# can change it on disk mid-run (same guard as deploy.sh).
set -euo pipefail

COMPOSE_FILES=(-f docker-compose.prod.yml -f docker-compose.ghcr.yml)
DATA_MOUNT="/srv/timeline"
IMAGES=(
  ghcr.io/sam-githuber/timeline-backend:latest
  ghcr.io/sam-githuber/timeline-web:latest
)

log() { echo "$(date -Is) autodeploy: $*"; }

digests() {
  # Local image IDs for the tracked images, sorted; missing images print
  # nothing, so a first run (images absent) compares as "changed".
  docker image inspect --format '{{.Id}}' "${IMAGES[@]}" 2>/dev/null | sort || true
}

main() {
  cd "$(dirname "$0")/.."

  # Same safety guards as deploy.sh: never deploy without the data disk mounted
  # or the secrets file present.
  if ! mountpoint -q "$DATA_MOUNT"; then
    log "ERROR: data disk $DATA_MOUNT is not mounted; aborting."
    exit 1
  fi
  if [[ ! -f .env.prod ]]; then
    log "ERROR: .env.prod not found in $(pwd); aborting."
    exit 1
  fi

  # Keep declarative config (compose, GHCR override, Caddyfile) in step with the
  # images. The box tracks main; a release is cut from main, so at deploy time
  # main's config matches the released image. ff-only so a dirty/forked checkout
  # fails loudly rather than deploying a surprise.
  git pull --ff-only

  local before after
  before="$(digests)"
  docker compose "${COMPOSE_FILES[@]}" pull --quiet backend web
  after="$(digests)"

  if [[ "$before" == "$after" ]]; then
    log "no new release image; nothing to do."
    exit 0
  fi

  log "new release image pulled; redeploying..."
  docker compose "${COMPOSE_FILES[@]}" up -d --no-build backend web
  docker compose "${COMPOSE_FILES[@]}" ps
  docker image prune -f >/dev/null
  log "deploy complete."
}

main "$@"
