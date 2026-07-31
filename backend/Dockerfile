# Backend image: Django + DRF, dependencies managed with uv.
# The uv base image ships the uv binary on top of a slim Python.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# Don't buffer stdout/stderr — logs show up immediately in `docker compose`.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Install into the system environment inside the container (no extra venv).
    UV_PROJECT_ENVIRONMENT=/usr/local

WORKDIR /app

# Install dependencies first, using only the lockfiles, so this layer is cached
# and only re-runs when dependencies actually change (not on every code edit).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# Now copy the application code.
COPY . .

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

# Entrypoint waits for Postgres, runs migrations, then starts the dev server.
# Invoked via bash (not as an executable) so it works even when the host source
# is bind-mounted over /app in development, masking the image's file mode bits.
EXPOSE 8000
CMD ["bash", "/app/entrypoint.sh"]
