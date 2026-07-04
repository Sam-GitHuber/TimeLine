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

# Entrypoint waits for Postgres, runs migrations, then starts the dev server.
# Invoked via bash (not as an executable) so it works even when the host source
# is bind-mounted over /app in development, masking the image's file mode bits.
EXPOSE 8000
CMD ["bash", "/app/entrypoint.sh"]
