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
  const hash = contentHash(`${modelVersion}\n${text}`);
  const key = {
    item_network: item.item_network,
    item_domain: item.item_domain,
    item_type: item.item_type,
    item_id: item.item_id,
  };
  if ((await repo.getContentHash(key)) === hash) {
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
  });
  return { action: 'indexed' };
}
