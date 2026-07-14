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
const RAW = 'sk_signals_flat_test_key_abcdefghijklmnop';
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0' };
const seekerBase = { item_network: 'purple_dot', item_domain: 'seeker', item_type: 'profile_1.0' };
const A = '11111111-1111-1111-1111-111111111111';
const S1 = '33333333-3333-3333-3333-333333333333'; // seeker anchor co-located with A
const fakeEmbedder = { embed: async (t: string[]) => t.map(() => { const v = Array.from({ length: N }, () => 0); v[0] = 1; return v; }) };
const noRedis = { get: async () => null, set: async () => 'OK' } as any;

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri(); await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE items (item_network text,item_domain text,item_type text,item_id uuid,item_state jsonb NOT NULL DEFAULT '{}',item_locations jsonb NOT NULL DEFAULT '[]',lifecycle_status text NOT NULL DEFAULT 'live',PRIMARY KEY (item_network,item_domain,item_type,item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations) VALUES (${base.item_network},${base.item_domain},${base.item_type},${A},'{"provider_category":"NGO / Trust","service_details":"speech therapy","trade":"plumber"}','[{"lat":12.93,"lng":77.62}]')`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations) VALUES
    (${seekerBase.item_network},${seekerBase.item_domain},${seekerBase.item_type},${S1},'{"needs":"speech therapy"}','[{"lat":12.93,"lng":77.62}]')`;
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, user_id text, enabled boolean NOT NULL DEFAULT true, expires_at timestamp, remaining integer)`;
  await sql`INSERT INTO "apikey" (id,key,user_id,enabled) VALUES ('k1', ${createHash('sha256').update(RAW).digest('base64url')}, 'usr_1', true)`;
  const repo = new ItemSearchRepo(sql, N);
  const v = Array.from({ length: N }, () => 0); v[0] = 1;
  await repo.upsert({ ...base, item_id: A, embedding: v, locations: [{ lat: 12.93, lng: 77.62 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'a' });
  await repo.upsert({ ...seekerBase, item_id: S1, embedding: v, locations: [{ lat: 12.93, lng: 77.62 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 's1' });
  const registry = await loadNetworkRegistry('test/fixtures/networks');
  app = buildServer({ deps: { sql, redis: noRedis, embedder: fakeEmbedder, registry, rerank: { model: 'r', defaultOn: false, topN: 50 }, cacheTtlSeconds: 0, embeddingDim: N, defaultDistanceMeters: 30000 } });
});
afterAll(async () => { await app?.close(); await sql?.end(); await pg?.stop(); });

const ctx = { networkId: 'purple_dot', domain: 'provider', itemType: 'profile_1.0' };
const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: { 'x-api-key': RAW }, payload: payload as object });

describe('POST /v1/search/flat', () => {
  it('401 without an api key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search/flat', payload: { 'context.messageId': 'm1' } });
    expect(res.statusCode).toBe(401);
  });

  it('free-text: identical result to the equivalent nested /v1/search call', async () => {
    const nested = await post('/v1/search', {
      context: { messageId: 'm1', ...ctx },
      message: { intent: { textSearch: 'speech therapy' } },
    });
    const flat = await post('/v1/search/flat', {
      'context.messageId': 'm1',
      'context.networkId': ctx.networkId,
      'context.domain': ctx.domain,
      'context.itemType': ctx.itemType,
      'message.intent.textSearch': 'speech therapy',
    });
    expect(nested.statusCode).toBe(200);
    expect(flat.statusCode).toBe(200);
    expect(flat.json()).toEqual(nested.json());
    expect(flat.json().message.items[0].item_id).toBe(A);
  });

  it('anchor: item.id via flat key resolves the anchor', async () => {
    const flat = await post('/v1/search/flat', {
      'context.messageId': 'm2',
      'context.networkId': ctx.networkId,
      'context.domain': ctx.domain,
      'context.itemType': ctx.itemType,
      'message.intent.item.id': S1,
    });
    expect(flat.statusCode).toBe(200);
    expect(flat.json().message.items.map((i: { item_id: string }) => i.item_id)).toContain(A);
  });

  it('geo: indexed coordinate + distance keys parity with nested spatial clause', async () => {
    const spatial = { op: 's_dwithin' as const, geometry: { type: 'Point' as const, coordinates: [77.62, 12.93] as [number, number] }, distanceMeters: 5000 };
    const nested = await post('/v1/search', {
      context: { messageId: 'm3', ...ctx },
      message: { intent: { textSearch: 'speech therapy', spatial: [spatial] } },
    });
    const flat = await post('/v1/search/flat', {
      'context.messageId': 'm3',
      'context.networkId': ctx.networkId,
      'context.domain': ctx.domain,
      'context.itemType': ctx.itemType,
      'message.intent.textSearch': 'speech therapy',
      'message.intent.spatial.0.op': 's_dwithin',
      'message.intent.spatial.0.geometry.type': 'Point',
      'message.intent.spatial.0.geometry.coordinates.0': '77.62',
      'message.intent.spatial.0.geometry.coordinates.1': '12.93',
      'message.intent.spatial.0.distanceMeters': '5000',
    });
    expect(flat.statusCode).toBe(200);
    expect(flat.json()).toEqual(nested.json());
    expect(flat.json().message.items[0].item_id).toBe(A);
    expect(flat.json().message.items[0].distanceMeters).toBeLessThan(5000);
  });

  it('filters: indexed filter clause parity with nested filters array', async () => {
    const nested = await post('/v1/search', {
      context: { messageId: 'm4', ...ctx },
      message: { intent: { textSearch: 'speech therapy', filters: [{ op: 'eq', target: 'item_state.trade', value: 'plumber' }] } },
    });
    const flat = await post('/v1/search/flat', {
      'context.messageId': 'm4',
      'context.networkId': ctx.networkId,
      'context.domain': ctx.domain,
      'context.itemType': ctx.itemType,
      'message.intent.textSearch': 'speech therapy',
      'message.intent.filters.0.op': 'eq',
      'message.intent.filters.0.target': 'item_state.trade',
      'message.intent.filters.0.value': 'plumber',
    });
    expect(flat.statusCode).toBe(200);
    expect(flat.json()).toEqual(nested.json());
    expect(flat.json().message.items[0].item_id).toBe(A);
  });

  it('ignores prototype-pollution keys without mutating Object.prototype', async () => {
    const res = await post('/v1/search/flat', {
      'context.messageId': 'm-sec',
      'context.networkId': ctx.networkId,
      'context.domain': ctx.domain,
      'context.itemType': ctx.itemType,
      'message.intent.textSearch': 'speech therapy',
      '__proto__.polluted': 'yes',
      'constructor.prototype.polluted2': 'yes2',
    });
    expect(res.statusCode).toBe(200); // dangerous keys dropped, valid request proceeds
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
  });

  it('400 when a required field (context.messageId) is missing', async () => {
    const res = await post('/v1/search/flat', {
      'context.networkId': ctx.networkId,
      'context.domain': ctx.domain,
      'context.itemType': ctx.itemType,
      'message.intent.textSearch': 'speech therapy',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });

  it('400 when a leaf unflattens to the wrong type (limit is non-numeric)', async () => {
    const res = await post('/v1/search/flat', {
      'context.messageId': 'm5',
      'context.networkId': ctx.networkId,
      'context.domain': ctx.domain,
      'context.itemType': ctx.itemType,
      'message.intent.textSearch': 'speech therapy',
      'message.pagination.limit': 'abc',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });
});
