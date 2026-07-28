# Multi-stage build for the signals-search service.
# One image serves BOTH the ingestion worker and the query API — the Helm
# deployments select the entrypoint via `command` (node dist/worker/main.js or
# node dist/api/main.js). Network configs are NOT baked in; they are mounted at
# runtime via a ConfigMap (NETWORK_CONFIG_PATH).
FROM node:26-bookworm-slim AS base
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
FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3100
# Default entrypoint = API; the worker Deployment overrides `command`.
CMD ["node", "dist/api/main.js"]
