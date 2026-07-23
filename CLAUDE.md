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

A second read route, **`POST /v1/relevance`** (`src/api/relevance_route.ts` + `src/db/relevance_query.ts`), scores **two specific items against each other**: it reads both items' stored embeddings and returns their cosine similarity as a percentage (0–100). Same `x-api-key` auth; no embed, no write. It carries the same safety gates as anchor search: **interaction-matrix authz** (`registry.isInteractionAllowed`, same-network + allowed domains → else `403`), **live-only scope** (`lifecycle_status='live'` on both sides), and a **`model_version` guard** (`409 RELEVANCE_NOT_COMPARABLE` when the two embeddings are from different models — cosine across model versions is meaningless). `404 RELEVANCE_ITEMS_NOT_INDEXED` when either item is missing, non-live, or has a NULL embedding. It exists so Signals-DPG can replace its former external "match score" service with an in-network pairwise score.

**Spatial center resolution** (`search_route.ts`): a spatial clause with `geometry` uses that explicit point; a clause **without** `geometry` uses the anchor item's own stored location ("search near this profile"), read from `item_search.geo` via `ST_Y/ST_X(ST_GeometryN(geo::geometry, 1))` (MultiPoint → first point; `ST_PointN` would return NULL). The schema requires `intent.item.id` for a geometry-less clause; at runtime a 422 (`ANCHOR_HAS_NO_LOCATION`) is returned if the anchor has no stored location. `distanceMeters` falls back to `SEARCH_DEFAULT_DISTANCE_METERS` (config `search.defaultDistanceMeters`, default 30 km) when omitted. At most one spatial clause is accepted (extras are rejected, not silently dropped).

Core principle: **vectorize at write, rank at read.** No pairwise scores are stored; only the query is embedded online.

## Conventions and gotchas (non-obvious, span multiple files)

