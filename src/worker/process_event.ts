import type { Sql } from 'postgres';
import type { Embedder } from '../embedding/provider.js';
import type { ItemSearchRepo } from '../db/item_search_repo.js';
import type { VectorizeField } from '../config/vectorize_fields.js';
import type { ItemEvent } from '../ingest/stream_consumer.js';
import { indexItem, type SourceItem } from '../ingest/index_item.js';

export async function processEvent(args: {
  event: ItemEvent;
  sql: Sql;
  repo: ItemSearchRepo;
  embedder: Embedder;
  fieldsFor: (n: string, d: string, t: string) => VectorizeField[];
  modelVersion: string;
}): Promise<void> {
  const { event, sql, repo, embedder, fieldsFor, modelVersion } = args;
  if (event.op === 'delete') {
    await repo.delete(event.item_id);
    return;
  }
  const rows = await sql<SourceItem[]>`
    SELECT item_network, item_domain, item_type, item_id, item_state, item_locations, lifecycle_status
    FROM items
    WHERE item_network = ${event.item_network} AND item_domain = ${event.item_domain}
      AND item_type = ${event.item_type} AND item_id = ${event.item_id}
    LIMIT 1`;
  if (rows.length === 0) return;
  const item = rows[0];
  const fields = fieldsFor(item.item_network, item.item_domain, item.item_type);
  await indexItem({ item, fields, embedder, repo, modelVersion });
}
