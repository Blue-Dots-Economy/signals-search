# Relevance Scoring Endpoint (`POST /v1/relevance`)

**Date:** 2026-07-22
**Status:** Design — awaiting implementation plan
**Repo:** signals-search
**Issue:** Blue-Dots-Economy/signals-search#49
**Companion:** Signals-DPG cutover — Blue-Dots-Economy/signals-dpg#350 (migrate `@dpg/match_score` from dpg-scoring to this endpoint)

## 1. Problem

Signals-DPG computes a compatibility score between two item profiles by calling the
external **dpg-scoring** service (`POST /api/v1/scores/match`), which runs an LLM
(Gemini/OpenAI) over the two item bodies and returns a narrative score
(`score` 0–10, `band`, `confidence`, `reasoning`, `signals[]`).

Since then, **signals-search** was built. It already vectorises every live item's
public `vectorize` fields into an L2-normalised 1024-d BGE-M3 embedding stored in
`item_search.embedding`, and ranks by cosine similarity at query time. The one thing
it does **not** expose is a **1:1 (or 1:N) relevance score between two specific
items** — the primitive needed to replace the LLM call with a cheap, deterministic
vector computation.

This spec designs that endpoint. The LLM is replaced by cosine similarity over the
embeddings both items already have. No embedding calls happen at request time.

### Non-goals

- Cross-encoder (`bge-reranker-v2-m3`) rerank mode for a sharper pairwise score —
  tracked as a **separate future issue**. The reranker is not deployed today (cluster
  resource constraints) and currently discards raw scores.
- Result caching — v1 is deterministic and cheap (stored-vector cosine), so no cache.
- Cross-network scoring — a request is scoped to a single network.
- Reproducing the LLM narrative (`reasoning`, `signals`, `confidence`) — a vector
  score cannot produce these; they are deliberately dropped (see §7).

## 2. Endpoint

`POST /v1/relevance`

- Auth: `x-api-key` via the existing `requireApiKey` preHandler (same as `/v1/search`).
- New route file `src/api/relevance_route.ts`, registered from `src/api/server.ts`
  inside the deferred plugin alongside `registerSearchRoute`, reusing `ApiDeps`
  (`sql`, `registry`, `embeddingDim`, …). The `embedder` dependency is **not** used.
- Zod schemas added to `src/api/schemas.ts`, following the `fastify-type-provider-zod`
  pattern used by the search route (`body` + `response` map for 200/400/401/403/422).

### Semantics

Score one **source** item against one **or many** **target** items using the cosine
similarity of their stored embeddings. An array of one target is the 1:1 case; a
larger array is bulk fan-out.

## 3. Request

Beckn-aligned envelope, consistent with `/v1/search`:

```jsonc
{
  "context": {
    "version": "1.0.0",
    "messageId": "<uuid>",
    "timestamp": "2026-07-22T10:00:00Z",   // optional
    "networkId": "blue_dot"
  },
  "message": {
    "source":  { "id": "<uuid>" },
    "targets": [ { "id": "<uuid>" }, { "id": "<uuid>" } ]
  }
}
```

- `context.networkId` — required; scopes the lookup. One network per request.
- `message.source.id` — the anchor item's `item_id` (global UUID).
- `message.targets` — 1..`RELEVANCE_MAX_TARGETS` (new env, default `100`) references.
  Empty array → `400 VALIDATION_ERROR`. Over the cap → `422`.
- References carry only `id`. `item_id` is a globally-unique UUID, so
  `WHERE item_network = $networkId AND item_id = $id` resolves at most one
  `item_search` row, from which `item_domain`, `item_type`, `model_version`,
  `embedding`, `indexed_at`, and `lifecycle_status` are read.
- Duplicate target ids are allowed; each is echoed in its requested position.

## 4. Computation

Single SQL round-trip (postgres.js parameterised `sql`), in `src/db/relevance_query.ts`:

1. Load the source row by `(networkId, source.id)` where `lifecycle_status = 'live'`.
   - Missing / not live → whole request fails `404`.
   - Row exists but `embedding IS NULL` → whole request fails `422` (nothing to
     score against; source is not indexed yet).
2. Load all target rows in one query: `item_network = $networkId
   AND item_id = ANY($targetIds) AND lifecycle_status = 'live'`, selecting
   `item_id, item_domain, item_type, model_version, indexed_at`, and the cosine
   score `(1 - (embedding <=> $sourceEmbedding::vector))::float8` (the same primitive
   as `search_query.ts`), plus whether `embedding IS NULL`.
3. In application code, reassemble one result per **requested** target id, preserving
   request order (see §5), assigning each a status (§6).

Because BGE-M3 vectors are L2-normalised, cosine similarity equals the dot product;
score is effectively in `[0, 1]` for related content. Score is rounded to **4
decimals**, matching the search route.

## 5. Response

Native vector-relevance contract. **One row per requested target, in request order**
— `results[i]` corresponds to `targets[i]`. This gives callers a deterministic 1:1
mapping to what they sent; a caller that wants a ranking sorts by `score` itself.

