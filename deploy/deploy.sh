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
DATA_MOUNT="${TIMELINE_DATA_MOUNT:-/srv/timeline}"

# Whether DATA_MOUNT is expected to be a separate disk — see the long note in
# deploy/autodeploy.sh. 1 (default) = home box, two disks, the mount must be up.
# 0 = single-disk host (AWS Lightsail), where only Safety 3 below applies.
REQUIRE_DATA_MOUNT="${TIMELINE_REQUIRE_DATA_MOUNT:-1}"

main() {
  # Work from the repo root regardless of where this was invoked.
  cd "$(dirname "$0")/.."

  # Safety 1: never deploy if the NVMe data disk isn't mounted — otherwise the
  # stack would write Postgres data / media onto the OS SSD. (Docker's systemd
  # unit also guards this; belt and braces.) Skipped on a single-disk host,
  # where there is no other disk to land on and the check can only ever fail;
  # Safety 3 still runs there and is the part that catches a real mistake.
  if [[ "$REQUIRE_DATA_MOUNT" == "1" ]] && ! mountpoint -q "$DATA_MOUNT"; then
    echo "ERROR: data disk $DATA_MOUNT is not mounted. Aborting deploy." >&2
    echo "       (Single-disk host? Set TIMELINE_REQUIRE_DATA_MOUNT=0.)" >&2
    exit 1
  fi

  # Safety 2: refuse to run without the secrets file.
  if [[ ! -f .env.prod ]]; then
    echo "ERROR: .env.prod not found in $(pwd)." >&2
    echo "       Copy .env.prod.example to .env.prod and fill in real secrets." >&2
    exit 1
  fi

  # Safety 3: the compose file bind-mounts Postgres/media to these subdirs of the
  # data disk. Docker's local bind driver does NOT create them — a fresh bring-up
  # would fail with "no such file or directory". They're a one-time, root-owned
  # `sudo mkdir` (see docs/deploy.md); check here rather than mkdir, since this
  # script runs as an unprivileged user and can't create dirs on the root-owned
  # mount.
  for dir in "$DATA_MOUNT/postgres" "$DATA_MOUNT/media"; do
    if [[ ! -d "$dir" ]]; then
      echo "ERROR: data directory $dir does not exist." >&2
      echo "       Create it once: sudo mkdir -p $DATA_MOUNT/{postgres,media}" >&2
      echo "       (See docs/deploy.md — 'One-time server setup'.)" >&2
      exit 1
    fi
  done

  echo "==> Pulling latest code ($(git rev-parse --abbrev-ref HEAD))..."
  git pull --ff-only

  echo "==> Building images and starting the stack..."
  docker compose -f "$COMPOSE_FILE" up -d --build

  # `up` only recreates `web` if its image or compose config changed, so a
  # pulled Caddyfile change alone would never be loaded (issue #202). A reload
  # applies it; an unchanged config is a no-op, and a broken one is refused with
  # the old config left running. Retried because a `web` that `up` has just
  # recreated may not have its admin endpoint listening yet.
  echo "==> Reloading Caddy's config..."
  local attempt
  for attempt in 1 2 3 4 5; do
    if docker compose -f "$COMPOSE_FILE" exec -T web \
      caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
      break
    fi
    if [[ "$attempt" == 5 ]]; then
      echo "WARNING: caddy reload failed; web is still serving its previous config." >&2
      echo "         Fix deploy/caddy/Caddyfile (the error is above), then re-run." >&2
      break
    fi
    sleep 2
  done

  echo "==> Current status:"
  docker compose -f "$COMPOSE_FILE" ps

  echo "==> Pruning dangling images to reclaim disk..."
  docker image prune -f >/dev/null

  echo "==> Recent backend logs (migrations / gunicorn startup):"
  docker compose -f "$COMPOSE_FILE" logs --tail=25 backend

  echo "==> Deploy complete."
}

main "$@"
