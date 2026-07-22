import type { Sql } from 'postgres';

/** A fully-qualified item_search row reference (the composite primary key). */
export type RelevanceItemRef = {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
};

/**
 * Cosine similarity between two already-indexed items' stored embeddings.
 *
 * Same score definition as search ranking — `1 - (embedding <=> embedding)`
 * (1 minus pgvector cosine distance) — but computed between two specific rows
 * instead of a query vector and the corpus. Both embeddings are read straight
 * from `item_search`, so there is no embedding call and no write (mirrors the
 * "vectorize at write, rank at read" principle).
 *
 * Returns the raw cosine similarity in [-1, 1], or `null` when either item is
 * absent from `item_search` or has a NULL embedding (nothing to compare).
 */
export async function computeRelevance(
  sql: Sql,
  itemA: RelevanceItemRef,
  itemB: RelevanceItemRef,
): Promise<number | null> {
  const rows = await sql<{ similarity: number | null }[]>`
    SELECT (1 - (a.embedding <=> b.embedding))::float8 AS similarity
    FROM item_search a, item_search b
    WHERE a.item_network = ${itemA.item_network} AND a.item_domain = ${itemA.item_domain}
      AND a.item_type = ${itemA.item_type} AND a.item_id = ${itemA.item_id}
      AND b.item_network = ${itemB.item_network} AND b.item_domain = ${itemB.item_domain}
      AND b.item_type = ${itemB.item_type} AND b.item_id = ${itemB.item_id}
      AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
    LIMIT 1`;
  const sim = rows[0]?.similarity;
  return sim === null || sim === undefined ? null : Number(sim);
}
