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
const A = '11111111-1111-1111-1111-111111111111'; // live, model 'm'
const B = '22222222-2222-2222-2222-222222222222'; // live, model 'm', identical embedding to A
const C = '33333333-3333-3333-3333-333333333333'; // live, model 'm', orthogonal embedding to A
const NULLV = '44444444-4444-4444-4444-444444444444'; // live, NULL embedding
const PAUSED = '55555555-5555-5555-5555-555555555555'; // NON-live (paused), model 'm'
const OTHERMODEL = '66666666-6666-6666-6666-666666666666'; // live, DIFFERENT model version
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
  await repo.upsert({ ...base, item_id: PAUSED, embedding: vec(1), locations: [], lifecycleStatus: 'paused', modelVersion: 'm', contentHash: 'p' });
  await repo.upsert({ ...base, item_id: OTHERMODEL, embedding: vec(1), locations: [], lifecycleStatus: 'live', modelVersion: 'other', contentHash: 'o' });
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('computeRelevance', () => {
  it('returns ok with similarity ~1 for two live items with identical embeddings', async () => {
    const r = await computeRelevance(sql, { ...base, item_id: A }, { ...base, item_id: B });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.similarity).toBeCloseTo(1, 5);
  });

  it('returns ok with similarity ~0 for two live items with orthogonal embeddings', async () => {
    const r = await computeRelevance(sql, { ...base, item_id: A }, { ...base, item_id: C });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.similarity).toBeCloseTo(0, 5);
  });

  it('returns not_found when one item is not indexed', async () => {
    const r = await computeRelevance(
      sql,
      { ...base, item_id: A },
      { ...base, item_id: '99999999-9999-9999-9999-999999999999' },
    );
    expect(r.status).toBe('not_found');
  });

  it('returns not_found when an item has a NULL embedding', async () => {
    const r = await computeRelevance(sql, { ...base, item_id: A }, { ...base, item_id: NULLV });
    expect(r.status).toBe('not_found');
  });

  it('returns not_found when an item is not live (lifecycle scope)', async () => {
    const r = await computeRelevance(sql, { ...base, item_id: A }, { ...base, item_id: PAUSED });
    expect(r.status).toBe('not_found');
  });

  it('returns not_comparable when the two items were embedded with different model versions', async () => {
    const r = await computeRelevance(sql, { ...base, item_id: A }, { ...base, item_id: OTHERMODEL });
    expect(r.status).toBe('not_comparable');
  });
});
