# Multi-stage build for the signals-search service.
# One image serves BOTH the ingestion worker and the query API — the Helm
# deployments select the entrypoint via `command` (node dist/worker/main.js or
# node dist/api/main.js). Network configs are NOT baked in; they are mounted at
# runtime via a ConfigMap (NETWORK_CONFIG_PATH).
# Build stages use the DHI *dev* variant — the only one carrying a shell, apt,
# corepack and npm. The runtime stage below uses the hardened variant, which has
# none of them, so no RUN is possible past that FROM.
# debian12 (not debian13) to match the previous bookworm-slim base exactly:
# bookworm IS Debian 12, so this keeps the same glibc/Debian generation.
FROM dhi.io/node:24-debian12-dev AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# --- build: full deps + tsc -> dist (includes copied migration SQL) ---
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# --- prod-deps: production-only node_modules ---
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- runtime ---
# Hardened runtime: no shell, no apt, no npm/corepack. Nothing here needs them —
# this stage was already COPY-only, and `USER node` (uid 1000) is the image's own
# built-in user, matching the runAsUser the deploy charts set for search.
FROM dhi.io/node:24-debian12 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3100
# Default entrypoint = API; the worker Deployment overrides `command`.
CMD ["node", "dist/api/main.js"]
