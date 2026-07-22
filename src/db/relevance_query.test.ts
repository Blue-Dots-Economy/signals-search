import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from './migrate.js';
import { ItemSearchRepo } from './item_search_repo.js';
import { computeRelevance } from './relevance_query.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
const N = 1024;
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0' };
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222'; // identical embedding to A
const C = '33333333-3333-3333-3333-333333333333'; // orthogonal embedding to A
const NULLV = '44444444-4444-4444-4444-444444444444'; // indexed but NULL embedding
// vec(1) = [1,0,...]; vec(0) = [0,1,...] → cosine(vec(1),vec(1))=1, cosine(vec(1),vec(0))=0
function vec(first: number) { const v = Array.from({ length: N }, () => 0); v[0] = first; v[1] = 1 - first; return v; }

beforeAll(async () => {
  pg = await startPostgres();
  const url = pg.getConnectionUri();
  await runMigrations(url);
  sql = sqlClient(url);
  const repo = new ItemSearchRepo(sql, N);
  await repo.upsert({ ...base, item_id: A, embedding: vec(1), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'a' });
  await repo.upsert({ ...base, item_id: B, embedding: vec(1), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'b' });
  await repo.upsert({ ...base, item_id: C, embedding: vec(0), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'c' });
  await repo.upsert({ ...base, item_id: NULLV, embedding: null, locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'n' });
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('computeRelevance', () => {
  it('returns ~1 for two items with identical embeddings', async () => {
    const sim = await computeRelevance(sql, { ...base, item_id: A }, { ...base, item_id: B });
    expect(sim).not.toBeNull();
    expect(sim!).toBeCloseTo(1, 5);
  });

  it('returns ~0 for two items with orthogonal embeddings', async () => {
    const sim = await computeRelevance(sql, { ...base, item_id: A }, { ...base, item_id: C });
    expect(sim).not.toBeNull();
    expect(sim!).toBeCloseTo(0, 5);
  });

  it('returns null when one item is not indexed', async () => {
    const sim = await computeRelevance(
      sql,
      { ...base, item_id: A },
      { ...base, item_id: '99999999-9999-9999-9999-999999999999' },
    );
    expect(sim).toBeNull();
  });

  it('returns null when an item has a NULL embedding', async () => {
    const sim = await computeRelevance(sql, { ...base, item_id: A }, { ...base, item_id: NULLV });
    expect(sim).toBeNull();
  });
});
