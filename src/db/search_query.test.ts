import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from './migrate.js';
import { ItemSearchRepo } from './item_search_repo.js';
import { searchItems } from './search_query.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
const N = 1024;
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0' };
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
function vec(first: number) { const v = Array.from({ length: N }, () => 0); v[0] = first; v[1] = 1 - first; return v; }

beforeAll(async () => {
  pg = await startPostgres();
  const url = pg.getConnectionUri();
  await runMigrations(url);
  sql = sqlClient(url);
  await sql`CREATE TABLE items (
    item_network text, item_domain text, item_type text, item_id uuid,
    item_state jsonb NOT NULL DEFAULT '{}', item_locations jsonb NOT NULL DEFAULT '[]',
    lifecycle_status text NOT NULL DEFAULT 'live',
    PRIMARY KEY (item_network, item_domain, item_type, item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations,lifecycle_status) VALUES
    (${base.item_network},${base.item_domain},${base.item_type},${A},'{"provider_category":"NGO / Trust","services_offered":["Assistive Devices","Training"]}','[{"lat":12.93,"lng":77.62}]','live'),
    (${base.item_network},${base.item_domain},${base.item_type},${B},'{"provider_category":"Private","services_offered":["Counselling"]}','[{"lat":19.07,"lng":72.87}]','live')`;
  const repo = new ItemSearchRepo(sql, N);
  await repo.upsert({ ...base, item_id: A, embedding: vec(1), locations: [{ lat: 12.93, lng: 77.62 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'a' });
  await repo.upsert({ ...base, item_id: B, embedding: vec(0), locations: [{ lat: 19.07, lng: 72.87 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'b' });
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('searchItems', () => {
  it('ranks by cosine similarity to the query vector', async () => {
    const { rows } = await searchItems(sql, { ...base, queryVector: vec(1), filters: [], limit: 10, offset: 0 });
    expect(rows[0].item_id).toBe(A);
    expect(rows[0].score).toBeGreaterThan(rows[1].score!);
  });
  it('applies a structured eq filter on item_state', async () => {
    const { rows, total } = await searchItems(sql, {
      ...base, queryVector: vec(1), limit: 10, offset: 0,
      filters: [{ op: 'eq', target: 'item_state.provider_category', value: 'NGO / Trust' }],
    });
    expect(total).toBe(1);
    expect(rows.map((r) => r.item_id)).toEqual([A]);
  });
  it('applies a contains filter on an array-valued item_state field', async () => {
    // A: services_offered=[Assistive Devices, Training]; B: [Counselling]
    const { rows, total } = await searchItems(sql, {
      ...base, queryVector: vec(1), limit: 10, offset: 0,
      filters: [{ op: 'contains', target: 'item_state.services_offered', value: ['Assistive Devices'] }],
    });
    expect(total).toBe(1);
    expect(rows.map((r) => r.item_id)).toEqual([A]);
  });
  it('contains requires ALL given values (jsonb @> semantics)', async () => {
    const both = await searchItems(sql, {
      ...base, queryVector: vec(1), limit: 10, offset: 0,
      filters: [{ op: 'contains', target: 'item_state.services_offered', value: ['Assistive Devices', 'Training'] }],
    });
    expect(both.rows.map((r) => r.item_id)).toEqual([A]); // A has both
    const partial = await searchItems(sql, {
      ...base, queryVector: vec(1), limit: 10, offset: 0,
      filters: [{ op: 'contains', target: 'item_state.services_offered', value: ['Assistive Devices', 'Counselling'] }],
    });
    expect(partial.total).toBe(0); // no single item has both
  });
  it('applies a geo s_dwithin filter (only nearby item)', async () => {
    const { rows } = await searchItems(sql, {
      ...base, queryVector: vec(1), filters: [], limit: 10, offset: 0,
      spatial: { lat: 12.93, lng: 77.62, distanceMeters: 5000 },
    });
    expect(rows.map((r) => r.item_id)).toEqual([A]);
    expect(rows[0].distanceMeters).toBeLessThan(5000);
  });
  it('ranks by distance when no query vector', async () => {
    const { rows } = await searchItems(sql, { ...base, filters: [], limit: 10, offset: 0, spatial: { lat: 12.93, lng: 77.62, distanceMeters: 5_000_000 } });
    expect(rows[0].item_id).toBe(A);
  });
});