```jsonc
{
  "context": {
    "version": "1.0.0",
    "messageId": "<uuid>",
    "timestamp": "2026-07-22T10:00:01Z",
    "networkId": "blue_dot"
  },
  "message": {
    "source": {
      "id": "<uuid>", "domain": "seeker", "type": "profile_1.0",
      "model_version": "bge-m3", "indexed_at": "2026-07-20T…"
    },
    "results": [
      { "id": "<uuid>", "domain": "provider", "type": "profile_1.0",
        "status": "scored", "score": 0.8734, "band": "high",
        "model_version": "bge-m3", "indexed_at": "2026-07-21T…" },
      { "id": "<uuid>", "status": "not_indexed",    "score": null },
      { "id": "<uuid>", "status": "not_found",      "score": null },
      { "id": "<uuid>", "status": "not_allowed",    "score": null },
      { "id": "<uuid>", "status": "not_comparable", "score": null }
    ],
    "meta": {
      "total": 5, "scored": 1,
      "method": "cosine", "model": "bge-m3"
    }
  }
}
```

- `meta.total` = number of requested targets; `meta.scored` = count with
  `status = "scored"`. `meta.method` is always `"cosine"` in v1. `meta.model` is the
  source's `model_version`.

## 6. Per-target status

| status | meaning | score |
| --- | --- | --- |
| `scored` | row live, embedding present, model matches source, interaction allowed | cosine, 4 dp |
| `not_found` | no live `item_search` row for `(networkId, id)` | `null` |
| `not_indexed` | row exists but `embedding IS NULL` | `null` |
| `not_allowed` | `registry.isInteractionAllowed(networkId, source.domain, target.domain)` is `false` | `null` |
| `not_comparable` | target `model_version` ≠ source `model_version` (cosine across models is meaningless) | `null` |

Precedence when multiple apply: `not_found` → `not_allowed` → `not_indexed` →
`not_comparable` → `scored`. (Authorization is decided before revealing index state.)

> Authz note (`.claude/rules/pii-and-authz.md`): because this endpoint reads a second
> item as context, it MUST apply `registry.isInteractionAllowed` for every
> source→target pair, exactly as the anchor-search path does. Served-domain scoping
> alone is insufficient once two items are involved. Only public `item_state` is ever
> vectorised; `item_private_state` is never touched.

### `band`

Derived from cosine via configurable thresholds, **provisional / needs calibration**:

- `RELEVANCE_BAND_HIGH` (env, default `0.75`) → `high`
- `RELEVANCE_BAND_MEDIUM` (env, default `0.50`) → `medium`
- below → `low`

Raw BGE-M3 cosine is not on the same scale as dpg-scoring's 0–10, so these defaults
are a starting point to be tuned against real data. `band` is advisory; consumers that
need a hard cutoff should threshold on `score`.

## 7. Contract differences vs dpg-scoring

| dpg-scoring field | new endpoint | rationale |
| --- | --- | --- |
| `score` (0–10) | `score` (cosine, ~0–1, 4 dp) | different scale; document clearly |
| `band` (low/med/high) | `band` (config thresholds) | preserved, recalibrated |
| `confidence` | — dropped | no probabilistic model behind cosine |
| `reasoning` | — dropped | LLM narrative; not derivable from a vector |
| `signals[]` | — dropped | LLM narrative |
| `provider`/`model` | `meta.method`, `meta.model` | method=`cosine`, model=embedding version |
| single pair | 1:N `targets[]` | bulk fan-out from one call |

Adapting this native shape into Signals-DPG's existing internal `MatchScore` shape is
the responsibility of the companion Signals-DPG spec (a new `signals_search` provider
with an adapter).

## 8. Config (new env)

| var | default | purpose |
| --- | --- | --- |
| `RELEVANCE_MAX_TARGETS` | `100` | max `targets[]` per request |
| `RELEVANCE_BAND_HIGH` | `0.75` | cosine ≥ → `high` |
| `RELEVANCE_BAND_MEDIUM` | `0.50` | cosine ≥ → `medium` |

Validated in `src/config.ts` (`EnvSchema` / `loadConfig`), threaded into `ApiDeps`.

## 9. Testing

- Unit: status derivation (all five statuses + precedence), band thresholds, request-
  order preservation, cap enforcement, empty-targets rejection.
- SQL/integration (Testcontainers, per repo convention): seed `item_search` rows with
  known embeddings; assert cosine values, `not_indexed` (null embedding),
  `not_comparable` (differing `model_version`), and `lifecycle_status` scoping.
- Authz: interaction-matrix `not_allowed` path.
- Route: `x-api-key` required (401), Zod validation (400/422), success shape (200).

## 10. Rollout / dependencies

1. Ship this endpoint (feature-flagged only by its own env; no behaviour change until
   a caller uses it).
2. Signals-DPG adds a `signals_search` provider behind `MATCH_SCORE_PROVIDER`, keeping
   `dpg_scoring` as the default/fallback (companion spec). Cutover is a config flip.
3. Follow-up issue: cross-encoder rerank mode (`method: "rerank"`), gated on the
   reranker being deployed.
