import type { Sql } from 'postgres';

/** A fully-qualified item_search row reference (the composite primary key). */
export type RelevanceItemRef = {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
};

/**
 * Outcome of a pairwise relevance computation:
 *  - `ok`             both items are live and indexed with embeddings from the
 *                     SAME model version → `similarity` is their cosine
 *                     similarity in [-1, 1].
 *  - `not_found`      at least one item is absent, not `live`, or has a NULL
 *                     embedding (nothing to compare).
 *  - `not_comparable` both items are live + embedded but from DIFFERENT model
 *                     versions, so their vectors live in different spaces and
 *                     cosine is meaningless (e.g. mid re-embed / model migration).
 */
export type RelevanceOutcome =
  | { status: 'ok'; similarity: number }
  | { status: 'not_found' }
  | { status: 'not_comparable' };

/**
 * Cosine similarity between two already-indexed items' stored embeddings.
 *
 * Same score definition as search ranking — `1 - (embedding <=> embedding)`
 * (1 minus pgvector cosine distance) — but computed between two specific rows
 * instead of a query vector and the corpus. Both embeddings are read straight
 * from `item_search`, so there is no embedding call and no write (mirrors the
 * "vectorize at write, rank at read" principle).
 *
 * Scoped to `lifecycle_status = 'live'` on both sides (parity with /v1/search,
 * so non-live draft/paused/archived rows are never revealed). Guards on
 * `model_version`: vectors from different embedding models are reported as
 * `not_comparable` rather than silently producing a meaningless number.
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
