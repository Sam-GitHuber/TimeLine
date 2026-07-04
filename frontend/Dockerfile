# Frontend image (Phase 0): runs the Vite dev server with hot reload.
# Production build/serving is set up in a later phase.
FROM node:22-bookworm-slim

WORKDIR /app

# Install deps first (cached layer) using only the manifest + lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the app source.
COPY . .

EXPOSE 5173
# --host makes the dev server reachable from outside the container.
CMD ["npm", "run", "dev", "--", "--host"]
