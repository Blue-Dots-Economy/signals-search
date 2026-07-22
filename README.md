# signals-search

Search & discovery service for **Signals-DPG**. Provides authenticated, ranked-order **similarity search** (vector embeddings via [pgvector](https://github.com/pgvector/pgvector)), **geospatial filtering** (PostGIS), and structured filtering over Signals "items" (profiles).

This is **V1** — a deliberate stepping stone toward the future Beckn/NFH discovery service. It reads the existing **Signals-DPG database only** (single instance, no federation) and replaces the legacy Elasticsearch-based discovery design with Postgres-native search on the shared Postgres instance.

> Status (V1): the ingestion worker, the query API (`POST /v1/search`), and worker hardening for cutover are all implemented and tested. This repo also builds and publishes **both** container images used in deployment — the app image (serves the worker and the API from one image) and the TEI embedding image with `BAAI/bge-m3` baked in — via CI on `develop`. The Helm/deploy wiring lives in `bluedots-automation`, and the enqueue producer + authoritative `item_search` DDL live in `Signals-DPG`. V1 is in deploy/cutover.

## What it answers

- **"Find items relevant to me"** — similarity to an existing item's stored vector (no embedding call; fast path).
- **"Find relevant matches near me"** — similarity + geospatial radius. The radius can be centered on an explicit point, or — when the spatial clause omits `geometry` — on the **anchor item's own stored location** ("near this profile"). A spatial clause without `geometry` therefore requires `intent.item.id`, and the radius falls back to `SEARCH_DEFAULT_DISTANCE_METERS` when `distanceMeters` is omitted.
- **"Show me items relevant to X"** — free-text query embedded at request time.

All are ranked-order results, optionally combined with geo and structured filters, and scoped to allowed cross-domain interactions (seeker↔provider) defined in `network.json`.

### Structured filters

Filter clauses target `item_state.<field>` and support these operators: `eq`, `neq`, `in` (array), `gt`/`gte`/`lt`/`lte` (numeric), `contains` (jsonb `@>` — array field contains **all** given values), and `contains_any` (jsonb `?|` — array field shares **at least one** value with the given list). Field keys are always bound as parameters, never interpolated.

## How it works (one line)

The Signals item write path enqueues changes to Redis → an **ingestion worker** embeds configured public attributes and upserts an `item_search` row (vector + geography) → an **API service** (`POST /v1/search`) applies hard filters, ranks by vector similarity in Postgres, and caches results in Redis.

```
Signals write path ──enqueue──▶ Redis ──▶ ingestion worker ──embed──▶ item_search (pgvector + PostGIS)
Voice bot ──x-api-key──▶ POST /v1/search ──filter + ANN rank──▶ item_search ──join──▶ items (masked state)
```

## Stack

- **TypeScript (ESM, NodeNext) + Fastify + Zod**
- **[postgres.js](https://github.com/porsager/postgres)** for DB access (parameterized `sql` templates — no ORM layer)
- **PostgreSQL** with `pgvector` (similarity) and `postgis` (geospatial), on the shared Signals-DPG database
- **Redis** (shared) — ingestion queue + result/embedding cache
- **Embedding & reranking via HuggingFace TEI** (in-cluster, OpenAI-compatible) — OSS default **BGE-M3** (Apache-2.0, 1024-dim) for embeddings + optional **bge-reranker-v2-m3** cross-encoder; hosted APIs (Gemini/OpenAI/Voyage) opt-in via config base_url. Output dimension ≤ 2000 for HNSW indexing

## Key design points

- **Vectorize at write, rank at read.** Vectors are precomputed asynchronously; only the query is embedded at request time. No pairwise scores are stored.
- **Similarity runs in Postgres** (pgvector HNSW + cosine) — no in-memory/FAISS layer.
- **PII-safe.** Only public (non-`private`) attributes are vectorized; `item_private_state` is never decrypted for embedding; results return masked state.
- **Live-only discovery.** Only `lifecycle_status = 'live'` items are returned.
- **Authenticated.** `/v1/search` requires an API key, validated against Signals' existing key store.

## Flattened search — `POST /v1/search/flat` (for one-level-only tool integrations)

Some LLM-tool platforms (e.g. **Raya / Litwiz**, which drives the voice bot) can only produce a **flat object of string values** — they can't build the deeply nested `/v1/search` body (`message.intent.spatial[].geometry.coordinates`). `POST /v1/search/flat` accepts that flat shape and runs the **exact same search**; the canonical `/v1/search` contract is unchanged.

Rules for the flat body:

- Keys are the **dot-delimited canonical path** into the nested request.
- A **numeric key segment is an array index** (`...filters.0.op`, `...coordinates.1`).
- **Values may all be strings.** Each leaf is `JSON.parse`d to restore its real type (`"20"`→`20`, `"true"`→`true`, `["a","b"]`→array); if it isn't valid JSON it stays a string (`"plumber"`).
- **Type coercion is safe for equality filters.** A numeric-looking value parses to a **number** (`"560001"`→`560001`), but the `eq`/`neq`/`in` filter ops compare `item_state->>field` (text) against the value coerced with `String(...)`, so a numeric-string filter value (pincode, id-like code) still matches a string-stored field — no escaping needed. The one exception is the array op **`contains`** (jsonb `@>`, which is type-strict): to match string elements send them as a JSON-quoted string array, e.g. `"[\"560001\"]"`, not `"[560001]"`.
- **Required string fields must not be all-digits.** An all-numeric `context.messageId`/`networkId` parses to a number and fails validation; send a JSON-quoted string (`"\"12345\""`) if you must use one.
- **Use contiguous array indices from `0`.** A gap (e.g. `filters.0.*` and `filters.2.*` with no `filters.1.*`) leaves a hole in the rebuilt array and is rejected with `400 VALIDATION_ERROR`. Indices are capped (max 10,000) — a larger index is rejected with `400`, not silently expanded into a huge array.
- Keys containing `__proto__`, `constructor`, or `prototype` segments are ignored (they are never valid canonical paths).

Same auth (`x-api-key`), same responses, and the same `400 VALIDATION_ERROR` as `/v1/search` (raised after unflattening — including a malformed flat body, e.g. an over-large index or a key that is both a scalar and a parent). Worked examples, one per mode:

```jsonc
// free-text
{ "context.networkId": "blue_dot", "context.domain": "seeker", "context.itemType": "profile_1.0",
  "context.messageId": "abc-1", "message.intent.textSearch": "plumber" }

// anchor ("more like this profile")
{ "context.networkId": "blue_dot", "context.domain": "seeker", "context.itemType": "profile_1.0",
  "context.messageId": "abc-2", "message.intent.item.id": "0e0f...-uuid" }

// geo (explicit point + radius)
{ "context.networkId": "blue_dot", "context.domain": "seeker", "context.itemType": "profile_1.0",
  "context.messageId": "abc-3", "message.intent.textSearch": "plumber",
  "message.intent.spatial.0.op": "s_dwithin",
  "message.intent.spatial.0.geometry.type": "Point",
  "message.intent.spatial.0.geometry.coordinates.0": "77.59",
  "message.intent.spatial.0.geometry.coordinates.1": "12.97",
  "message.intent.spatial.0.distanceMeters": "5000" }

// structured filter
{ "context.networkId": "blue_dot", "context.domain": "seeker", "context.itemType": "profile_1.0",
  "context.messageId": "abc-4", "message.intent.textSearch": "plumber",
  "message.intent.filters.0.op": "eq",
  "message.intent.filters.0.target": "item_state.trade",
  "message.intent.filters.0.value": "plumber" }
```

The live request/response schema is also published in the generated OpenAPI at `/documentation` (spec JSON at `/documentation/json`).

## Pairwise relevance — `POST /v1/relevance`

Where `/v1/search` ranks a corpus against a query, `/v1/relevance` scores **two specific items against each other**. Given two item references it returns a single relevance **percentage (0–100)** — the cosine similarity of their already-stored embeddings, scaled ×100 (higher = more similar). It performs no embedding call and no writes; both items must already be indexed in `item_search`.

Same auth as search (`x-api-key`). Score only — no band/confidence/reasoning.

```jsonc
// request
{ "itemA": { "item_network": "blue_dot", "item_domain": "seeker", "item_type": "profile_1.0", "item_id": "0e0f...-uuid" },
  "itemB": { "item_network": "blue_dot", "item_domain": "provider", "item_type": "profile_1.0", "item_id": "1a2b...-uuid" } }

// response
{ "score": 87.34 }
```

Returns `404 RELEVANCE_ITEMS_NOT_INDEXED` when either item is missing from `item_search` or has no embedding, and `400 VALIDATION_ERROR` for a malformed body.

## Scope

**In V1:** local single-instance search, ingestion worker, query API, embedding abstraction, Redis caching.
**Not in V1:** cross-instance/federated search, Beckn/NFH catalog subscription, learned re-rankers, fine-grained per-caller authorization.

## Design docs

In `docs/`:

- Design spec: `docs/2026-06-09-signals-search-engine-design.md`
- Tech architecture (diagrams): `docs/2026-06-09-signals-search-engine-architecture.md`
- Implementation plans: `docs/superpowers/plans/` (Plan 1 ingestion, Plan 2 query API, Plan 5 worker hardening; Plans 3 & 4 for Signals-DPG and automation live in those repos)

## Development

```bash
pnpm install
pnpm test        # vitest + testcontainers (Docker required; first run builds a pgvector+postgis image)
pnpm typecheck
pnpm build       # tsc -> dist/ (+ copies migration SQL)
pnpm worker      # ingestion worker (DATABASE_URL, REDIS_URL, EMBEDDING_BASE_URL, NETWORK_CONFIG_PATH)
pnpm api         # query API on API_PORT (same env + serves POST /v1/search)
```

Tests use Testcontainers; ensure Docker is running. The Postgres test image (`test/docker/Dockerfile.postgres`) bundles pgvector + PostGIS. See `.env.example` for all config. Note `RUN_MIGRATIONS` defaults to **off** — the worker assumes the `item_search` schema already exists (owned by Signals-DPG in prod) and fails fast if not; set `RUN_MIGRATIONS=true` for local/dev to apply the bundled migration.

## Container images

Two images are built and published to GHCR by CI:

- **App image** (`Dockerfile`, `.github/workflows/build-image.yml`) — a single multi-stage image that serves both the ingestion worker and the query API; the Helm deployments pick the entrypoint via `command` (default is the API on port 3100). Network configs are mounted at runtime (not baked in). Published as `ghcr.io/blue-dots-economy/signals-search:develop` (+ a `sha` tag) on push to `develop`.
- **TEI embedding image** (`docker/tei-bge-m3/Dockerfile`, `.github/workflows/build-tei-image.yml`) — HuggingFace TEI with `BAAI/bge-m3` (pinned revision) baked in, consumed by the `bluedots-automation` search-embeddings chart. Published as `ghcr.io/blue-dots-economy/tei-bge-m3:cpu-1.7-bge-m3` (+ a `sha` tag) on manual dispatch or when the Dockerfile/pinned revision changes.

## License

[MIT](./LICENSE) © Blue Dots Economy
