#!/usr/bin/env bash
# Backend container startup. Phase 0: dev server only (not production-grade).
set -euo pipefail

echo "Waiting for Postgres at ${POSTGRES_HOST:-db}:${POSTGRES_PORT:-5432}..."
# Django's own check retries the DB; this simple loop keeps logs readable.
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

echo "Starting Django development server on 0.0.0.0:8000"
exec python manage.py runserver 0.0.0.0:8000
