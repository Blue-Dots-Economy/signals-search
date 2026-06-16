# Signals Search Engine — V1 Tech Architecture

**Companion to:** `2026-06-09-signals-search-engine-design.md`
**Date:** 2026-06-09

A quick visual + narrative overview. See the design spec for decision rationale, data model, and scale analysis.

---

## 1. One-line summary

A new **`signals-search`** service (TS/Fastify) keeps a **pgvector + PostGIS index** (`item_search`) in sync with the Signals `items` table — fed by a best-effort enqueue from the Signals write path — and serves an authenticated, ranked **`POST /v1/search`** combining vector similarity, geospatial, and structured filters, cached in Redis.

---

## 2. Component diagram

```mermaid
flowchart LR
  VB["Voice bots /<br/>Aggregators"]

  subgraph SignalsDPG["Signals-DPG (existing)"]
    WP["Item write path<br/>create / update / delete"]
    NJ["network.json<br/>schemas + vectorize markers<br/>+ interaction matrix"]
  end

  subgraph SearchSvc["signals-search (NEW repo · TS/Fastify)"]
    API["Search API<br/>POST /v1/search"]
    WRK["Ingestion worker<br/>+ reconciliation sweep"]
    EMB["Embedding provider<br/>pluggable · hosted default"]
  end

  subgraph Redis["Shared Redis"]
    Q["ingestion queue"]
    CA["result + embedding cache"]
  end

  subgraph PG["Shared Postgres · Signals DB"]
    IT[("items<br/>masked item_state · item_locations")]
    AK[("apikey / org<br/>better-auth")]
    IS[("item_search<br/>vector(D) + geography<br/>pgvector + PostGIS")]
  end

  VB -->|x-api-key| API
  WP -->|enqueue item_key after commit| Q
  Q --> WRK
  WRK -->|read public state + locations| IT
  WRK -->|embed text| EMB
  WRK -->|upsert vector + geo| IS
  WRK -. reconcile updated_at .-> IT
  API -->|validate target| NJ
  API -->|verify key to org| AK
  API -->|filter + ANN rank| IS
  API -->|join masked state| IT
  API <-->|cache| CA
  API -->|embed query text| EMB
```

---

## 3. Ingestion flow (write side — vectorize at write, async)

```mermaid
sequenceDiagram
  participant S as Signals write path
  participant R as Redis queue
  participant W as Ingestion worker
  participant DB as items
  participant E as Embedding provider
  participant V as item_search

  S->>DB: write item (commit)
  S-->>R: enqueue {item_key, op} (best-effort, .catch warn)
  R->>W: deliver job
  W->>DB: read public attrs + item_locations
  W->>W: serialize configured public fields → content_hash
  alt content_hash unchanged
    W-->>V: skip re-embed
  else changed
    W->>E: embed(text)
    E-->>W: vector (L2-normalized)
    W->>V: upsert vector + geography + model_version + indexed_at
  end
  Note over W,DB: Reconciliation sweep re-indexes where items.updated_at > item_search.indexed_at<br/>(self-heals drops · initial backfill · model/config re-index)
```

---

## 4. Query flow (read side — embed query, filter-then-rank)

```mermaid
sequenceDiagram
  participant C as Voice bot
  participant A as Search API
  participant AK as Signals apikey
  participant NJ as network.json
  participant E as Embedding provider
  participant V as item_search (pgvector+PostGIS)
  participant IT as items

  C->>A: POST /v1/search (x-api-key)<br/>context{networkId,domain,itemType} + message.intent{textSearch,item,spatial,filters} + pagination
  A->>AK: verify key → caller org
  A->>NJ: validate context (network/domain/itemType) vs interaction matrix
  alt intent.item.id
    A->>V: read stored vector (NO embedding call → fast path)
  else intent.textSearch
    A->>E: embed(query text) [Redis-cached by text hash]
    E-->>A: query vector
  end
  A->>V: WHERE live + filters[] + ST_DWithin(geo,$pt,$distanceMeters)<br/>ORDER BY embedding <=> $qvec LIMIT/OFFSET (pagination)
  V-->>A: ranked item keys + nearest distance
  A->>IT: join → masked item_state
  A-->>C: context + message.items[] + meta (response cached ~30–60s)
```

---

## 5. Latency at a glance

| Path | Embedding call? | Typical latency |
|---|---|---|
| `anchor.item_id` ("relevant to me") | No (stored vector) | < 30 ms (in-DB) |
| `anchor.text` ("relevant to X") | Yes (cached on repeat) | ~100–400 ms embed + < 30 ms search |
| `near` only ("matches near me") | No | < 30 ms (PostGIS) |

The external embedding hop is the only thing near the budget; ANN + geo are single-digit-to-low-tens of ms at ≤100k rows. Well within the < 1 s target.

---

## 6. What changes where

| Repo | Change |
|---|---|
| **signals-search** (new) | Ingestion worker, Search API, embedding-provider abstraction, `item_search` migration |
| **Signals-DPG** (existing) | Best-effort enqueue in item write/delete path; `vectorize` markers in `network.json`; enable `vector` + `postgis` extensions |
| **Shared Postgres** | New `item_search` table (partitioned by network/domain); pgvector + PostGIS enabled |
| **Shared Redis** | Ingestion queue + result/embedding cache |

---

## 7. Boundaries (single-purpose units)

- **Embedding provider** — `embed(texts) → vectors`; swap hosted/local by config. Knows nothing about Postgres or HTTP.
- **Ingestion worker** — owns "an item changed → its `item_search` row is correct". Idempotent via `content_hash`; self-healing via reconciliation.
- **Search API** — owns "a query → ranked, authorized, masked results". Stateless; all index work pushed into Postgres.
- **`item_search` table** — the index; the only shared contract between worker and API.
- Future **NFH catalog source** can replace the Signals enqueue behind the same `item_search` contract without touching the API.
