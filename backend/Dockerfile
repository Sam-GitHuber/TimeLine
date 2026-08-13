# Backend image: Django + DRF, dependencies managed with uv.
# The uv base image ships the uv binary on top of a slim Python.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# Don't buffer stdout/stderr — logs show up immediately in `docker compose`.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Install into the system environment inside the container (no extra venv).
    UV_PROJECT_ENVIRONMENT=/usr/local

WORKDIR /app

# The unprivileged user the production entrypoint runs the app as (issue #199).
# Created here rather than left to Docker's `user:` so the image is complete on
# its own and the uid has a real passwd entry (setpriv --init-groups needs one).
#
# Why uid/gid 1000 specifically, and why fixed: release images are built in CI
# (.github/workflows/release-deploy.yml), so this value cannot adapt to whatever
# host pulls them. 1000 is the deploy user (`ubuntu`) on the Lightsail box, and
# matching it means files the backend writes into the media volume land owned by
# the deploy user on the *host* — which is what lets deploy/restore.sh write
# media back during a disaster recovery (issue #197). Debian's slim base creates
# no user at 1000, so it's free. Override at build time on a host whose deploy
# user differs.
ARG APP_UID=1000
ARG APP_GID=1000
RUN groupadd --gid "${APP_GID}" app \
 && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home --shell /usr/sbin/nologin app

# Install dependencies first, using only the lockfiles, so this layer is cached
# and only re-runs when dependencies actually change (not on every code edit).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# Now copy the application code.
COPY . .

# Exactly the two directories the running app writes to, and nothing else:
#   /app/media       where the media volume mounts (uploaded photos)
#   /app/staticfiles STATIC_ROOT, rewritten by `collectstatic --clear` each boot
# The rest of /app stays root-owned on purpose, so the app user can read the
# code it runs but cannot rewrite it — that's the half of issue #199 about a
# compromise editing the application in place and surviving a restart invisibly.
RUN mkdir -p /app/media /app/staticfiles \
 && chown "${APP_UID}:${APP_GID}" /app/media /app/staticfiles

# Which release this image is (issue #104). The release workflow passes the git
# tag; a local build stays "dev". config/settings.py reads it and the staff-only
# /api/version/ serves it, so "what is the box actually running?" is answerable
# without SSH — the signal whose absence made the 2026-07-20 deploy stall so hard
# to diagnose. Declared after COPY so it can never invalidate the cached
# dependency layer above.
ARG TIMELINE_VERSION=dev
ENV TIMELINE_VERSION=${TIMELINE_VERSION}
# Same string as an image label, so `docker image inspect` answers it too.
LABEL org.opencontainers.image.version=${TIMELINE_VERSION}

# No `USER` directive, deliberately: the image still STARTS as root and each
# entrypoint decides. entrypoint.prod.sh does one root-only job (aligning
# ownership of the media volume, which is a bind mount to a root-owned host
# directory) and then drops to `app` for migrations, collectstatic and gunicorn —
# so nothing long-running is root. The dev entrypoint stays root because
# docker-compose.yml bind-mounts the host's ./backend over /app, and the host's
# ownership (a macOS uid) has nothing to do with this image's.
#
# Entrypoint waits for Postgres, runs migrations, then starts the dev server.
# Invoked via bash (not as an executable) so it works even when the host source
# is bind-mounted over /app in development, masking the image's file mode bits.
EXPOSE 8000
CMD ["bash", "/app/entrypoint.sh"]
