# Design: `/v1/search/flat` — Raya-tool compatible flattened search wrapper

- **Issue:** [signals-search#33](https://github.com/Blue-Dots-Economy/signals-search/issues/33) — "Multi-level nesting not supported"
- **Blocks:** [signals-dpg#160](https://github.com/Blue-Dots-Economy/signals-dpg/issues/160) (UP Blue Dots prod launch + voice bot)
- **Companion:** [signals-dpg#293 action/perform single-object body](https://github.com/Blue-Dots-Economy/signals-dpg/issues/293) — same Raya root cause, separate spec in that repo.
- **Date:** 2026-07-14

## Problem

`POST /v1/search` takes a deeply nested body — `{ context, message: { intent, pagination } }` — up to 5 levels deep (`message.intent.spatial[].geometry.coordinates`), with `intent.spatial` and `intent.filters` being **arrays of objects**. Raya (Litwiz) LLM tools can't produce this shape, so the voice bot can't call search.

We want to keep the canonical nested contract exactly as-is (it is the right long-term design and is reused by every non-voice consumer) and add a **dedicated flat wrapper** that Raya can drive, **without dropping any search functionality**.

### Raya constraint (root cause, shared with #293)

Per [Raya LLM-tools docs](https://docs.litwizlabs.com/documentation/agents-llm-tools):
- `function.parameters` (LLM-filled args): nested objects **one level deep only**; arrays must contain **primitives only**.
- `api_details.payload_template` (the HTTP body Raya sends): must be a JSON object; may nest, but `{{param}}` placeholders inject values as **strings**.

The practical consequence: Raya sends a **flat object of string values**. Our wrapper must rebuild the nested, correctly-typed canonical request from that.

## Decision

Add `POST /v1/search/flat`. The canonical `POST /v1/search` is **unchanged** (strictly nested).

The flat body is an object whose keys are **dot-delimited canonical paths**; a **numeric path segment denotes an array index**. Every value may be sent as a string; the wrapper restores real types by JSON-parsing each leaf.

```json
{
  "context.networkId": "blue_dot",
  "context.domain": "seeker",
  "context.itemType": "profile_1.0",
  "context.messageId": "abc-123",
  "message.intent.textSearch": "plumber",
  "message.intent.filters.0.op": "eq",
  "message.intent.filters.0.target": "item_state.trade",
  "message.intent.filters.0.value": "plumber",
  "message.intent.spatial.0.op": "s_dwithin",
  "message.intent.spatial.0.geometry.type": "Point",
  "message.intent.spatial.0.geometry.coordinates.0": "77.59",
  "message.intent.spatial.0.geometry.coordinates.1": "12.97",
  "message.intent.spatial.0.distanceMeters": "5000",
  "message.pagination.limit": "20"
}
```

This preserves **all** search modes — free-text, anchor (`message.intent.item.id`), simple geo (single spatial clause), and arbitrary-length filters — since arrays are expressible via indexed keys.

## Design

### Pipeline (`POST /v1/search/flat`)

1. **Unflatten** the flat object → nested object/array structure:
   - split each key on `.`; a segment that is a non-negative integer creates/extends an array at that position, otherwise an object key.
   - **JSON-parse each leaf value**; on parse failure keep the raw string. So `"20" → 20`, `"true" → true`, `"[\"a\",\"b\"]" → ["a","b"]`, `"plumber" → "plumber"`.
2. **Validate** the result with the **existing `SearchRequestSchema`** (`src/api/schemas.ts`) — no schema fork. Zod `.default()`s still apply (e.g. omit `message.pagination` → `{limit:20, offset:0}`; omit `context.version` → `"1.0.0"`).
3. **Execute** via the shared search core (below). Same responses, cache, rerank, and error mapping as `/v1/search`.

### Refactor for isolation

- Extract the search execution currently inline in `src/api/search_route.ts` into a shared `runSearch(validated: SearchRequest, deps)` used by **both** `/v1/search` and `/v1/search/flat` after each obtains a validated `SearchRequest`. Keeps one execution path; the routes differ only in how they parse the body.
- New utility `src/api/unflatten.ts`: dot-path unflatten with numeric-index arrays + per-leaf JSON parse. No external dependency. Pure, unit-testable.

### Validation errors

Malformed flat input (e.g. a leaf that unflattens to the wrong type, or a missing required field like `context.messageId`) surfaces as the same `400 VALIDATION_ERROR` the canonical route returns from `SearchRequestSchema`, after unflattening.

### OpenAPI / docs

Document `/v1/search/flat` with worked flat examples for each mode (free-text, anchor, geo, filters, combined) so a non-developer can configure the Raya tool by copy-paste. Mirror into `local_docs/signals-search-openapi.yaml`, the voice Postman collections, and `local_docs/voice_bot_integration.md`.

## Documented edge case

JSON-parsing leaves means a **numeric-looking string filter value** (e.g. a pincode `"560001"`) becomes the number `560001`. `filters[].value` is `z.unknown()`, so this passes validation but changes the compared type. Callers needing it kept as a string must encode accordingly (e.g. send a JSON-quoted string `"\"560001\""`, which parses back to the string). This will be called out in the flat-route docs.

## Affected consumers

No programmatic callers exist — only Postman collections and docs consume `/v1/search`. The canonical route is untouched, so existing consumers are unaffected. New flat examples are added to docs/Postman for the voice bot.

## Testing

- `src/api/unflatten.test.ts`: dot-paths, numeric-index arrays, nested arrays (`filters.0.value.1`), JSON-parse coercion (number/bool/array), string fallback, empty input.
- `src/api/search_route.test.ts` (or a new `search_flat_route.test.ts`): `app.inject` against `/v1/search/flat` for each mode; assert it produces identical results to the equivalent nested `/v1/search` call; assert `400` on missing `context.messageId` and on malformed types.
- Existing canonical tests remain unchanged (route untouched) — proves no regression.

## Out of scope

- No change to the canonical `/v1/search` contract, ranking, cache, or rerank path.
- The action-side Raya fix (#293) is a separate spec in signals-dpg.
