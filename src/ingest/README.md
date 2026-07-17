# Ingestion pipeline

Two independent paths keep `item_search` in sync with `items`: a real-time Redis Stream consumer (`stream_consumer.ts` + `../worker/main.ts`) and a periodic reconciliation sweep (`sweep.ts`). Both funnel into the same idempotent write, `index_item.ts`'s `indexItem`.

## The stream path

`ensureConsumerGroup` creates the consumer group at `$` (only new messages), tolerating `BUSYGROUP` (group already exists) as a no-op. `readBatch` uses `XREADGROUP ... BLOCK` for new messages; `reclaimPending` uses `XAUTOCLAIM` to recover messages stranded by a dead consumer — its entries include tombstoned IDs (`fields === null`, meaning the entry was `XDEL`'d from the stream but still pending) which are silently skipped rather than reprocessed.

**Known gap: no poison-message handling.** `fieldsToEvent` does no validation on the raw stream fields — a malformed event (missing/wrong-typed field) still gets processed as a well-formed `ItemEvent` with `undefined` values. There is no delivery-count check and no dead-letter stream: a message that reliably makes `indexItem` throw is never acked, so `reclaimPending` keeps recovering it and the same failure repeats forever, burning an embedding call each time. If you're debugging "why does ingestion seem stuck," check for a poison message before assuming a config problem — this failure mode has no built-in escape.

## The sweep path (`sweep.ts`)

`runSweep` selects rows where `items.updated_at > item_search.indexed_at` (or no `item_search` row exists at all), oldest first, one batch at a time, and calls `indexItem` on each. `sweepOrphans` separately deletes any `item_search` row whose `items` row no longer exists (there's no FK/`ON DELETE`, so a hard delete of `items` would otherwise orphan the read-model row forever).

**Known gap: no per-item isolation.** The loop in `runSweep` has no try/catch around `indexItem` — one item that throws aborts the whole batch. Combined with `ORDER BY i.updated_at ASC`, an item that reliably fails to index will be re-selected as the head of every subsequent sweep, permanently blocking every item behind it from ever being reached.

## `indexItem`'s idempotency — and its real limit

The content-hash check (`getContentHash(key) === hash`) skips re-embedding when nothing vectorizable has changed — this is what makes stream re-delivery, reclaim, and sweep re-runs all safe to repeat. But **the hash only covers `modelVersion + serializeItemText(...)`** (the vectorized fields) — it does not cover `item_locations` or `lifecycle_status`. A change to either, with no accompanying change to a vectorized field, produces the identical hash and gets skipped: `item_search.locations`/`lifecycle_status` go stale, **and** because a skip never calls `repo.upsert` (which is what advances `indexed_at`), the sweep's own `WHERE i.updated_at > s.indexed_at` predicate keeps re-matching the same row on every future sweep — this is the same head-of-batch starvation risk as the per-item isolation gap above, from a different cause.

Empty vectorizable content (a profile with no vectorized fields filled) is handled deliberately: `indexItem` skips calling the embedder entirely and upserts a `NULL` vector instead, so the item stays geo/structured-filterable without ever hitting TEI's 413-on-empty-string rejection.

## Wiring

`../worker/main.ts` owns the run loop: read a batch, index each event, ack, periodically reclaim pending + run a sweep pass. See root `CLAUDE.md` for the write→index→query architecture this pipeline is half of.
