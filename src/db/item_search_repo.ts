import type { Sql } from 'postgres';

/** Dimension of the item_search.embedding column. Changing it needs a new migration. */
export const ITEM_SEARCH_VECTOR_DIM = 1024;

export type ItemLocation = { lat: number; lng: number; label?: string };

/** The composite primary key of item_search. Reads and deletes key on all of it. */
export type ItemKey = {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
};

export type UpsertInput = ItemKey & {
  /** null when the item has no vectorizable content. Such rows stay findable by
   *  geo, structured filters and recency; vector queries sort them last or, on an
   *  HNSW index scan, omit them. */
  embedding: number[] | null;
  locations: ItemLocation[];
  lifecycleStatus: string;
  modelVersion: string;
  contentHash: string;
  /** `items.updated_at` read with the row, never `now()`: the sweep compares it
   *  with the live value, so the write clock would hide updates made during the
   *  embed. An epoch decimal string; see `SourceItem.updated_at_epoch`. */
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

  /** Advances the source-version marker on the unchanged-hash skip path.
   *  Without it, an edit outside the hash keeps matching the sweep predicate on
   *  every tick, and enough such rows starve newer ones out of the bounded,
   *  oldest-first sweep batch. A no-op when the row is absent. */
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
