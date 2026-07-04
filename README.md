# TimeLine

A social timeline with **no algorithm and no ads** — just the people you follow,
in the order they posted. What Facebook was supposed to be.

See [`docs/SHARED.md`](docs/SHARED.md) for the mission, principles, and tech
stack, and [`docs/phases/`](docs/phases/) for the phased roadmap.

## Tech stack

- **Backend:** Django + Django REST Framework (Python, managed with [uv](https://docs.astral.sh/uv/))
- **Frontend:** React + Vite + Tailwind CSS
- **Database:** PostgreSQL
- **Local dev:** Docker Compose (three containers: `frontend`, `backend`, `db`)

## Quick start

You only need [Docker Desktop](https://www.docker.com/products/docker-desktop/)
installed and running. From the repo root:

```bash
docker compose up --build
```

That builds and starts all three containers. Then open:

| URL | What it is |
|---|---|
| http://localhost:5173 | The React app (shows a live "Backend connected" message) |
| http://localhost:8000/api/hello | The backend JSON endpoint |
| http://localhost:8000/admin/ | Django admin |

Stop everything with <kbd>Ctrl-C</kbd>, or `docker compose down` (add `-v` to
also wipe the database volume).

### Django admin login

Phase 0 creates a **local-dev** superuser: username `admin`, password `admin`.
These are for local use only — real credentials are set up in Phase 5
(productionisation). If you rebuilt from scratch and need to (re)create it:

```bash
docker compose exec \
  -e DJANGO_SUPERUSER_USERNAME=admin \
  -e DJANGO_SUPERUSER_EMAIL=admin@example.com \
  -e DJANGO_SUPERUSER_PASSWORD=admin \
  backend python manage.py createsuperuser --noinput
```

### Configuration

Sensible dev defaults are baked into `docker-compose.yml`, so no setup is
needed to run locally. To override anything (database name, secret key, etc.),
copy [`.env.example`](.env.example) to `.env` and edit it — Docker Compose reads
`.env` automatically.

## Project layout

```
backend/           Django + DRF API (uv-managed)
  config/          Django project settings + URLs
  api/             App with the /api/hello endpoint
frontend/          React + Vite + Tailwind app
docker-compose.yml Wires frontend + backend + db together
docs/              Project reference (SHARED.md) and per-phase plans
```

## Common commands

```bash
docker compose up --build        # start everything (rebuild images)
docker compose up -d             # start in the background
docker compose logs -f backend   # follow one service's logs
docker compose exec backend python manage.py migrate   # run migrations
docker compose down              # stop and remove containers
```
