import type { Sql } from 'postgres';
import type { Embedder } from '../embedding/provider.js';
import type { ItemSearchRepo } from '../db/item_search_repo.js';
import type { VectorizeField } from '../config/vectorize_fields.js';
import { indexItem, type SourceItem } from './index_item.js';

export async function runSweep(args: {
  sql: Sql;
  repo: ItemSearchRepo;
  embedder: Embedder;
  fieldsFor: (item_network: string, item_domain: string, item_type: string) => VectorizeField[];
  modelVersion: string;
  batchSize: number;
}): Promise<number> {
  const { sql, repo, embedder, fieldsFor, modelVersion, batchSize } = args;
  const rows = await sql<SourceItem[]>`
    SELECT i.item_network, i.item_domain, i.item_type, i.item_id,
           i.item_state, i.item_locations, i.lifecycle_status
    FROM items i
    LEFT JOIN item_search s USING (item_network, item_domain, item_type, item_id)
    WHERE s.item_id IS NULL OR i.updated_at > s.indexed_at
    ORDER BY i.updated_at ASC
    LIMIT ${batchSize}`;

  let count = 0;
  for (const item of rows) {
    const fields = fieldsFor(item.item_network, item.item_domain, item.item_type);
    await indexItem({ item, fields, embedder, repo, modelVersion });
    count++;
  }
  return count;
}
