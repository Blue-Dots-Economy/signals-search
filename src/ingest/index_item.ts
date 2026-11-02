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
  /** `items.updated_at` as an `extract(epoch ...)::text` decimal string, selected
   *  in the same query as the row so it describes the snapshot being indexed.
   *  A `Date` or timestamp string would truncate microseconds (postgres.js
   *  coerces date-shaped strings to `Date`), leaving the marker below
   *  `items.updated_at` so every row stays stale forever. Converted with
   *  `to_timestamp` at the write; never parsed in JS. */
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
  // The hash covers everything the row derives from (model version, text,
  // locations, lifecycle_status), so a location- or lifecycle-only change is
  // re-indexed rather than skipped.
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
    // Nothing derived changed, so skip the embed, but record the checked version
    // or the sweep re-selects this row forever.
    await repo.markSourceVersion(key, item.updated_at_epoch);
    return { action: 'skipped' };
  }
  // TEI rejects an empty input (413), so an item with no vectorizable content is
  // indexed with a NULL vector and stays discoverable by geo/structured filters.
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
    // The version read above, not the write clock, so an update committed during
    // the embed still looks newer than this write.
    sourceUpdatedAtEpoch: item.updated_at_epoch,
  });
  return { action: 'indexed' };
}
