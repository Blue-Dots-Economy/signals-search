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
const A = '11111111-1111-1111-1111-111111111111';
const fakeEmbedder = { embed: async (t: string[]) => t.map(() => { const v = Array.from({ length: N }, () => 0); v[0] = 1; return v; }) };
const noRedis = { get: async () => null, set: async () => 'OK' } as any;

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri(); await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE items (item_network text,item_domain text,item_type text,item_id uuid,item_state jsonb NOT NULL DEFAULT '{}',item_locations jsonb NOT NULL DEFAULT '[]',lifecycle_status text NOT NULL DEFAULT 'live',PRIMARY KEY (item_network,item_domain,item_type,item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations) VALUES (${base.item_network},${base.item_domain},${base.item_type},${A},'{"provider_category":"NGO / Trust","service_details":"speech therapy"}','[{"lat":12.93,"lng":77.62}]')`;
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, user_id text, enabled boolean NOT NULL DEFAULT true)`;
  await sql`INSERT INTO "apikey" (id,key,user_id,enabled) VALUES ('k1', ${createHash('sha256').update(RAW).digest('base64url')}, 'usr_1', true)`;
  const repo = new ItemSearchRepo(sql, N);
  const v = Array.from({ length: N }, () => 0); v[0] = 1;
  await repo.upsert({ ...base, item_id: A, embedding: v, locations: [{ lat: 12.93, lng: 77.62 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'a' });
  const registry = await loadNetworkRegistry('test/fixtures/networks');
  app = buildServer({ deps: { sql, redis: noRedis, embedder: fakeEmbedder, registry, rerank: { model: 'r', defaultOn: false, topN: 50 }, cacheTtlSeconds: 0, embeddingDim: N } });
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
