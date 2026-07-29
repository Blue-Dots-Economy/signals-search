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
    item_instance_url text, item_schema_url text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    PRIMARY KEY (item_network, item_domain, item_type, item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations,lifecycle_status,item_instance_url,item_schema_url,created_at,updated_at,created_by) VALUES
    (${base.item_network},${base.item_domain},${base.item_type},${A},'{"provider_category":"NGO / Trust","services_offered":["Assistive Devices","Training"]}','[{"lat":12.93,"lng":77.62}]','live','https://a.instance.example/','https://schema.example/profile.json','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','user-a'),
    (${base.item_network},${base.item_domain},${base.item_type},${B},'{"provider_category":"Private","services_offered":["Counselling"]}','[{"lat":19.07,"lng":72.87}]','live',NULL,'https://schema.example/profile.json','2026-01-03T00:00:00Z','2026-01-04T00:00:00Z',NULL)`;
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
  it('contains_any matches items sharing ANY given value (jsonb ?| semantics)', async () => {
    // A: services_offered=[Assistive Devices, Training]; B: [Counselling]
    const anyMatch = await searchItems(sql, {
      ...base, queryVector: vec(1), limit: 10, offset: 0,
      filters: [{ op: 'contains_any', target: 'item_state.services_offered', value: ['Training', 'Counselling'] }],
    });
    expect(anyMatch.total).toBe(2); // A has Training, B has Counselling
    expect(anyMatch.rows.map((r) => r.item_id).sort()).toEqual([A, B].sort());

    const oneMatch = await searchItems(sql, {
      ...base, queryVector: vec(1), limit: 10, offset: 0,
      filters: [{ op: 'contains_any', target: 'item_state.services_offered', value: ['Counselling'] }],
    });
    expect(oneMatch.rows.map((r) => r.item_id)).toEqual([B]);

    const noMatch = await searchItems(sql, {
      ...base, queryVector: vec(1), limit: 10, offset: 0,
      filters: [{ op: 'contains_any', target: 'item_state.services_offered', value: ['Nonexistent'] }],
    });
    expect(noMatch.total).toBe(0);
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
  it('returns the new item metadata fields (instance/schema urls, timestamps, creator, lifecycle)', async () => {
    const { rows } = await searchItems(sql, { ...base, queryVector: vec(1), filters: [], limit: 10, offset: 0 });
    const a = rows.find((r) => r.item_id === A)!;
    const b = rows.find((r) => r.item_id === B)!;
    expect(a.item_instance_url).toBe('https://a.instance.example/');
    expect(a.item_schema_url).toBe('https://schema.example/profile.json');
    expect(a.created_by).toBe('user-a');
    expect(a.lifecycle_status).toBe('live');
    expect(a.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(a.updated_at).toBe('2026-01-02T00:00:00.000Z');
    // B has a null item_instance_url and created_by — nullable-field case.
    expect(b.item_instance_url).toBeNull();
    expect(b.created_by).toBeNull();
  });
});
