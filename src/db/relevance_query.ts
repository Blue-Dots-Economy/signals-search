import type { Sql } from 'postgres';

export type RelevanceItemRef = {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
};

/**
 * `ok.similarity` is cosine similarity in [-1, 1]. `not_found`: an item is
 * absent, not live, or has a NULL embedding. `not_comparable`: the two
 * `model_version`s differ, so cosine between them is meaningless.
 */
export type RelevanceOutcome =
  | { status: 'ok'; similarity: number }
  | { status: 'not_found' }
  | { status: 'not_comparable' };

/**
 * Cosine similarity between two indexed items' stored embeddings, with the same
 * score definition as search ranking. No embedding call and no write. Live rows
 * only on both sides, so non-live items are never revealed.
 */
export async function computeRelevance(
  sql: Sql,
  itemA: RelevanceItemRef,
  itemB: RelevanceItemRef,
): Promise<RelevanceOutcome> {
  const rows = await sql<{ a_model: string; b_model: string; similarity: number }[]>`
    SELECT a.model_version AS a_model, b.model_version AS b_model,
           (1 - (a.embedding <=> b.embedding))::float8 AS similarity
    FROM item_search a, item_search b
    WHERE a.item_network = ${itemA.item_network} AND a.item_domain = ${itemA.item_domain}
      AND a.item_type = ${itemA.item_type} AND a.item_id = ${itemA.item_id}
      AND b.item_network = ${itemB.item_network} AND b.item_domain = ${itemB.item_domain}
      AND b.item_type = ${itemB.item_type} AND b.item_id = ${itemB.item_id}
      AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
      AND a.lifecycle_status = 'live' AND b.lifecycle_status = 'live'
    LIMIT 1`;

  const row = rows[0];
  if (!row) return { status: 'not_found' };
  if (row.a_model !== row.b_model) return { status: 'not_comparable' };
  return { status: 'ok', similarity: Number(row.similarity) };
}
