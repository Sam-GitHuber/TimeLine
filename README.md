# TimeLine

A social timeline with **no algorithm and no ads** — just the people you follow,
in the order they posted. What Facebook was supposed to be.

See [`docs/SHARED.md`](docs/SHARED.md) for the mission, principles, and tech
stack, [`docs/reference/`](docs/reference/) for how each feature works, and
[`docs/phases/`](docs/phases/) for the roadmap of what's still to come.

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
| http://localhost:5173 | The React app — you'll be sent to a login screen (see Accounts below) |
| http://localhost:8000/api/hello | The backend JSON smoke-test endpoint |
| http://localhost:8000/admin/ | Django admin (also the sign-up approval console) |

Stop everything with <kbd>Ctrl-C</kbd>, or `docker compose down` (add `-v` to
also wipe the database volume).

### Accounts & login

Accounts are real (Phase 2) and log in **by email** — there is no username.
The app is fully behind auth: visiting it while logged out redirects to
`/login`.

To get in, create a superuser (which is active immediately and can reach the
admin). Interactively:

```bash
docker compose exec -it backend python manage.py createsuperuser
```

...or non-interactively (email login, so no username is asked for):

```bash
docker compose exec \
  -e DJANGO_SUPERUSER_EMAIL=admin@example.com \
  -e DJANGO_SUPERUSER_PASSWORD=change-me \
  backend python manage.py createsuperuser --noinput
```

These are **local-dev** credentials only; real ones are set up in Phase 7
(productionisation).

**Sign-ups are approval-gated.** Anyone can submit the sign-up form, but the
account is created **inactive** and cannot log in until you approve it in the
Django admin → **Users** (tick **Active**, or use the "Approve selected
sign-ups" action). Staff accounts also see an **Admin** link in the app nav.

### Configuration

Sensible dev defaults are baked into `docker-compose.yml`, so no setup is
needed to run locally. To override anything (database name, secret key, etc.),
copy [`.env.example`](.env.example) to `.env` and edit it — Docker Compose reads
`.env` automatically.

## Project layout

```
backend/           Django + DRF API (uv-managed)
  config/          Django project settings + URLs
  accounts/        Custom email-login User + auth (register/login/logout)
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
