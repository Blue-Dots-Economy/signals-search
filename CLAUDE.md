# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this service is

`signals-search` is the V1 search & discovery service for **Signals-DPG** — a stepping stone toward a future Beckn/NFH discovery service. It is **Postgres-native** (pgvector + PostGIS) and reads/writes the **shared Signals-DPG database only** (single instance, no federation), replacing a legacy Elasticsearch design. See `README.md` for the product framing and `docs/2026-06-09-signals-search-engine-design.md` for the full spec. Network-model vocabulary (network / domain / instance / item / action) is defined in the workspace-root `CLAUDE.md` and `Signals-DPG/CLAUDE.md`.

## Commands

```bash
pnpm install
pnpm typecheck                       # tsc -p tsconfig.json --noEmit (includes tests)
pnpm build                           # tsc -p tsconfig.build.json + copies migration SQL into dist/
pnpm test                            # vitest run (Testcontainers — Docker MUST be running)
pnpm vitest run <path/to/file.test.ts>   # a single test file
pnpm worker                          # ingestion worker  (dist/worker/main.js)
pnpm api                             # query API         (dist/api/main.js, POST /v1/search)
```

- **Tests need Docker.** They spin up real Postgres (pgvector+postgis) and Redis 7 via Testcontainers. The PG image is built from `test/docker/Dockerfile.postgres` (base `imresamu/postgis` — the multi-arch/arm64 mirror; keep it). A cold image build can exceed vitest's hook timeout — prebuild it to avoid flakes:
  `docker build -t signals-search-pg-test test/docker -f test/docker/Dockerfile.postgres`
- All config is env-driven via `src/config.ts` (Zod-validated `loadConfig`); see `.env.example`.

## Architecture (the big picture)

Two long-running processes share this repo and the same Signals Postgres DB, coordinated only through the **`item_search` read-model table** (vector + geography). There is no shared in-process state.

**Ingestion (write side)** — `src/worker/main.ts`:
Signals' item write path enqueues `{item_key, op}` to a Redis Stream → the worker consumes (`src/ingest/stream_consumer.ts`), reads the item's public attributes from `items`, embeds the configured `vectorize` fields (`src/ingest/serialize.ts` → `src/embedding/provider.ts`), and upserts the `item_search` row (`src/db/item_search_repo.ts`). A periodic **reconciliation sweep** (`src/ingest/sweep.ts`, `runSweep`) re-indexes anything where `items.updated_at > item_search.indexed_at` and **prunes orphans** (`sweepOrphans`) whose `items` row is gone. Stranded stream messages from a dead consumer are recovered with `reclaimPending` (XAUTOCLAIM).

**Query (read side)** — `src/api/server.ts` + `src/api/search_route.ts` (`POST /v1/search`):
Beckn-aligned envelope (`context` + `message`, `src/api/schemas.ts`) → API-key auth (`src/api/auth.ts`) → served-domain + interaction-matrix scope (`src/config/network_registry.ts`) → **filter-then-rank** in Postgres (`src/db/search_query.ts`: cosine `<=>` + PostGIS `ST_DWithin` + structured `item_state` filters, live-only) → optional cross-encoder rerank (`src/rerank/reranker.ts`, off by default) → short-TTL Redis cache (`src/api/result_cache.ts`). Anchor search (`intent.item.id`) reads the stored vector (no embed); free-text embeds the query at request time.

Core principle: **vectorize at write, rank at read.** No pairwise scores are stored; only the query is embedded online.

## Conventions and gotchas (non-obvious, span multiple files)

- **ESM NodeNext.** Every relative import MUST use a `.js` extension. `ioredis`: import the constructor as `import { Redis } from 'ioredis'` (named) — the default import does not typecheck under NodeNext; import the type via `import type { Redis } from 'ioredis'`.
- **Two tsconfigs.** `tsconfig.json` (rootDir `.`, includes `src`+`test`) is for `typecheck`; `tsconfig.build.json` (rootDir `src`, excludes `*.test.ts`) is for `build` so `dist/` stays flat. `build` also copies `src/db/migrations` → `dist/db/migrations`.
- **postgres.js, not an ORM.** All DB access is parameterized `sql\`...\`` templates (`postgres`). `drizzle-orm` appears in `package.json` but is **unused** — do not assume Drizzle.
- **`item_search` DDL ownership.** `src/db/migrations/0001_item_search.sql` is a **dev/test mirror**; the authoritative copy lives in Signals-DPG `schema.sql` (Plan 3). The worker runs migrations only when `RUN_MIGRATIONS=true` (default **off** = prod-safe); when off it calls `assertSchemaReady` and fails fast if `item_search` is missing. Keep the mirror byte-identical to the authoritative DDL.
- **Embedding dimension is fixed at the column.** `EMBEDDING_DIM` must equal `ITEM_SEARCH_VECTOR_DIM` (1024, `src/db/item_search_repo.ts`); the worker guards this at boot. Changing the model's output dim requires a new migration. Output dim ≤ 2000 (pgvector HNSW limit).
- **OSS-first embeddings (hard requirement).** Default is BGE-M3 (Apache-2.0, 1024-dim) served via HuggingFace TEI (OpenAI-compatible `/v1/embeddings` + `/rerank`). Hosted providers (Gemini/OpenAI/Voyage) are opt-in via `EMBEDDING_BASE_URL` only — an OSS option must always exist.
- **PII safety.** Only public (non-`private`) attributes are vectorized; `item_private_state` is never read for embedding; query results return the **masked** `item_state` from `items`. `network_registry.vectorizeFields` excludes private fields.
- **Idempotency is load-bearing.** `indexItem` skips re-embedding when the content hash is unchanged; `upsert` is `ON CONFLICT` on the full composite PK; `delete` is keyed. This makes message re-delivery (reclaim, retry, double-process) safe — preserve it.
- **Composite primary key** is `(item_network, item_domain, item_type, item_id)`. Repo reads/deletes key on the full PK. (Known exception: the anchor lookup in `search_route.ts` keys on `item_id` alone — tracked follow-up.)
- **Interaction matrix = authz.** Cross-domain scope comes from `network.json` `actions[*].interactions[*]`; the anchor path enforces `anchorDomain → contextDomain` (403 if not allowed). Free-text/geo-only requests are scoped by served-domain only (no anchor source).
- **SQL injection safety.** Structured-filter field keys are bound as parameters to `->>`/`->` (never interpolated) and `target` is regex-restricted to `item_state.<field>`; numeric comparators require numeric values at the schema layer.

## Workflow

- Branch model: `develop` (base) → `feature` (integration) → one branch + PR per plan into `feature`. `Closes #N` only auto-fires on merge to the default branch (`develop`), not into `feature`.
- CI (`.github/workflows/ci.yml`) runs on push/PR to **`main`/`develop` only** (it prebuilds the test image, then typecheck/build/test).
- Implementation plans live in `docs/superpowers/plans/`; this repo is built via TDD (test first) with Testcontainers-backed integration tests.
