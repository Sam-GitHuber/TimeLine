# Production "web" image: build the React app, then bake the compiled static
# files into a Caddy image. Two stages so Node (big, build-only) isn't shipped in
# the final image — the runtime is just Caddy + the static files.
#
# Build context is the repo root (see docker-compose.prod.yml) so this can reach
# the frontend/ directory.

# --- Stage 1: build the SPA ---------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install deps first (cached layer) from the manifest + lockfile only.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Then the source, and build.
COPY frontend/ ./

# Vite inlines VITE_* env vars at BUILD time, so the API origin must be provided
# here (not at container runtime). Set to the public HTTPS origin so the app and
# API are same-origin. Passed from compose as a build arg.
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# --- Stage 2: serve with Caddy ------------------------------------------------
FROM caddy:2-alpine
# The compiled SPA. The Caddyfile itself is mounted at runtime (see compose), so
# it can be tweaked without rebuilding this image.
COPY --from=build /app/dist /srv/app
