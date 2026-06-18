import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from './migrate.js';
import { ItemSearchRepo } from './item_search_repo.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
let repo: ItemSearchRepo;

const key = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: '5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf' };

beforeAll(async () => {
  pg = await startPostgres();
  await runMigrations(pg.getConnectionUri());
  sql = sqlClient(pg.getConnectionUri());
  repo = new ItemSearchRepo(sql, 1024);
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('ItemSearchRepo.upsert', () => {
  it('writes embedding + multipoint geography and is queryable by ANN + ST_DWithin', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    await repo.upsert({
      ...key,
      embedding,
      locations: [{ lat: 12.9352, lng: 77.6245, label: 'Bengaluru' }],
      lifecycleStatus: 'live',
      modelVersion: 'BAAI/bge-m3@1024',
      contentHash: 'abc',
    });

    const ann = await sql<{ item_id: string }[]>`
      SELECT item_id FROM item_search
      ORDER BY embedding <=> ${'[' + embedding.join(',') + ']'}::vector LIMIT 1`;
    expect(ann[0].item_id).toBe(key.item_id);

    const near = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM item_search
      WHERE ST_DWithin(geo, ST_SetSRID(ST_MakePoint(77.6245, 12.9352), 4326)::geography, 1000)`;
    expect(near[0].n).toBe(1);
  });

  it('upsert updates in place (no duplicate PK)', async () => {
    const embedding = Array.from({ length: 1024 }, () => 0);
    embedding[1] = 1;
    await repo.upsert({ ...key, embedding, locations: [], lifecycleStatus: 'paused', modelVersion: 'm', contentHash: 'def' });
    const rows = await sql<{ content_hash: string }[]>`SELECT content_hash FROM item_search WHERE item_id = ${key.item_id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe('def');
  });

  it('accepts a NULL embedding (geo-only row) for items without vectorizable content', async () => {
    const k = { ...key, item_id: '11111111-2222-4333-8444-555566667777' };
    await repo.upsert({ ...k, embedding: null, locations: [{ lat: 12.9, lng: 77.6 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'geo-only' });
    const rows = await sql<{ embedding: unknown; has_geo: boolean }[]>`
      SELECT embedding, geo IS NOT NULL AS has_geo FROM item_search WHERE item_id = ${k.item_id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].embedding).toBeNull();
    expect(rows[0].has_geo).toBe(true);
  });
});

describe('ItemSearchRepo composite-key reads/deletes', () => {
  it('getContentHash matches on the full composite key', async () => {
    // not-yet-present key returns null
    const absent = { ...key, item_id: '00000000-0000-4000-8000-000000000000' };
    expect(await repo.getContentHash(absent)).toBeNull();
    // present key returns its current hash (set to 'def' by the upsert test above)
    expect(await repo.getContentHash(key)).toBe('def');
    // same item_id but a different composite part must NOT match
    expect(await repo.getContentHash({ ...key, item_domain: 'seeker' })).toBeNull();
  });

  it('delete removes only the row with the matching composite key', async () => {
    // a different composite key (same item_id, different type) is left untouched
    await repo.delete({ ...key, item_type: 'profile_2.0' });
    expect(await repo.getContentHash(key)).toBe('def');
    // deleting the exact composite key removes it
    await repo.delete(key);
    expect(await repo.getContentHash(key)).toBeNull();
  });
});
