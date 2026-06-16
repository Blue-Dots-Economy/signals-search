# signals-search

Search & discovery service for **Signals-DPG**. Provides authenticated, ranked-order **similarity search** (vector embeddings via [pgvector](https://github.com/pgvector/pgvector)), **geospatial filtering** (PostGIS), and structured filtering over Signals "items" (profiles).

This is **V1** — a deliberate stepping stone toward the future Beckn/NFH discovery service. It reads the existing **Signals-DPG database only** (single instance, no federation) and replaces the legacy Elasticsearch-based discovery design with Postgres-native search on the shared Postgres instance.

> Status: design phase. See the design + architecture docs before implementing.

## What it answers

- **"Find items relevant to me"** — similarity to an existing item's stored vector (no embedding call; fast path).
- **"Find relevant matches near me"** — similarity + geospatial radius.
- **"Show me items relevant to X"** — free-text query embedded at request time.

All are ranked-order results, optionally combined with geo and structured filters, and scoped to allowed cross-domain interactions (seeker↔provider) defined in `network.json`.

## How it works (one line)

The Signals item write path enqueues changes to Redis → an **ingestion worker** embeds configured public attributes and upserts an `item_search` row (vector + geography) → an **API service** (`POST /v1/search`) applies hard filters, ranks by vector similarity in Postgres, and caches results in Redis.

```
Signals write path ──enqueue──▶ Redis ──▶ ingestion worker ──embed──▶ item_search (pgvector + PostGIS)
Voice bot ──x-api-key──▶ POST /v1/search ──filter + ANN rank──▶ item_search ──join──▶ items (masked state)
```

## Stack

- **TypeScript + Fastify + Drizzle ORM**
- **PostgreSQL** with `pgvector` (similarity) and `postgis` (geospatial), on the shared Signals-DPG database
- **Redis** (shared) — ingestion queue + result/embedding cache
- **Pluggable embedding provider** — self-hostable OSS default (BGE-M3, Apache-2.0, 1024-dim); hosted APIs (Gemini/OpenAI/Voyage) opt-in. Output dimension ≤ 2000 for HNSW indexing

## Key design points

- **Vectorize at write, rank at read.** Vectors are precomputed asynchronously; only the query is embedded at request time. No pairwise scores are stored.
- **Similarity runs in Postgres** (pgvector HNSW + cosine) — no in-memory/FAISS layer.
- **PII-safe.** Only public (non-`private`) attributes are vectorized; `item_private_state` is never decrypted for embedding; results return masked state.
- **Live-only discovery.** Only `lifecycle_status = 'live'` items are returned.
- **Authenticated.** `/v1/search` requires an API key, validated against Signals' existing key store.

## Scope

**In V1:** local single-instance search, ingestion worker, query API, embedding abstraction, Redis caching.
**Not in V1:** cross-instance/federated search, Beckn/NFH catalog subscription, learned re-rankers, fine-grained per-caller authorization.

## Design docs

- Design spec: `2026-06-09-signals-search-engine-design.md`
- Tech architecture (diagrams): `2026-06-09-signals-search-engine-architecture.md`

(These currently live in the `blue-dots-economy` workspace under `docs/superpowers/specs/` and will move here as the service is scaffolded.)

## Development

> To be filled in as the service is scaffolded (install, env, migrations, run worker + API, tests).

## License

[MIT](./LICENSE) © Blue Dots Economy
