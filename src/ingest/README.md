# Ingestion pipeline

Two independent paths keep `item_search` in sync with `items`: a real-time Redis Stream consumer (`stream_consumer.ts` + `../worker/main.ts`) and a periodic reconciliation sweep (`sweep.ts`). Both funnel into the same idempotent write, `index_item.ts`'s `indexItem`.

## The stream path

`ensureConsumerGroup` creates the consumer group at `$` (only new messages), tolerating `BUSYGROUP` (group already exists) as a no-op. `readBatch` uses `XREADGROUP ... BLOCK` for new messages; `reclaimPending` uses `XAUTOCLAIM` to recover messages stranded by a dead consumer — its entries include tombstoned IDs (`fields === null`, meaning the entry was `XDEL`'d from the stream but still pending) which are silently skipped rather than reprocessed.

**Poison-message handling (dead-letter stream).** `parseEvent` Zod-validates the raw stream fields against `ItemEventSchema`; a schema-invalid event (missing/blank field, unknown `op`) yields `event: null` and is parked verbatim to the dead-letter stream (`INGEST_DLQ_STREAM`, default `${INGEST_STREAM}:dlq`) and acked immediately — never processed. A well-formed event that keeps making `indexItem` throw is left unacked to retry, but once its delivery count reaches `INGEST_MAX_DELIVERIES` (default 5, read via `XPENDING`) it too is parked to the DLQ and acked, so no single message loops forever burning embedding calls. The DLQ is bounded (`MAXLEN ~ INGEST_DLQ_MAXLEN`, default 10k) and has no automatic consumer — parked entries carry `_dlq_reason` / `_dlq_source_id` / `_dlq_at` for operator triage. `op` still defaults to `upsert` **only** when absent (legacy producers); a present-but-unknown `op` is rejected rather than silently treated as an upsert.

## The sweep path (`sweep.ts`)

`runSweep` selects rows where `items.updated_at > COALESCE(item_search.source_updated_at, item_search.indexed_at)` (or no `item_search` row exists at all), oldest first, one batch at a time, and calls `indexItem` on each. The comparison is against `source_updated_at` — the `items.updated_at` of the version actually indexed — **not** `indexed_at`, which is stamped when the write happened, i.e. *after* the embed round trip. Comparing against `indexed_at` made the sweep miss any update committed during the embed window permanently: such an update carries an earlier `updated_at` than the stale write that overwrote it (#122). `sweepOrphans` separately deletes any `item_search` row whose `items` row no longer exists (there's no FK/`ON DELETE`, so a hard delete of `items` would otherwise orphan the read-model row forever).

**Per-item isolation.** The loop in `runSweep` wraps each `indexItem` in try/catch and logs+skips a failing item, so one item that throws no longer aborts the batch (which, combined with `ORDER BY i.updated_at ASC`, would otherwise re-select the failing item as the head of every subsequent sweep and block everything behind it). A genuinely-bad item is still retried on each sweep, but in isolation — it no longer starves the rest of the batch.

## `indexItem`'s idempotency — and its real limit

The content-hash check (`getContentHash(key) === hash`) skips re-embedding when nothing has changed — this is what makes stream re-delivery, reclaim, and sweep re-runs all safe to repeat. The hash now covers `modelVersion + serializeItemText(...)` **plus** `item_locations` and `lifecycle_status`, so a location-only or lifecycle-only change produces a different hash and is re-indexed (updating `item_search.geo`/`lifecycle_status` and advancing `indexed_at`). A **skip** still advances `source_updated_at` (`repo.markSourceVersion`) even though it writes nothing else — otherwise a change to any field outside the hash (a private-state edit, a non-vectorized public field) keeps matching the sweep predicate on every tick forever, and because the sweep is `ORDER BY updated_at ASC LIMIT batchSize`, enough such rows sit at the head of every batch and starve newer rows out. Tradeoff: a location/lifecycle-only change re-runs the embedder even though the vectorized text is unchanged; lifecycle/location edits are infrequent per item, so this is accepted for correctness. (A future optimization could store the embedding-text hash separately to reuse the existing vector on such changes.)

Empty vectorizable content (a profile with no vectorized fields filled) is handled deliberately: `indexItem` skips calling the embedder entirely and upserts a `NULL` vector instead, so the item stays geo/structured-filterable without ever hitting TEI's 413-on-empty-string rejection.

## Wiring

`../worker/main.ts` owns the run loop: read a batch, index each event, ack, periodically reclaim pending + run a sweep pass. See root `CLAUDE.md` for the write→index→query architecture this pipeline is half of.
