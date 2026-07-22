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
const RAW = 'sk_signals_relevance_test_key_abcdefghijklmnop';
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0' };
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222'; // identical embedding to A
const C = '33333333-3333-3333-3333-333333333333'; // orthogonal embedding to A
const MISSING = '99999999-9999-9999-9999-999999999999';
const fakeEmbedder = { embed: async (t: string[]) => t.map(() => { const v = Array.from({ length: N }, () => 0); v[0] = 1; return v; }) };
const noRedis = { get: async () => null, set: async () => 'OK' } as any;
function vec(first: number) { const v = Array.from({ length: N }, () => 0); v[0] = first; v[1] = 1 - first; return v; }

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri(); await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, user_id text, enabled boolean NOT NULL DEFAULT true, expires_at timestamp, remaining integer)`;
  await sql`INSERT INTO "apikey" (id,key,user_id,enabled) VALUES ('k1', ${createHash('sha256').update(RAW).digest('base64url')}, 'usr_1', true)`;
  const repo = new ItemSearchRepo(sql, N);
  await repo.upsert({ ...base, item_id: A, embedding: vec(1), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'a' });
  await repo.upsert({ ...base, item_id: B, embedding: vec(1), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'b' });
  await repo.upsert({ ...base, item_id: C, embedding: vec(0), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'c' });
  const registry = await loadNetworkRegistry('test/fixtures/networks');
  app = buildServer({ deps: { sql, redis: noRedis, embedder: fakeEmbedder, registry, rerank: { model: 'r', defaultOn: false, topN: 50 }, cacheTtlSeconds: 0, embeddingDim: N, defaultDistanceMeters: 30000 } });
});
afterAll(async () => { await app?.close(); await sql?.end(); await pg?.stop(); });

const ref = (item_id: string) => ({ ...base, item_id });

describe('POST /v1/relevance', () => {
  it('401 without an api key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', payload: { itemA: ref(A), itemB: ref(B) } });
    expect(res.statusCode).toBe(401);
  });

  it('returns score 100 for two items with identical embeddings', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: ref(A), itemB: ref(B) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeCloseTo(100, 2);
  });

  it('returns score 0 for two items with orthogonal embeddings', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: ref(A), itemB: ref(C) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeCloseTo(0, 2);
  });

  it('404 when an item is not indexed', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: ref(A), itemB: ref(MISSING) } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('RELEVANCE_ITEMS_NOT_INDEXED');
  });

  it('400 on an invalid body (missing itemB)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: ref(A) } });
    expect(res.statusCode).toBe(400);
  });

  it('400 when item_id is not a uuid', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: { ...base, item_id: 'not-a-uuid' }, itemB: ref(B) } });
    expect(res.statusCode).toBe(400);
  });
});
