#!/usr/bin/env bash
# Backend container startup for PRODUCTION (Phase 7 home-server beta).
# Waits for Postgres, applies migrations, collects static files, then serves the
# app with gunicorn. The dev counterpart (runserver, live reload) is entrypoint.sh.
set -euo pipefail

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
