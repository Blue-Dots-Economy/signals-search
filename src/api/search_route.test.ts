import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
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
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0' };
const seekerBase = { item_network: 'purple_dot', item_domain: 'seeker', item_type: 'profile_1.0' };
const A = '11111111-1111-1111-1111-111111111111';
const S1 = '33333333-3333-3333-3333-333333333333'; // seeker anchor WITH a location (co-located with A)
const S2 = '44444444-4444-4444-4444-444444444444'; // seeker anchor with NO location
const fakeEmbedder = { embed: async (t: string[]) => t.map(() => { const v = Array.from({ length: N }, () => 0); v[0] = 1; return v; }) };
const noRedis = { get: async () => null, set: async () => 'OK' } as any;

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri(); await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE items (item_network text,item_domain text,item_type text,item_id uuid,item_state jsonb NOT NULL DEFAULT '{}',item_locations jsonb NOT NULL DEFAULT '[]',lifecycle_status text NOT NULL DEFAULT 'live',PRIMARY KEY (item_network,item_domain,item_type,item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations) VALUES (${base.item_network},${base.item_domain},${base.item_type},${A},'{"provider_category":"NGO / Trust","service_details":"speech therapy"}','[{"lat":12.93,"lng":77.62}]')`;
  // Seeker anchors: S1 co-located with A; S2 has no location.
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations) VALUES
    (${seekerBase.item_network},${seekerBase.item_domain},${seekerBase.item_type},${S1},'{"needs":"speech therapy"}','[{"lat":12.93,"lng":77.62}]'),
    (${seekerBase.item_network},${seekerBase.item_domain},${seekerBase.item_type},${S2},'{"needs":"speech therapy"}','[]')`;
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, user_id text, enabled boolean NOT NULL DEFAULT true)`;
  await sql`INSERT INTO "apikey" (id,key,user_id,enabled) VALUES ('k1', ${createHash('sha256').update(RAW).digest('base64url')}, 'usr_1', true)`;
  const repo = new ItemSearchRepo(sql, N);
  const v = Array.from({ length: N }, () => 0); v[0] = 1;
  await repo.upsert({ ...base, item_id: A, embedding: v, locations: [{ lat: 12.93, lng: 77.62 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'a' });
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
});
