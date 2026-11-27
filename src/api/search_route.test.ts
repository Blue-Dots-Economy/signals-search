import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startPostgres, sqlClient, createItemActionsTable } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { loadNetworkRegistry } from '../config/network_registry.js';
import { buildServer } from './server.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';
import type { FastifyInstance } from 'fastify';

let pg: StartedPostgreSqlContainer; let sql: Sql; let app: FastifyInstance;
const N = 1024;
const RAW = 'sk_signals_route_test_key_abcdefghijklmnop';
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', sourceUpdatedAtEpoch: '1700000000' };
const seekerBase = { item_network: 'purple_dot', item_domain: 'seeker', item_type: 'profile_1.0', sourceUpdatedAtEpoch: '1700000000' };
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222'; // anchor that exists only under network blue_dot
const S1 = '33333333-3333-3333-3333-333333333333'; // seeker anchor WITH a location (co-located with A)
const S2 = '44444444-4444-4444-4444-444444444444'; // seeker anchor with NO location
const fakeEmbedder = { embed: async (t: string[]) => t.map(() => { const v = Array.from({ length: N }, () => 0); v[0] = 1; return v; }) };
const noRedis = { get: async () => null, set: async () => 'OK' } as any;

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri(); await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE items (item_network text,item_domain text,item_type text,item_id uuid,item_state jsonb NOT NULL DEFAULT '{}',item_locations jsonb NOT NULL DEFAULT '[]',lifecycle_status text NOT NULL DEFAULT 'live',item_instance_url text,item_schema_url text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by text,PRIMARY KEY (item_network,item_domain,item_type,item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations,item_instance_url,item_schema_url,created_at,updated_at,created_by) VALUES (${base.item_network},${base.item_domain},${base.item_type},${A},'{"provider_category":"NGO / Trust","service_details":"speech therapy"}','[{"lat":12.93,"lng":77.62}]',NULL,'https://schema.example/profile.json','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','user-a')`;
  // Seeker anchors: S1 co-located with A; S2 has no location.
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations) VALUES
    (${seekerBase.item_network},${seekerBase.item_domain},${seekerBase.item_type},${S1},'{"needs":"speech therapy"}','[{"lat":12.93,"lng":77.62}]'),
    (${seekerBase.item_network},${seekerBase.item_domain},${seekerBase.item_type},${S2},'{"needs":"speech therapy"}','[]')`;
  await createItemActionsTable(sql);
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, reference_id text, user_id text, enabled boolean NOT NULL DEFAULT true, expires_at timestamp, remaining integer)`;
  await sql`INSERT INTO "apikey" (id,key,user_id,enabled) VALUES ('k1', ${createHash('sha256').update(RAW).digest('base64url')}, 'usr_1', true)`;
  const repo = new ItemSearchRepo(sql, N);
  const v = Array.from({ length: N }, () => 0); v[0] = 1;
  await repo.upsert({ ...base, item_id: A, embedding: v, locations: [{ lat: 12.93, lng: 77.62 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'a' });
  // Foreign-network anchor: same item_id UUID would resolve under the old
  // item_id-only lookup; the network-scoped lookup must not see it (1.9b).
  await repo.upsert({ item_network: 'blue_dot', item_domain: 'provider', item_type: 'profile_1.0', sourceUpdatedAtEpoch: '1700000000', item_id: B, embedding: v, locations: [{ lat: 12.93, lng: 77.62 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'b' });
  await repo.upsert({ ...seekerBase, item_id: S1, embedding: v, locations: [{ lat: 12.93, lng: 77.62 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 's1' });
  await repo.upsert({ ...seekerBase, item_id: S2, embedding: v, locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 's2' });
  const registry = await loadNetworkRegistry('test/fixtures/networks');
  app = buildServer({ deps: { sql, redis: noRedis, embedder: fakeEmbedder, registry, rerank: { model: 'r', defaultOn: false, topN: 50 }, cacheTtlSeconds: 0, embeddingDim: N, defaultDistanceMeters: 30000 } });
});
afterAll(async () => { await app?.close(); await sql?.end(); await pg?.stop(); });

const body = {
  context: { version: '1.0.0', messageId: 'm1', networkId: 'purple_dot', domain: 'provider', itemType: 'profile_1.0' },
  message: { intent: { textSearch: 'speech therapy' } },
};

describe('POST /v1/search', () => {
  it('401 without an api key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', payload: body });
    expect(res.statusCode).toBe(401);
  });
  it('returns ranked items + echoed context with a valid key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: body });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.context.networkId).toBe('purple_dot');
    expect(j.message.items[0].item_id).toBe(A);
    expect(j.message.items[0].item_state.provider_category).toBe('NGO / Trust');
    expect(j.message.meta.total).toBe(1);
    // New item metadata fields (#full-item-fields): instance/schema urls, timestamps,
    // creator, lifecycle. A's item_instance_url is null — nullable-field case.
    expect(j.message.items[0].item_instance_url).toBeNull();
    expect(j.message.items[0].item_schema_url).toBe('https://schema.example/profile.json');
    expect(j.message.items[0].created_by).toBe('user-a');
    expect(j.message.items[0].lifecycle_status).toBe('live');
    expect(j.message.items[0].created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(j.message.items[0].updated_at).toBe('2026-01-02T00:00:00.000Z');
  });
});

const anchorBody = (intent: Record<string, unknown>) => ({
  context: { version: '1.0.0', messageId: 'm', networkId: 'purple_dot', domain: 'provider', itemType: 'profile_1.0' },
  message: { intent },
});

describe('POST /v1/search — anchor + location (#21)', () => {
  it('(c) anchor only, no spatial → no geo filter, returns the candidate', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: anchorBody({ item: { id: S1 } }) });
    expect(res.statusCode).toBe(200);
    const items = res.json().message.items;
    expect(items.map((i: { item_id: string }) => i.item_id)).toContain(A);
    expect(items[0].distanceMeters).toBeUndefined(); // no geo → no distance
  });

  it('(a) anchor + coordinate-less spatial → uses the anchor\'s location', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: anchorBody({ item: { id: S1 }, spatial: [{ op: 's_dwithin', distanceMeters: 5000 }] }) });
    expect(res.statusCode).toBe(200);
    const items = res.json().message.items;
    expect(items.map((i: { item_id: string }) => i.item_id)).toContain(A); // A is co-located with the anchor
    expect(items[0].distanceMeters).toBeLessThan(5000);
  });

  it('(a) default radius is applied when distanceMeters is omitted', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: anchorBody({ item: { id: S1 }, spatial: [{ op: 's_dwithin' }] }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().message.items.map((i: { item_id: string }) => i.item_id)).toContain(A); // within default 30 km
  });

  it('(b) explicit geometry overrides the anchor location (far point excludes the candidate)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: anchorBody({ item: { id: S1 }, spatial: [{ op: 's_dwithin', geometry: { type: 'Point', coordinates: [72.87, 19.07] }, distanceMeters: 5000 }] }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().message.meta.total).toBe(0); // candidate is far from the explicit point, so excluded
  });

  it('422 when the anchor has no location and spatial omits geometry', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: anchorBody({ item: { id: S2 }, spatial: [{ op: 's_dwithin', distanceMeters: 5000 }] }) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('ANCHOR_HAS_NO_LOCATION');
  });

  it('400 when a coordinate-less spatial is sent without item.id', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: anchorBody({ textSearch: 'speech therapy', spatial: [{ op: 's_dwithin', distanceMeters: 5000 }] }) });
    expect(res.statusCode).toBe(400);
  });

  it('404 for a cross-network anchor (anchor lookup scoped by networkId, 1.9b)', async () => {
    // Caller is purple_dot; B exists only under blue_dot. The anchor must be
    // invisible cross-network → 404, not resolved from the foreign row.
    const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: anchorBody({ item: { id: B } }) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('ANCHOR_NOT_FOUND');
  });
});

describe('POST /v1/search — action filters, include_action and date ranges', () => {
  const post = (intent: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: anchorBody(intent) });
  const ids = (res: { json: () => { message: { items: { item_id: string }[] } } }) => res.json().message.items.map((i) => i.item_id);
  const setAction = async (status: string) => {
    await sql`DELETE FROM item_actions`;
    await sql`INSERT INTO item_actions (partition_network,action_type,action_status,source_item_id,target_item_id,remarks,requirements_snapshot,created_at,updated_at)
      VALUES ('purple_dot','apply',${status},${S1},${A},'private note','{"phone":"9999999999"}','2026-11-10T09:12:00Z','2026-11-12T15:40:00Z')`;
  };
  const excludeCreate = { objType: 'action', op: 'neq', target: 'status_group', value: 'create' };

  it('hides a job with a pending action and keeps it once the action is closed', async () => {
    await setAction('submitted');
    const pending = await post({ item: { id: S1 }, filters: [excludeCreate] });
    expect(pending.statusCode).toBe(200);
    expect(ids(pending)).toEqual([]);
    expect(pending.json().message.meta.total).toBe(0);

    await setAction('rejected');
    expect(ids(await post({ item: { id: S1 }, filters: [excludeCreate] }))).toEqual([A]);
  });

  it('combines an action clause with item filters', async () => {
    await setAction('rejected');
    const res = await post({
      item: { id: S1 },
      filters: [excludeCreate, { op: 'eq', target: 'item_state.provider_category', value: 'Private' }],
    });
    expect(ids(res)).toEqual([]);
  });

  it('a network without metric_categories has an empty reject group, so exact statuses are needed', async () => {
    await setAction('rejected');
    const byGroup = await post({ item: { id: S1 }, filters: [{ objType: 'action', op: 'neq', target: 'status_group', value: 'reject' }] });
    const byStatus = await post({ item: { id: S1 }, filters: [{ objType: 'action', op: 'not_in', target: 'status', value: ['rejected'] }] });
    expect(ids(byGroup)).toEqual([A]);
    expect(ids(byStatus)).toEqual([]);
  });

  it('include_action returns the latest action and never remarks or the requirements snapshot', async () => {
    await setAction('submitted');
    const res = await post({ item: { id: S1 }, include_action: true });
    expect(res.statusCode).toBe(200);
    const [item] = res.json().message.items;
    expect(item.action).toEqual({
      type: 'apply', status: 'submitted', created_at: '2026-11-10T09:12:00.000Z', updated_at: '2026-11-12T15:40:00.000Z',
    });
    expect(res.body).not.toContain('private note');
    expect(res.body).not.toContain('9999999999');
  });

  it('omits action when include_action is off', async () => {
    await setAction('submitted');
    const [item] = (await post({ item: { id: S1 } })).json().message.items;
    expect(item.action).toBeUndefined();
  });

  it('400 for an action type the network does not define', async () => {
    const res = await post({ item: { id: S1 }, filters: [{ objType: 'action', op: 'eq', target: 'type', value: 'connect' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'VALIDATION_ERROR',
      message: "unknown action type 'connect' for network purple_dot; use apply, refer",
    });
  });

  it('400 for an action filter or include_action without an anchor', async () => {
    const filter = await post({ textSearch: 'speech therapy', filters: [excludeCreate] });
    const include = await post({ textSearch: 'speech therapy', include_action: true });
    expect(filter.statusCode).toBe(400);
    expect(include.statusCode).toBe(400);
  });

  it('filters by created_at end to end (A was created on 2026-01-01)', async () => {
    const inRange = await post({ item: { id: S1 }, created_at: { gte: 1767225600, lte: 1767311999 } });
    expect(inRange.statusCode).toBe(200);
    expect(ids(inRange)).toEqual([A]);

    const outOfRange = await post({ item: { id: S1 }, updated_at: { gte: 1769904000 } });
    expect(outOfRange.statusCode).toBe(200);
    expect(outOfRange.json().message.meta.total).toBe(0);
  });

  it('400 when a date range has gte later than lte', async () => {
    const res = await post({ textSearch: 'x', created_at: { gte: 1769904000, lte: 1767225600 } });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/search — result cache with action data', () => {
  let cachedApp: FastifyInstance;
  const store = new Map<string, string>();
  const calls = { get: 0, set: 0 };
  const recordingRedis = {
    get: async (k: string) => { calls.get += 1; return store.get(k) ?? null; },
    set: async (k: string, v: string) => { calls.set += 1; store.set(k, v); return 'OK'; },
  } as any;

  beforeAll(async () => {
    const registry = await loadNetworkRegistry('test/fixtures/networks');
    cachedApp = buildServer({ deps: { sql, redis: recordingRedis, embedder: fakeEmbedder, registry, rerank: { model: 'r', defaultOn: false, topN: 50 }, cacheTtlSeconds: 45, embeddingDim: N, defaultDistanceMeters: 30000 } });
  });
  afterAll(async () => { await cachedApp?.close(); });

  const search = (intent: Record<string, unknown>) =>
    cachedApp.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: anchorBody(intent) });
  const reset = () => { store.clear(); calls.get = 0; calls.set = 0; };

  it('neither reads nor writes the cache with an action filter', async () => {
    reset();
    const res = await search({ item: { id: S1 }, filters: [{ objType: 'action', op: 'neq', target: 'status_group', value: 'create' }] });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual({ get: 0, set: 0 });
  });

  it('neither reads nor writes the cache with include_action', async () => {
    reset();
    const res = await search({ item: { id: S1 }, include_action: true });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual({ get: 0, set: 0 });
  });

  it('still caches an anchored search with only item filters and include_action off', async () => {
    reset();
    await search({ item: { id: S1 }, include_action: false, filters: [{ op: 'eq', target: 'item_state.provider_category', value: 'NGO / Trust' }] });
    expect(calls).toEqual({ get: 1, set: 1 });
  });

  it('still caches a date-filtered search', async () => {
    reset();
    await search({ item: { id: S1 }, created_at: { gte: 1767225600 } });
    expect(calls).toEqual({ get: 1, set: 1 });
  });
});
