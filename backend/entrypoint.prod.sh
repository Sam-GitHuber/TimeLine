#!/usr/bin/env bash
# Backend container startup for PRODUCTION (Phase 7 home-server beta).
# Waits for Postgres, applies migrations, collects static files, then serves the
# app with gunicorn. The dev counterpart (runserver, live reload) is entrypoint.sh.
set -euo pipefail

# --- run as an unprivileged user --------------------------------------------
# Everything below this block runs as `app` (uid 1000, created in the Dockerfile),
# not root — issue #199. A remote-code-execution bug in Django or any dependency
# then executes as a user that cannot rewrite the application code under /app,
# cannot chown its way out, and is a much longer step from owning the host.
#
# We still start as root for one job the app user cannot do for itself: aligning
# ownership of the media volume. That volume is a bind mount to
# /srv/timeline/media on the host, created root-owned (docs/deploy.md) and — until
# this change — filled with root-owned files by this very container. Doing it here
# on every boot means no manual `chown` step gates a release, and it self-heals if
# anything ever writes there as root again (a `docker compose exec` one-off, an
# older image rolled back to). It is also exactly the alignment
# deploy/restore.sh needs to write media back as the deploy user (issue #197).
#
# `chown -R` walks the whole media tree each boot. That is milliseconds at this
# scale (tens of MB); if media ever grows to the point where it isn't, that is
# also the point where it should be in object storage, not on the disk.
APP_USER="${APP_USER:-app}"
if [[ "$(id -u)" -eq 0 ]]; then
  echo "Aligning ownership of /app/media to ${APP_USER}..."
  chown -R "${APP_USER}:${APP_USER}" /app/media

  # Re-exec this same script as the app user. setpriv ships with util-linux in
  # the base image, so there's no gosu to install. --init-groups reads the
  # user's groups from /etc/passwd; --inh-caps=-all makes sure no Linux
  # capability survives the switch. setpriv keeps the environment as-is, so HOME
  # has to be exported by hand or it would still say /root — not cosmetic:
  # gunicorn puts its control socket under $HOME and logs
  # "Control server error: [Errno 13] Permission denied: '/root/.gunicorn'"
  # without this.
  export HOME="/home/${APP_USER}"
  echo "Dropping privileges to ${APP_USER}..."
  exec setpriv --reuid="${APP_USER}" --regid="${APP_USER}" --init-groups --inh-caps=-all \
    bash "$0" "$@"
fi
echo "Running as $(id -un) (uid $(id -u))."

echo "Waiting for Postgres at ${POSTGRES_HOST:-db}:${POSTGRES_PORT:-5432}..."
until python -c "
import os, socket, sys
host = os.environ.get('POSTGRES_HOST', 'db')
port = int(os.environ.get('POSTGRES_PORT', '5432'))
s = socket.socket()
s.settimeout(2)
try:
    s.connect((host, port))
except OSError:
    sys.exit(1)
finally:
    s.close()
"; do
  echo "  ...still waiting for Postgres"
  sleep 1
done
echo "Postgres is up."

echo "Applying database migrations..."
python manage.py migrate --noinput

# Create the database cache table backing DRF's auth-endpoint throttling. It's
# shared across gunicorn workers (an in-process cache wouldn't be). Idempotent:
# a no-op once the table exists, so it's safe to run on every boot.
echo "Ensuring cache table exists..."
python manage.py createcachetable

# Gather Django's own static files (admin + DRF browsable API) into STATIC_ROOT
# so WhiteNoise can serve them. --clear avoids stale files across deploys.
echo "Collecting static files..."
python manage.py collectstatic --noinput --clear

# gunicorn: 3 worker processes is a sensible start for a small home server
# (rule of thumb ~2*CPU+1; tune later). Logs go to stdout/stderr so
# `docker compose logs` shows them. 120s timeout tolerates slow image uploads.
echo "Starting gunicorn on 0.0.0.0:8000"
exec gunicorn config.wsgi:application \
  --bind 0.0.0.0:8000 \
  --workers 3 \
  --timeout 120 \
  --access-logfile - \
  --error-logfile -
