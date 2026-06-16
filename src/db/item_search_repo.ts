import type { Sql } from 'postgres';

export type ItemLocation = { lat: number; lng: number; label?: string };

export type UpsertInput = {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  embedding: number[];
  locations: ItemLocation[];
  lifecycleStatus: string;
  modelVersion: string;
  contentHash: string;
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
    if (input.embedding.length !== this.dim) {
      throw new Error(`embedding dim ${input.embedding.length} != ${this.dim}`);
    }
    const vec = toVectorLiteral(input.embedding);
    const wkt = toMultipointWkt(input.locations);
    await this.sql`
      INSERT INTO item_search
        (item_network, item_domain, item_type, item_id, embedding, geo, lifecycle_status, model_version, content_hash, indexed_at)
      VALUES (
        ${input.item_network}, ${input.item_domain}, ${input.item_type}, ${input.item_id},
        ${vec}::vector,
        ${wkt ? this.sql`ST_SetSRID(ST_GeomFromText(${wkt}), 4326)::geography` : this.sql`NULL`},
        ${input.lifecycleStatus}, ${input.modelVersion}, ${input.contentHash}, now()
      )
      ON CONFLICT (item_network, item_domain, item_type, item_id) DO UPDATE SET
        embedding = EXCLUDED.embedding,
        geo = EXCLUDED.geo,
        lifecycle_status = EXCLUDED.lifecycle_status,
        model_version = EXCLUDED.model_version,
        content_hash = EXCLUDED.content_hash,
        indexed_at = now()`;
  }

  async getContentHash(item_id: string): Promise<string | null> {
    const rows = await this.sql<{ content_hash: string | null }[]>`
      SELECT content_hash FROM item_search WHERE item_id = ${item_id} LIMIT 1`;
    return rows[0]?.content_hash ?? null;
  }

  async delete(item_id: string): Promise<void> {
    await this.sql`DELETE FROM item_search WHERE item_id = ${item_id}`;
  }
}
