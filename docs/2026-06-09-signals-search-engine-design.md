# Signals Search Engine — V1 Design Spec

**Date:** 2026-06-09
**Status:** Design approved (pending written-spec review)
**Author:** Aniket + Claude (brainstorming session)

---

## 1. Purpose & Scope

Build the first version of a **search/discovery service for Signals-DPG**: ranked similarity search + geospatial filtering + structured filtering over Signals `items` ("profiles"). It replaces the legacy Elasticsearch-based discovery design with **PostgreSQL + pgvector** (vectors) and **PostGIS** (geo), running against the **existing shared Postgres instance, Signals-DPG database only**.

### In scope (V1)
- A new repository `signals-search` (TypeScript + Fastify + Drizzle).
- An **ingestion path** that keeps a vector + geo index in sync with `items`.
- An authenticated **query API** answering: "items relevant to me (an item)", "relevant matches near me", "items relevant to free-text X" — all ranked-order similarity, optionally geo/structured filtered.
- Embedding via a **pluggable provider** (hosted default), configurable per deployment.
- Result caching in the shared Redis.

### Explicitly out of scope (V1) — future / NFH stepping stone
- **Cross-instance / federated search.** V1 searches the local DB only. (Current inter-instance federation is unauthenticated; not a base to build on — see memory `project_signals_interinstance_trust`.)
- **Beckn/NFH catalog subscription.** The future discovery service subscribes to Beckn catalogs and mirrors them; V1 treats the Signals `items` table as the catalog. This design is a deliberate stepping stone toward that.
- Learned/ML re-rankers and outcome-feedback loops (the legacy doc's "next steps"). A rules re-ranker is an optional later stage.
- Fine-grained per-caller result authorization (V1 is authentication-gated discovery).

### Key constraints
- **Latency:** `/v1/search` p95 < 1 s (called frequently by voice bots).
- **Scale:** < 100k profiles per instance, typically ~25k. (Headroom analysis in §11.)
- **Shared Postgres:** the instance is shared by aggregator + Signals; the search index lives in the Signals DB and must not destabilize the hot OLTP path.

---

## 2. Ground-truth facts this design builds on (verified 2026-06-09)

- `items` table: composite PK `(item_network, item_domain, item_type, item_id)`; `item_state jsonb` (public state, with PII fields stored as **masked** placeholders); `item_private_state text` (encrypted original of the private fields); **`item_locations jsonb` = array of `{lat, lng, label?}`**; `lifecycle_status` ∈ `draft|live|paused`. No vector column, no separate lat/long columns.
- Extensions enabled today: `pgcrypto`, `cube`, `earthdistance`. **PostGIS and pgvector are NOT enabled yet.**
- Geo today: `earth_distance` over `jsonb_array_elements(item_locations)` (≈6 km error, not well indexable).
- **No event/outbox/NOTIFY on writes** — only Redis cache invalidation (`invalidateItemFetchCache`, best-effort `.catch(warn)`).
- Item-type schemas live in `network.json` `item_schemas`, with per-property markers (`private: true`, `location: single|multiple`). Allowed cross-domain **interactions are defined in `network.json`** (seeker→provider, provider→seeker, provider→provider per use case) — the same matrix that hard-enforces `connect`.
- `items` is **partitioned by network then domain** (nested LIST partitions); shared DB; no RLS.
- PII model: `item_state` PII fields = masks; `item_private_state` = encrypted original. **Never** decrypt private state for embedding.

---

## 3. Resolved Design Decisions

### D1 — New table `item_search` (NOT altering `items`)
A new table, 1:1 with `items`, **partitioned by `(item_network, item_domain)`** to mirror `items`, with `ON DELETE CASCADE` from `items` (deletes self-clean). Keeps the hot OLTP `items` table lean and lets the search repo own its migrations, extensions, and re-index lifecycle independently. Read path joins back to `items` for the masked `item_state` to return.

**Rejected:** adding `vector`/`geography` columns to `items` — bloats the hot partitioned table, couples search migrations into Signals core, and makes embedding-dimension changes a migration on the hot table.

### D2 — Keep multi-location as an array; match nearest (no row explosion)
One `item_search` row per item. All of an item's points stored as a single **`geography(MultiPoint,4326)`**, GiST-indexed. A query matches if **any** point is within range (`ST_DWithin`) and ranks by the **nearest** matching point (`ST_Distance`). Serves the purple-dots "serviceable cities matter more than HQ" case directly.

**Sub-decision:** adopt **PostGIS** (indexable `geography`, accurate `ST_DWithin`/`ST_Distance`, KNN ordering) over `earthdistance` (coarse, hard to index for multipoint). Cost: one extension on the shared PG.

**Rejected:** exploding to one row per `(item, location)` — N× rows + dedupe complexity for items serving many cities.

### D3 — Vectorize at WRITE (async); embed the QUERY at READ
Corpus vectors are computed when items change; only the query is embedded at read time. The <1 s budget cannot absorb embedding the corpus per query.

**Ingestion contract (per decision: ingestion is owned by Signals, "make Signals better to serve search"):**
1. Signals' `createItemInternal` / `updateItemInternal` / delete path **enqueues `{item_key, op, occurred_at}`** to the shared Redis **after commit** — best-effort, mirroring the existing `invalidateItemFetchCache().catch(warn)` so it can never break the item write.
2. The **ingestion worker** (in `signals-search`) drains the queue → serializes configured public attributes → computes `content_hash` (skip re-embed if unchanged) → calls the embedding provider → upserts `item_search` (vector + geography + denormalized filter fields + `model_version` + `content_hash` + `indexed_at`).
3. **Reconciliation sweep** (periodic): re-index rows where `items.updated_at > item_search.indexed_at` (or missing). Self-heals dropped enqueues, performs **initial backfill**, and drives **model/config-change re-index**. This is the only residual poll, used purely as a backstop.

### D4 — Pre-compute vectors at write; compute similarity at READ
No pairwise similarity is stored (O(n²) is infeasible and pointless). Store one vector per item; compute top-k at query time via the ANN index. "Recompute on update" = re-embed only the one changed item. **Similarity happens on query, not during indexing.**

### D5 — Single composable endpoint (filter-then-rank)
One `POST /v1/search` composes structured + geo + vector. **Fusion = filter-then-rank:** structured filters and geo (`ST_DWithin`) are **hard filters** narrowing candidates; **vector cosine similarity is the ranker**; optional distance tiebreak/boost. The existing public `/network/item/fetch` remains for pure structured fetch.

**Rejected:** separate similarity/geo endpoints — forces client-side orchestration + a second round-trip for the common "relevant near me" case and prevents joint ranking.

### D6 — Query API parameters

```
POST /v1/search        (auth required — see D-Auth)
{
  "target":  { "network": "...", "domain": "...", "type": "..." },   // validated vs network.json interaction matrix
  "anchor":  { "item_id": "..." } | { "text": "free text" },          // optional; drives the query vector
  "filters": { ...item_state containment / structured... },           // optional
  "near":    { "lat": .., "lng": .., "radius_m": .. },                 // optional
  "metric":  "cosine",                                                 // default; see note
  "limit":   20, "offset": 0
}
```

- `anchor.item_id` → reuse the item's **stored** vector → **no embedding call** → pure in-DB (fastest; "relevant to me").
- `anchor.text` → embed at runtime (one call, cached by text hash; "relevant to X").
- no `anchor` → pure geo/structured, ranked by distance ("matches near me").
- `target` validated against the **interaction matrix** in `network.json`: a caller may only search domains its source domain is allowed to interact with; otherwise reject. Always cross-domain per use-case definition.

**Metric selection:** pgvector supports cosine `<=>`, L2 `<->`, inner-product `<#>`, but each fast metric needs its own HNSW opclass index. **V1 ships cosine only** (vectors L2-normalized at write; cosine ≡ inner-product). The `metric` param is reserved in the schema for future metrics.

### D7 — Reuse jobstack patterns, not code
Reuse (ported to TS): the embedding-provider abstraction; config-driven attribute selection + weighting; deterministic text serializer (`profile_text_for_embedding` equivalent); Redis embed-cache by text hash; optional rules re-ranker (Jaro-Winkler / range penalties) as a post-vector stage.
Drop: FAISS, `index_store`/rebuild-from-DB (pgvector self-maintains), Rust. The new service is TS/Fastify/Drizzle (consistency with Signals; PG does the heavy lifting so app-layer perf is non-critical).

### D-Auth — API-key authentication (reuse Signals better-auth)
`/v1/search` requires `x-api-key`, validated against the **existing Signals `apikey` table / better-auth `verifyApiKey`** (voice bots/aggregators already hold service-user keys there). One identity source — no parallel key store. Capture the caller's org for rate-limiting + audit. V1 = authentication-gated discovery (results still live-only + masked + within an allowed target domain). **Rejected:** HMAC (dpg-scoring style) or a private key store (match-engine style) — both add a second identity system.

---

## 4. Data Model

### `item_search` (new; partitioned by network, domain)
| Column | Type | Notes |
|---|---|---|
| `item_network`,`item_domain`,`item_type`,`item_id` | (match `items`) | composite PK; FK → `items` `ON DELETE CASCADE` |
| `embedding` | `vector(D)` | D configurable per deployment, **≤ 2000** for HNSW (default 768); L2-normalized |
| `geo` | `geography(MultiPoint,4326)` | all `item_locations` points; GiST-indexed |
| `item_type_filter` / denormalized filter fields | as needed | to support hard filters without joining `items` |
| `lifecycle_status` | text | copied for `WHERE lifecycle_status='live'` |
| `model_version` | text | embedding model + dim identifier |
| `content_hash` | text | hash of serialized vectorized text; skip re-embed if unchanged |
| `indexed_at` | timestamptz | reconciliation watermark |

Indexes: HNSW on `embedding` (`vector_cosine_ops`); GiST on `geo`; partition-local btree on filter columns as needed.

### Extensions to enable on the shared PG
`CREATE EXTENSION vector; CREATE EXTENSION postgis;` (in addition to existing `pgcrypto`, `cube`, `earthdistance`).

---

## 5. Vectorization Config (`network.json`)

Per item-type schema property, a new optional marker:
```json
"skills": { "type": "string", "vectorize": true, "vector_weight": 2 }
```
- **Only non-`private` properties may carry `vectorize`** — config validation rejects `vectorize` on a `private:true` property (private values in `item_state` are masks, and must never be decrypted for an external embedding API).
- A deterministic **serializer** concatenates the configured public fields (respecting `vector_weight` by repetition/ordering) into the text that gets embedded; `content_hash` is taken over this serialized text so updates that don't touch vectorized fields skip re-embedding.

---

## 6. Embedding Provider (pluggable)

- Interface: `embed(texts: string[]) -> vector[]`; deployment selects provider + model + output dimension via config.
- **Default:** hosted provider (reuse the dpg-scoring/jobstack Gemini integration pattern), with **output dimension capped ≤ 2000** so pgvector HNSW can index (e.g. 768 default; `gemini-embedding-001` supports configurable output dimensionality).
- Local/self-hosted model is a later plug-in (offline/air-gapped/cost-sensitive) — not built in V1.
- Vectors L2-normalized before storage (cosine via normalized inner product).
- Redis embed-cache keyed by `(model_version, hash(text))`.

---

## 7. Query Flow (read path)

1. Authenticate `x-api-key` (Signals `apikey`); resolve caller org.
2. Validate `target` against `network.json` interaction matrix.
3. Resolve query vector: `anchor.item_id` → stored vector (no embed call); `anchor.text` → embed (cached); none → skip vector ranking.
4. Build SQL: `WHERE lifecycle_status='live'` + partition prune on target network/domain + structured filters + `ST_DWithin(geo, $point, $radius_m)` if `near`.
5. Rank: if vector present, `ORDER BY embedding <=> $qvec` (HNSW); else `ORDER BY ST_Distance(...)`. Optional distance tiebreak/boost.
6. `LIMIT/OFFSET`; join `items` for masked `item_state`; return.
7. Cache the response in Redis (short TTL, ~30–60 s, keyed by normalized request incl. query-embedding hash).

---

## 8. Security & PII Rules (hard constraints)

- Vectorize **public attributes only**; never `item_private_state`, never masked fields. Enforced at config-validation time.
- Search returns **only `lifecycle_status='live'`** items; never `draft`/`paused`.
- Returned `item_state` is the **masked** public state (parity with today's public fetch).
- `/v1/search` requires a valid API key; no anonymous access.
- Embedding text sent to an external provider must be guaranteed free of private fields (same risk class dpg-scoring manages by redaction).

---

## 9. Caching (shared Redis)

- **Query-result cache:** key = normalized request (incl. query-embedding hash); short TTL (~30–60 s) — ideal for voice-bot repeat calls; avoids precise invalidation.
- **Embedding cache:** key = `(model_version, hash(text))`; longer TTL.

---

## 10. Components & Repository

New repo **`signals-search`** (TS/Fastify/Drizzle), two processes:
- **Ingestion worker:** drains the Redis queue Signals publishes on item write/delete + reconciliation sweep; serializes → embeds → upserts `item_search`.
- **API service:** `POST /v1/search` (auth, interaction-matrix validation, filter-then-rank, Redis cache).

Changes to **Signals-DPG** (the only core changes): best-effort enqueue in the item write/delete path; `vectorize` markers in `network.json` schemas; enable `vector` + `postgis` extensions; `item_search` migration.

---

## 11. Scale & Latency Analysis

**At target (≤100k/instance, ~25k typical):** trivial for pgvector. HNSW build = seconds; ANN query < 5 ms; geo `ST_DWithin` < 20 ms. Memory: 768-d float4 ≈ 3 KB/row → 100k ≈ 300 MB vectors + ~2× HNSW graph ≈ 0.6–1 GB on the shared PG.

**Latency:** dominant cost is the **external embedding hop for free-text** (~100–400 ms), not the search. `item_id` path skips embedding → < 30 ms total. Free-text → 1 embedding call + < 30 ms; cache repeats. Comfortably < 1 s.

**Where it strains (max-profiles question):** providers are typically a fraction of seekers (~10–20%), and a query targets the opposite domain, so the searchable set per query is the target-domain subset — extra headroom. The shared-PG / single-instance / HNSW design is comfortable to ~**500k–1M rows/instance**. Beyond that, in order: HNSW memory + `maintenance_work_mem` for builds; shared-instance contention (aggregator + Signals + search on one PG); embedding throughput under churn (hosted API rate limits). Escape hatches (already latent): **partition-wise HNSW** (per network/domain partition), a **read replica** for search, `halfvec`/quantization, or an external vector store. None needed at stated scale.

---

## 12. Open Questions / To Confirm on Review
- Default embedding dimension (768 vs 1536) and provider/model defaults per deployment.
- Whether the optional rules re-ranker is in V1 or deferred.
- Whether result cache TTL / rate-limit thresholds need per-caller (org) tuning.

---

## 13. Future (NFH stepping stone)
The future Beckn/NFH discovery service subscribes to Beckn catalogs, mirrors each catalog into Postgres on update, and serves queries from the same pgvector + PostGIS index. V1's ingestion contract (enqueue → worker → `item_search`) and query API are designed so the catalog-subscription source can be swapped in behind the same index and endpoint without reworking the query layer.

---

## 14. Cross-Repo Implementation Plan

The work spans **three repos** (a fourth is deferred). Decisions:
- **`vectorize` markers** → added to **Signals-DPG `examples/schemas/`** for V1 (NOT the dedicated schemas repo yet). Moving them to `bluedots-allusecase-schemas` is tracked separately (Signals-DPG#176).
- **`item_search` DDL + `vector`/`postgis` extensions** → declared in **Signals-DPG's authoritative `schema.sql`** (the single idempotent DDL authority for the shared `dpg` DB, applied by the deploy migrate-job). The bundling problem this adds to is tracked separately (Signals-DPG#177). `signals-search` keeps only a read-model (Drizzle types), not migration ownership.

### Repo ownership

| Repo | Owns | Changes for this work |
|---|---|---|
| **bluedots-automation** | EKS + Helm + OpenTofu; shared Postgres bootstrap (`common-services/.../00-bootstrap.sh`, superuser), Redis, secrets/env, deploy order, service-user/apikey provisioning | Add `CREATE EXTENSION vector; CREATE EXTENSION postgis;` to bootstrap; new `search` Helm subchart (worker + API deploy, HPA, ingress); secrets (embedding key, DB/Redis URLs); wire into `install.sh` deploy order after `signals` |
| **Signals-DPG** | Authoritative `schema.sql` DDL for `dpg` DB; item write path (`ioredis` client + best-effort `.catch(warn)` precedent); dev example schemas | Add `item_search` table + extensions to `schema.sql` source + re-bundle; add `vectorize` markers to `examples/schemas/`; add best-effort enqueue after create/update/delete |
| **signals-search** | The service | `item_search` read-model; embedding provider; ingestion worker + reconciliation/backfill sweep; `POST /v1/search` (auth, interaction-matrix validation, filter-then-rank, Redis cache) |
| *bluedots-allusecase-schemas (deferred)* | *Canonical prod network.json* | *Receives markers + schemas later — Signals-DPG#176* |

### Ordering (phases; one `feat/` branch + rolling PR per repo, merged in phase order)

- **Phase 0 — Contracts (no deploy):** freeze in `signals-search` — (a) Redis ingestion queue name + payload, (b) `vectorize` marker convention, (c) `item_search` DDL + env-var names. Everything depends on these.
- **Phase 1 — Foundations (parallel; gates Phase 2):**
  - automation: `vector` + `postgis` in `00-bootstrap.sh`.
  - Signals-DPG: mirror extensions + `item_search` in authoritative `schema.sql`, re-bundle.
  - Signals-DPG: `vectorize` markers in `examples/schemas/` (AJV `strict:false` → markers pass through harmlessly).
- **Phase 2 — signals-search core (depends on P1 extensions + P0 contracts):** read-model, embedding provider, ingestion worker **with backfill/reconciliation sweep** (reads `items` directly), `POST /v1/search`. **Search becomes functional via backfill without touching the Signals write path.**
- **Phase 3 — Signals-DPG real-time enqueue (depends on P0 contract + P2 consumer):** best-effort `XADD` after create/update/delete (reuse `ioredis`). Additive + best-effort → low blast radius; sweep becomes the backstop.
- **Phase 4 — automation deploy/provision (depends on P2 service):** search subchart, `migrate-job` wiring, secrets, insert into deploy order after `signals`; provision caller key if needed.
- **Phase 5 — Cutover:** backfill ~25k items, verify recall + <1s latency, enable enqueue, point voice bots at `/v1/search`.

**Rationale for order:** extensions before any DDL; contracts before producer/consumer; search ships useful via backfill *before* Signals is touched (lowest risk); the write-path change is a later additive enhancement; deploy wiring trails the service existing.

### Related issues
- `signals-search#1` — implement the search engine (this spec).
- `Signals-DPG#176` — migrate use-case schemas examples → `bluedots-allusecase-schemas`.
- `Signals-DPG#177` — refactor `schema.sql` to separate concerns + run selectively by argument.
- Upstream: `Signals-DPG#169` (plan/estimate), `Signals-DPG#171` (implement search service).
