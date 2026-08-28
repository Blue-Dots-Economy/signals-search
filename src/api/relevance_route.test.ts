import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { loadNetworkRegistry } from '../config/network_registry.js';
import { buildServer } from './server.js';
import { resetKeycloakJwksCacheForTests } from './auth.js';
import { startJwksServer, type JwksHarness } from '../../test/support/jwks.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';
import type { FastifyInstance } from 'fastify';

let pg: StartedPostgreSqlContainer; let sql: Sql; let app: FastifyInstance; let jwks: JwksHarness;
const N = 1024;
const RAW = 'sk_signals_relevance_test_key_abcdefghijklmnop';
// purple_dot fixture allows: seeker -> provider (same-network "apply") and
// seeker -> blue_dot/aggregator (cross-network "refer").
const seekerBase = { item_network: 'purple_dot', item_domain: 'seeker', item_type: 'profile_1.0', sourceUpdatedAtEpoch: '1700000000' };
const providerBase = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', sourceUpdatedAtEpoch: '1700000000' };
const aggBase = { item_network: 'blue_dot', item_domain: 'aggregator', item_type: 'profile_1.0', sourceUpdatedAtEpoch: '1700000000' };
const SEEKER = '11111111-1111-1111-1111-111111111111';       // live, model 'm'
const PROV_MATCH = '22222222-2222-2222-2222-222222222222';   // live, model 'm', identical embedding to SEEKER
const PROV_ORTH = '33333333-3333-3333-3333-333333333333';    // live, model 'm', orthogonal embedding
const PROV_OTHERMODEL = '44444444-4444-4444-4444-444444444444'; // live, DIFFERENT model version
const AGG = '55555555-5555-5555-5555-555555555555';          // blue_dot, live, model 'm', identical embedding
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
  await repo.upsert({ ...aggBase, item_id: AGG, embedding: vec(1), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'ag' });
  const registry = await loadNetworkRegistry('test/fixtures/networks');
  jwks = await startJwksServer();
  app = buildServer({
    deps: {
      sql, redis: noRedis, embedder: fakeEmbedder, registry,
      rerank: { model: 'r', defaultOn: false, topN: 50 }, cacheTtlSeconds: 0, embeddingDim: N, defaultDistanceMeters: 30000,
      auth: {
        acceptApiKey: true,
        keycloak: {
          issuer: jwks.issuer, jwksUri: jwks.jwksUri, audience: 'signals-search',
          serviceClientIds: ['signals-search'], jwksCacheMaxAgeMs: 600_000,
          clockToleranceSeconds: 0,
        },
      },
    },
  });
});
afterAll(async () => { await app?.close(); await sql?.end(); await pg?.stop(); await jwks?.close(); });

const seekerRef = (id: string) => ({ network: 'purple_dot', domain: 'seeker', type: 'profile_1.0', id });
const providerRef = (id: string) => ({ network: 'purple_dot', domain: 'provider', type: 'profile_1.0', id });
const aggRef = (id: string) => ({ network: 'blue_dot', domain: 'aggregator', type: 'profile_1.0', id });

describe('POST /v1/relevance', () => {
  it('401 without an api key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', payload: { source: seekerRef(SEEKER), target: providerRef(PROV_MATCH) } });
    expect(res.statusCode).toBe(401);
  });

  it('returns score 100 for two items with identical embeddings (allowed same-network interaction)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { source: seekerRef(SEEKER), target: providerRef(PROV_MATCH) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeCloseTo(100, 2);
  });

  it('returns score 0 for two items with orthogonal embeddings', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { source: seekerRef(SEEKER), target: providerRef(PROV_ORTH) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeCloseTo(0, 2);
  });

  it('scores a CROSS-NETWORK pair allowed by the matrix (purple_dot/seeker -> blue_dot/aggregator)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { source: seekerRef(SEEKER), target: aggRef(AGG) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeCloseTo(100, 2);
  });

  it('403 when the domains are not allowed to interact (provider -> seeker is not in the matrix)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { source: providerRef(PROV_MATCH), target: seekerRef(SEEKER) } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('INTERACTION_NOT_ALLOWED');
  });

  it('404 when an item is not indexed', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { source: seekerRef(SEEKER), target: providerRef(MISSING) } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('RELEVANCE_ITEMS_NOT_INDEXED');
  });

  it('409 when the two items were embedded with different model versions', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { source: seekerRef(SEEKER), target: providerRef(PROV_OTHERMODEL) } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('RELEVANCE_NOT_COMPARABLE');
  });

  it('400 on an invalid body (missing target)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { source: seekerRef(SEEKER) } });
    expect(res.statusCode).toBe(400);
  });

  it('400 when id is not a uuid', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/relevance', headers: { 'x-api-key': RAW }, payload: { source: { network: 'purple_dot', domain: 'seeker', type: 'profile_1.0', id: 'not-a-uuid' }, target: providerRef(PROV_MATCH) } });
    expect(res.statusCode).toBe(400);
  });

  it('scores a pair for a caller carrying a valid bearer token', async () => {
    const token = await jwks.mint();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/relevance',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: seekerRef(SEEKER), target: providerRef(PROV_MATCH) },
    });
    expect(res.statusCode).toBe(200);
  });

  // This route shares one requireCaller with the search routes, so these two
  // pin that the shared gate is actually reached here — the asymmetry that let
  // a status drift in the old inlined copy ship green.
  it('403s a valid token from a client that may not search', async () => {
    const token = await jwks.mint({ azp: 'aggregator-dpg' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/relevance',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: seekerRef(SEEKER), target: providerRef(PROV_MATCH) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('CLIENT_NOT_PERMITTED');
  });

  it('503s — not 401s — while the JWKS endpoint is down', async () => {
    const token = await jwks.mint();
    // jose memoises its key set per JWKS URL; without the reset, the earlier
    // successful verification in this file would mean setFailing never causes a
    // fetch and the outage path is never exercised.
    resetKeycloakJwksCacheForTests();
    jwks.setFailing(true);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/relevance',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: seekerRef(SEEKER), target: providerRef(PROV_MATCH) },
    });
    jwks.setFailing(false);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('AUTH_PROVIDER_UNAVAILABLE');
  });
});
