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
// purple_dot fixture allows the interaction seeker -> provider (the "apply" action).
const seekerBase = { item_network: 'purple_dot', item_domain: 'seeker', item_type: 'profile_1.0' };
const providerBase = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0' };
const SEEKER = '11111111-1111-1111-1111-111111111111';       // live, model 'm'
const PROV_MATCH = '22222222-2222-2222-2222-222222222222';   // live, model 'm', identical embedding to SEEKER
const PROV_ORTH = '33333333-3333-3333-3333-333333333333';    // live, model 'm', orthogonal embedding
const PROV_OTHERMODEL = '44444444-4444-4444-4444-444444444444'; // live, DIFFERENT model version
const MISSING = '99999999-9999-9999-9999-999999999999';
const fakeEmbedder = { embed: async (t: string[]) => t.map(() => { const v = Array.from({ length: N }, () => 0); v[0] = 1; return v; }) };
const noRedis = { get: async () => null, set: async () => 'OK' } as any;
function vec(first: number) { const v = Array.from({ length: N }, () => 0); v[0] = first; v[1] = 1 - first; return v; }

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri(); await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, user_id text, enabled boolean NOT NULL DEFAULT true, expires_at timestamp, remaining integer)`;
  await sql`INSERT INTO "apikey" (id,key,user_id,enabled) VALUES ('k1', ${createHash('sha256').update(RAW).digest('base64url')}, 'usr_1', true)`;
  const repo = new ItemSearchRepo(sql, N);
  await repo.upsert({ ...seekerBase, item_id: SEEKER, embedding: vec(1), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 's' });
  await repo.upsert({ ...providerBase, item_id: PROV_MATCH, embedding: vec(1), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'pm' });
  await repo.upsert({ ...providerBase, item_id: PROV_ORTH, embedding: vec(0), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'po' });
  await repo.upsert({ ...providerBase, item_id: PROV_OTHERMODEL, embedding: vec(1), locations: [], lifecycleStatus: 'live', modelVersion: 'other', contentHash: 'px' });
  const registry = await loadNetworkRegistry('test/fixtures/networks');
  app = buildServer({ deps: { sql, redis: noRedis, embedder: fakeEmbedder, registry, rerank: { model: 'r', defaultOn: false, topN: 50 }, cacheTtlSeconds: 0, embeddingDim: N, defaultDistanceMeters: 30000 } });
});
afterAll(async () => { await app?.close(); await sql?.end(); await pg?.stop(); });

const seekerRef = (item_id: string) => ({ ...seekerBase, item_id });
const providerRef = (item_id: string) => ({ ...providerBase, item_id });

describe('POST /v1/relevance', () => {
  it('401 without an api key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', payload: { itemA: seekerRef(SEEKER), itemB: providerRef(PROV_MATCH) } });
    expect(res.statusCode).toBe(401);
  });

  it('returns score 100 for two items with identical embeddings (allowed interaction)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: seekerRef(SEEKER), itemB: providerRef(PROV_MATCH) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeCloseTo(100, 2);
  });

  it('returns score 0 for two items with orthogonal embeddings', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: seekerRef(SEEKER), itemB: providerRef(PROV_ORTH) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeCloseTo(0, 2);
  });

  it('403 when the domains are not allowed to interact (provider -> seeker is not in the matrix)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: providerRef(PROV_MATCH), itemB: seekerRef(SEEKER) } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('INTERACTION_NOT_ALLOWED');
  });

  it('404 when an item is not indexed', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: seekerRef(SEEKER), itemB: providerRef(MISSING) } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('RELEVANCE_ITEMS_NOT_INDEXED');
  });

  it('409 when the two items were embedded with different model versions', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: seekerRef(SEEKER), itemB: providerRef(PROV_OTHERMODEL) } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('RELEVANCE_NOT_COMPARABLE');
  });

  it('400 on an invalid body (missing itemB)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: seekerRef(SEEKER) } });
    expect(res.statusCode).toBe(400);
  });

  it('400 when item_id is not a uuid', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { itemA: { ...seekerBase, item_id: 'not-a-uuid' }, itemB: providerRef(PROV_MATCH) } });
    expect(res.statusCode).toBe(400);
  });
});
