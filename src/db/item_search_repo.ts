import type { Sql } from 'postgres';

/** Fixed embedding dimension of the item_search.embedding column (vector(1024)).
 *  Changing the embedding model's output dim requires a new migration. */
export const ITEM_SEARCH_VECTOR_DIM = 1024;

export type ItemLocation = { lat: number; lng: number; label?: string };

/** The full composite primary key of item_search.
 *  item_id alone is a globally-unique UUID today, but reads/deletes key on the
 *  whole PK for index usage and consistency with the table definition. */
export type ItemKey = {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
};

export type UpsertInput = ItemKey & {
  /** null when the item has no vectorizable content; stored as a NULL vector
   *  (the column is nullable). Such rows stay discoverable via geo/structured
   *  filters and recency, and search_query ranks them last (NULLS LAST) for
   *  vector queries. */
  embedding: number[] | null;
  locations: ItemLocation[];
  lifecycleStatus: string;
  modelVersion: string;
  contentHash: string;
  /** `items.updated_at` of the row version this write describes (#122) — the
   *  value READ with the row, never `now()`. The sweep compares it against the
   *  live `items.updated_at`, so stamping the write clock instead would record a
   *  pre-embed snapshot as if it were current and permanently hide any update
   *  that landed during the embed.
   *
   *  An `extract(epoch ...)::text` decimal string rather than a `Date` or a
   *  timestamp string — see `SourceItem.updated_at_epoch` for why both of those
   *  silently truncate to milliseconds and break the comparison. */
  sourceUpdatedAtEpoch: string;
};

function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

function toMultipointWkt(locs: ItemLocation[]): string | null {
  if (locs.length === 0) return null;
  const pts = locs.map((l) => `${l.lng} ${l.lat}`).join(',');
  return `MULTIPOINT(${pts})`;
}

export class ItemSearchRepo {
  constructor(private readonly sql: Sql, private readonly dim: number) {}

  async upsert(input: UpsertInput): Promise<void> {
    if (input.embedding !== null && input.embedding.length !== this.dim) {
      throw new Error(`embedding dim ${input.embedding.length} != ${this.dim}`);
    }
    const vec = input.embedding === null ? null : toVectorLiteral(input.embedding);
    const wkt = toMultipointWkt(input.locations);
    await this.sql`
      INSERT INTO item_search
        (item_network, item_domain, item_type, item_id, embedding, geo, lifecycle_status, model_version, content_hash, indexed_at, source_updated_at)
      VALUES (
        ${input.item_network}, ${input.item_domain}, ${input.item_type}, ${input.item_id},
        ${vec === null ? this.sql`NULL` : this.sql`${vec}::vector`},
        ${wkt ? this.sql`ST_SetSRID(ST_GeomFromText(${wkt}), 4326)::geography` : this.sql`NULL`},
        ${input.lifecycleStatus}, ${input.modelVersion}, ${input.contentHash}, now(), to_timestamp(${input.sourceUpdatedAtEpoch}::numeric)
      )
      ON CONFLICT (item_network, item_domain, item_type, item_id) DO UPDATE SET
        embedding = EXCLUDED.embedding,
        geo = EXCLUDED.geo,
        lifecycle_status = EXCLUDED.lifecycle_status,
        model_version = EXCLUDED.model_version,
        content_hash = EXCLUDED.content_hash,
        indexed_at = now(),
        source_updated_at = EXCLUDED.source_updated_at`;
  }

  /** Advance the indexed-version marker without rewriting the row (#122).
   *
   *  For the skip path: the content hash proved nothing the read model derives
   *  from has changed, but the source row HAS moved on, so the marker must catch
   *  up. Without this a change to any field outside the hash (a private-state
   *  edit, a non-vectorized public field) keeps matching the sweep predicate on
   *  every tick forever — and since the sweep orders by `updated_at ASC` and
   *  takes a bounded batch, enough such rows starve newer ones out entirely.
   *
   *  A no-op when the row is absent, which is correct: no row means the caller
   *  did not take the skip path. */
  async markSourceVersion(key: ItemKey, sourceUpdatedAtEpoch: string): Promise<void> {
    await this.sql`
      UPDATE item_search SET source_updated_at = to_timestamp(${sourceUpdatedAtEpoch}::numeric)
      WHERE item_network = ${key.item_network} AND item_domain = ${key.item_domain}
        AND item_type = ${key.item_type} AND item_id = ${key.item_id}`;
  }

  async getContentHash(key: ItemKey): Promise<string | null> {
    const rows = await this.sql<{ content_hash: string | null }[]>`
      SELECT content_hash FROM item_search
      WHERE item_network = ${key.item_network} AND item_domain = ${key.item_domain}
        AND item_type = ${key.item_type} AND item_id = ${key.item_id}
      LIMIT 1`;
    return rows[0]?.content_hash ?? null;
  }

  async delete(key: ItemKey): Promise<void> {
    await this.sql`
      DELETE FROM item_search
      WHERE item_network = ${key.item_network} AND item_domain = ${key.item_domain}
        AND item_type = ${key.item_type} AND item_id = ${key.item_id}`;
  }
}
