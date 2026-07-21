---
paths:
  - "src/api/**"
  - "src/ingest/**"
  - "src/config/**"
---

# PII safety and interaction-matrix authorization

Two invariants that span the ingest and query sides — get either wrong and it's a data leak, not a bug.

## PII safety (never vectorize private data)

`network_registry.vectorizeFields` (`src/config/vectorize_fields.ts`) **throws** if a configured vectorize field is marked `private: true` in the schema — a private field cannot be embedded, full stop, not silently skipped. `item_private_state` is never read anywhere in the ingest path (`serialize.ts` only ever sees `item_state`, the public/masked view). Query results likewise return the masked `item_state` from `items`, never the private one. If you're adding a new vectorized field or a new response field, confirm it comes from the public state, not the private one — there is no runtime guard on the read/response side, only the write-side throw above.

## Interaction matrix = authorization

Cross-domain scope for anchor search comes from `network.json`'s `actions[*].interactions[*]`, exposed as `registry.isInteractionAllowed(network, fromDomain, toDomain)`. The anchor path (`search_route.ts`) enforces `anchorDomain → contextDomain` through this check and returns `403` if not allowed — this is the actual authorization boundary for "can domain A see domain B's items via an anchor," not anything in the auth/API-key layer. Free-text and geo-only requests (no anchor) are scoped by served-domain only — there's no interaction-matrix check to bypass because there's no anchor source domain to check against. If you're adding a new search mode that reads another item as context (like the anchor path does), it needs the same `isInteractionAllowed` check — don't assume served-domain scoping alone is sufficient once a second item enters the picture.