- **ESM NodeNext.** Every relative import MUST use a `.js` extension. `ioredis`: import the constructor as `import { Redis } from 'ioredis'` (named) — the default import does not typecheck under NodeNext; import the type via `import type { Redis } from 'ioredis'`.
- **Two tsconfigs.** `tsconfig.json` (rootDir `.`, includes `src`+`test`) is for `typecheck`; `tsconfig.build.json` (rootDir `src`, excludes `*.test.ts`) is for `build` so `dist/` stays flat. `build` also copies `src/db/migrations` → `dist/db/migrations`.
- **postgres.js, not an ORM.** All DB access is parameterized `sql\`...\`` templates (`postgres`). No Drizzle or other ORM in this repo — do not assume one.
- **`item_search` DDL ownership.** `src/db/migrations/0001_item_search.sql` is a **dev/test mirror**; the authoritative copy lives in Signals-DPG `schema.sql` (Plan 3). The worker runs migrations only when `RUN_MIGRATIONS=true` (default **off** = prod-safe); when off it calls `assertSchemaReady` and fails fast if `item_search` is missing. Keep the mirror byte-identical to the authoritative DDL.
- **Embedding dimension is fixed at the column.** `EMBEDDING_DIM` must equal `ITEM_SEARCH_VECTOR_DIM` (1024, `src/db/item_search_repo.ts`); the worker guards this at boot. Changing the model's output dim requires a new migration. Output dim ≤ 2000 (pgvector HNSW limit).
- **OSS-first embeddings (hard requirement).** Default is BGE-M3 (Apache-2.0, 1024-dim) served via HuggingFace TEI (OpenAI-compatible `/v1/embeddings` + `/rerank`). Hosted providers (Gemini/OpenAI/Voyage) are opt-in via `EMBEDDING_BASE_URL` only — an OSS option must always exist.
- **Idempotency is load-bearing.** `indexItem` skips re-embedding when the content hash is unchanged; `upsert` is `ON CONFLICT` on the full composite PK; `delete` is keyed. This makes message re-delivery (reclaim, retry, double-process) safe — preserve it. The content hash now also covers `item_locations` + `lifecycle_status` (#1.10), so location/lifecycle-only changes are re-indexed rather than skipped. See `src/ingest/README.md` for the ingestion pipeline in full, including poison-message handling (Zod validation + delivery-count DLQ) and per-item sweep isolation.
- **Composite primary key** is `(item_network, item_domain, item_type, item_id)`. Repo reads/deletes key on the full PK. The anchor lookup in `search_route.ts` scopes on `item_network AND item_id` (#29) — it uses the PK index (leading `item_network`) and can only resolve an anchor inside the caller's own network (a foreign/absent anchor → `404 ANCHOR_NOT_FOUND`); deliberately not scoped by domain/type (the anchor legitimately differs from the context domain — that's the interaction matrix, see `.claude/rules/pii-and-authz.md`).
- **API-key validity (`auth.ts`).** `authenticateApiKey` accepts a key only when `enabled` AND not past `expires_at` AND `remaining` is null-or-`> 0` (#29), mirroring better-auth's gate. It **reads** `remaining` but never decrements it — better-auth (Signals-DPG) owns the key write path; a decrement here would race it.
- **SQL injection safety.** Structured-filter field keys are bound as parameters to `->>`/`->` (never interpolated) and `target` is regex-restricted to `item_state.<field>`; numeric comparators require numeric values at the schema layer.
- **Filter operators (`src/db/search_query.ts`).** Supported ops: `eq`, `neq`, `in` (array; schema-enforced), `gt`/`gte`/`lt`/`lte` (numeric; schema-enforced finite number), `contains` and `contains_any`. Both array ops target array-valued jsonb fields: `contains` = jsonb `@>` (field contains **all** given values), `contains_any` = jsonb `?|` (field shares **at least one** value with the list). Two easy-to-miss binding rules: (1) `contains` must bind its array via `sql.json(arr)` — a `${JSON.stringify(arr)}::jsonb` cast is sent as text and re-parsed into a jsonb *string scalar* (double-encoded), so `@>` always matched nothing; (2) `contains_any` binds a `text[]` param and uses the literal `?|` operator (postgres.js does not treat `?|` as a placeholder). A single non-array value is wrapped into a one-element array for both.

**PII safety and interaction-matrix authorization** (cross-cutting, span api/ingest/config) are in `.claude/rules/pii-and-authz.md` — path-scoped, loads automatically when you touch those directories.

## Workflow

- Branch model: `develop` (base) → `feature` (integration) → one branch + PR per plan into `feature`. `Closes #N` only auto-fires on merge to the default branch (`develop`), not into `feature`. PRs use `.github/PULL_REQUEST_TEMPLATE.md` (Summary / **Release Notes** / Checklist; `no-release-notes` and `no-doc-update` labels waive the respective sections).
- CI: `.github/workflows/ci.yml` runs on push/PR to **`main`/`develop` only** (prebuilds the test image, then typecheck/build/test). Two image-publish workflows run on push to `develop`: `build-image.yml` (the app image → `ghcr.io/blue-dots-economy/signals-search`) and `build-tei-image.yml` (the `bge-m3` TEI image → `ghcr.io/blue-dots-economy/tei-bge-m3`, path-filtered to `docker/tei-bge-m3/**`).
- Packaging: root `Dockerfile` = one multi-stage app image for both worker and API (entrypoint chosen via Helm `command`; default = API on 3100). `docker/tei-bge-m3/Dockerfile` = TEI with `bge-m3` baked in. Deploy charts live in `bluedots-automation`.
- Implementation plans live in `docs/superpowers/plans/`; this repo is built via TDD (test first) with Testcontainers-backed integration tests.
- **Authoring PRs:** when you open a PR, include an **In Plain Terms** section in the description — a short, jargon-free explanation a non-expert teammate can follow (what the problem was and what the change does), alongside Summary / Release Notes. Skip it only for a pure chore. This is a Claude authoring rule kept out of the GitHub PR template on purpose, so PRs opened from other tools/flows aren't forced through it.
