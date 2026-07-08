# Phase 0 — Prove the Stack

**Status:** done ✅

## Goal

Get Docker Compose running three containers — `frontend` (React/Vite),
`backend` (Django + DRF), `postgres` — that can actually talk to each other. No
real app features yet. This just proves the plumbing works before any
product code is written.

See `docs/SHARED.md` for the overall stack and why each piece was chosen.

## Definition of done

- [x] Docker Desktop installed and running locally
- [x] `docker compose up` starts all three containers with one command
- [x] `backend` container serves a Django/DRF "hello world" endpoint
      (`GET /api/hello`)
- [x] Django admin is reachable (confirms auth/admin are wired) with a
      superuser created (local-dev `admin`/`admin`)
- [x] `frontend` container serves a React page that fetches from the backend
      endpoint and displays the response (proves frontend → backend works)
- [x] `backend` can connect to the `postgres` container and run migrations
      (proves backend → database works)
- [x] All of the above documented in the top-level `README.md` so a new
      contributor can clone the repo and run one command to get started

## Steps

1. Install Docker Desktop (Mac).
2. Remove the legacy template scaffolding (`src/`, `configuration/`,
   conda-based `requirements/`) — it's generic starter content, not part of
   this project's stack.
3. Create `/backend`: minimal Django + DRF project (dependencies managed with
   `uv`) with one `/api/hello` endpoint, plus a `Dockerfile`.
4. Create `/frontend`: minimal Vite + React app (with Tailwind) with one page
   that calls the backend endpoint on load, plus a `Dockerfile`.
5. Write root `docker-compose.yml` wiring `frontend`, `backend`, and
   `postgres` together (env vars, ports, networking).
6. Point Django at the `postgres` container, run `migrate`, and create a
   superuser so the Django admin works.
7. Update root `README.md` with the one-command way to run everything.

## Notes / decisions log

- **Versions landed:** Django 5.1 (since bumped to **6.0** by Dependabot —
  pinned `>=6.0.7,<6.1` in `backend/pyproject.toml`/`uv.lock`), DRF 3.17,
  `psycopg` 3 (binary), Postgres 16, Node 22, React 18.3, Vite 6, Tailwind 4.
- **Django project is named `config`**, with a single app `api` holding the
  `/api/hello` endpoint. URLs: `config/urls.py` includes `api/urls.py`.
- **Settings are env-driven** (`config/settings.py` reads `os.environ`): secret
  key, DEBUG, ALLOWED_HOSTS, the Postgres connection, and CORS origins all come
  from environment variables, with dev-safe defaults. `docker-compose.yml`
  supplies them via `${VAR:-default}`, so `docker compose up` works with no
  `.env`. `.env.example` documents the overrides.
- **Tailwind v4** uses the `@tailwindcss/vite` plugin + a single
  `@import "tailwindcss";` in `src/index.css` — no `tailwind.config.js` or
  PostCSS config needed (this changed from the v3 setup most tutorials show).
- **Frontend → backend URL:** the browser calls `http://localhost:8000`
  (the published host port), *not* the `backend` Docker service name, since the
  fetch runs in the user's browser, not inside the container network. Set via
  `VITE_API_URL`, defaulted in `src/App.jsx`. This is why CORS is required.
- **CORS:** `django-cors-headers` allows the Vite origin (`localhost:5173`).
  Without it the browser fetch would be blocked even though the endpoint works.
- **Gotcha — entrypoint exec bit:** the dev bind-mount `./backend:/app` overlays
  the image filesystem, masking the `chmod +x` done at build time, so the
  container failed with `exec /app/entrypoint.sh: permission denied`. Fix: run
  it via `CMD ["bash", "/app/entrypoint.sh"]` instead of relying on the exec
  bit. Remember this pattern for any future mounted shell scripts.
- **DB readiness:** `db` has a `pg_isready` healthcheck and `backend` uses
  `depends_on: condition: service_healthy`; the entrypoint also polls the DB
  socket before running `migrate`, so startup order is safe.
- **TanStack Query deferred:** SHARED.md lists it "from the start", but Phase 0
  only needs one fetch, so `App.jsx` uses a plain `fetch`. Introduce TanStack
  Query in Phase 1 (wireframe) or Phase 3 when there's real feed data.
- **CI quieted:** the original `.github/workflows/main.yml` ran pytest against
  the now-deleted `src/`. Replaced with a passing placeholder job so CI stays
  green. Real test suites get added **per phase** (backend: Django test runner /
  pytest-django; frontend: Vitest) — the workflow's TODO comment tracks this.
  Do not let a phase ship features without tests from here on.
