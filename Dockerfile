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
# dhi.io/node:24-debian12-dev
FROM dhi.io/node@sha256:8a2fc47ac489c577c3695343f29b8793755ca03ad9ca9f50c30a8bbc267acb97 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# --- build: full deps + tsc -> dist (includes copied migration SQL) ---
# --ignore-scripts: no dependency lifecycle script is needed to build or run
# this service. The four script-bearing packages in the tree (cpu-features,
# esbuild, protobufjs, ssh2) are all dev-only and none depends on its script
# having run — esbuild resolves its binary from the @esbuild/<platform> optional
# package and ssh2 falls back to pure JS — so the prod-deps stage below has no
# build scripts at all. pnpm 10 does already block these by default, but that
# default only holds while `packageManager` in package.json stays >= 10; the
# flag makes the guarantee independent of the pnpm version and matches what CI
# already passes (.github/workflows/ci.yml). There is no root pre/post-install
# script to preserve. Note that `pnpm.onlyBuiltDependencies: []` in package.json
# is an empty *allowlist* and is a no-op — removing it changes nothing; it is
# not what blocks these scripts.
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# --- prod-deps: production-only node_modules ---
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# --- runtime ---
# Hardened runtime: no shell, no apt, no npm/corepack. Nothing here needs them —
# this stage was already COPY-only, and `USER node` (uid 1000) is the image's own
# built-in user, matching the runAsUser the deploy charts set for search.
# dhi.io/node:24-debian12
FROM dhi.io/node@sha256:19c211d48e7051e192278c979d73118e22059560a4c2ff0a0c1d403bf8a8b05b AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3100
# Default entrypoint = API; the worker Deployment overrides `command`.
CMD ["node", "dist/api/main.js"]
