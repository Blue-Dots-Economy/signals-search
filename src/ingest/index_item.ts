import type { Embedder } from '../embedding/provider.js';
import type { VectorizeField } from '../config/vectorize_fields.js';
import type { ItemSearchRepo, ItemLocation } from '../db/item_search_repo.js';
import { serializeItemText, contentHash } from './serialize.js';

export type SourceItem = {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  item_state: Record<string, unknown>;
  item_locations: ItemLocation[];
  lifecycle_status: string;
  /** Version marker for the staleness check (#122): `items.updated_at` as an
   *  `extract(epoch ...)::text` decimal string. Must be selected in the SAME query
   *  as the rest of the row, so it describes exactly the snapshot being indexed —
   *  the row can be updated again while the embedder is in flight.
   *
   *  Epoch-numeric, not a `Date` and not a timestamp string, because BOTH lose
   *  microseconds: Postgres keeps µs, a JS `Date` is ms-only, and postgres.js
   *  coerces a timestamp-shaped bound string to a `Date` before sending it. Either
   *  way the marker lands up to 999µs BELOW `items.updated_at`, and then EVERY row
   *  satisfies the sweep predicate on every tick forever. A decimal string is not
   *  date-shaped, so it survives the round trip exactly. Never interpreted here —
   *  read out, handed back, converted with `to_timestamp` at the write. */
  updated_at_epoch: string;
};

export type IndexResult = { action: 'indexed' | 'skipped' };

export async function indexItem(args: {
  item: SourceItem;
  fields: VectorizeField[];
  embedder: Embedder;
  repo: ItemSearchRepo;
  modelVersion: string;
}): Promise<IndexResult> {
  const { item, fields, embedder, repo, modelVersion } = args;
  const text = serializeItemText(item.item_state, fields);
  // The stored hash must cover EVERYTHING the row derives from — not just the
  // vectorized text. Folding locations + lifecycle_status in means a
  // location-only or lifecycle-only change no longer produces the identical hash
  // (which would leave item_search.geo/lifecycle_status stale AND, because a skip
  // never advances indexed_at, make the sweep re-select this row forever).
  const locSig = (item.item_locations ?? [])
    .map((l) => `${l.lat},${l.lng},${l.label ?? ''}`)
    .join('|');
  const hash = contentHash(`${modelVersion}\n${text}\nloc:${locSig}\nlifecycle:${item.lifecycle_status}`);
  const key = {
    item_network: item.item_network,
    item_domain: item.item_domain,
    item_type: item.item_type,
    item_id: item.item_id,
  };
  if ((await repo.getContentHash(key)) === hash) {
    // Nothing the read model derives from changed, so don't re-embed — but the
    // source row did move on, so record the version we just checked or the sweep
    // re-selects this row forever (#122).
    await repo.markSourceVersion(key, item.updated_at_epoch);
    return { action: 'skipped' };
  }
  // No vectorizable content (e.g. a profile that hasn't filled any vectorized
  // field). Don't call the embedder with an empty string — TEI rejects it (413)
  // and one such item would fail the whole sweep. Index geo-only with a NULL
  // vector so the item stays discoverable by geo/structured filters.
  const embedding = text === '' ? null : (await embedder.embed([text]))[0];
  await repo.upsert({
    item_network: item.item_network,
    item_domain: item.item_domain,
    item_type: item.item_type,
    item_id: item.item_id,
    embedding,
    locations: item.item_locations ?? [],
    lifecycleStatus: item.lifecycle_status,
    modelVersion,
    contentHash: hash,
    // The version READ above, not the write clock: an update committed while the
    // embedder was in flight must still look newer than this write (#122).
    sourceUpdatedAtEpoch: item.updated_at_epoch,
  });
  return { action: 'indexed' };
}
