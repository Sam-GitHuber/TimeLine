#!/usr/bin/env bash
# Deploy the TimeLine production stack on the home server (Phase 7).
#
# Run this ON THE SERVER, from anywhere inside the repo:
#   ./deploy/deploy.sh
#
# It pulls the latest code on the current branch, rebuilds the images, and brings
# the stack up. The backend entrypoint (entrypoint.prod.sh) applies migrations and
# collects static files automatically, so there's nothing else to run by hand.
#
# Everything lives in one function so the whole script is parsed into memory
# before `git pull` can change the file on disk mid-run.
set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"
DATA_MOUNT="/srv/timeline"

main() {
  # Work from the repo root regardless of where this was invoked.
  cd "$(dirname "$0")/.."

  # Safety 1: never deploy if the NVMe data disk isn't mounted — otherwise the
  # stack would write Postgres data / media onto the OS SSD. (Docker's systemd
  # unit also guards this; belt and braces.)
  if ! mountpoint -q "$DATA_MOUNT"; then
    echo "ERROR: data disk $DATA_MOUNT is not mounted. Aborting deploy." >&2
    exit 1
  fi

  # Safety 2: refuse to run without the secrets file.
  if [[ ! -f .env.prod ]]; then
    echo "ERROR: .env.prod not found in $(pwd)." >&2
    echo "       Copy .env.prod.example to .env.prod and fill in real secrets." >&2
    exit 1
  fi

  echo "==> Pulling latest code ($(git rev-parse --abbrev-ref HEAD))..."
  git pull --ff-only

  echo "==> Building images and starting the stack..."
  docker compose -f "$COMPOSE_FILE" up -d --build

  echo "==> Current status:"
  docker compose -f "$COMPOSE_FILE" ps

  echo "==> Pruning dangling images to reclaim disk..."
  docker image prune -f >/dev/null

  echo "==> Recent backend logs (migrations / gunicorn startup):"
  docker compose -f "$COMPOSE_FILE" logs --tail=25 backend

  echo "==> Deploy complete."
}

main "$@"
