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

// Regression for the PR #7 review finding: the stage-1 over-fetch and the
// slice-back must share one predicate. An anchor search (intent.item.id, no
// textSearch) with RERANK_DEFAULT=true previously over-fetched topN at offset 0
// but skipped the rerank/slice block, returning up to topN rows and ignoring the
// requested pagination. Rerank only applies to free-text search, so an anchor
// search must fall back to plain DB pagination regardless of defaultOn.

let pg: StartedPostgreSqlContainer; let sql: Sql; let app: FastifyInstance;
const N = 1024;
const RAW = 'sk_rerank_pagination_test_key_abcdefghij';
const net = 'purple_dot';
const ANCHOR = '00000000-0000-4000-8000-0000000000aa'; // seeker anchor
const P = [
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333',
];

function vec(seed: number) { const v = Array.from({ length: N }, () => 0); v[seed % N] = 1; return v; }

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri(); await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE items (item_network text,item_domain text,item_type text,item_id uuid,item_state jsonb NOT NULL DEFAULT '{}',item_locations jsonb NOT NULL DEFAULT '[]',lifecycle_status text NOT NULL DEFAULT 'live',PRIMARY KEY (item_network,item_domain,item_type,item_id))`;
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, user_id text, enabled boolean NOT NULL DEFAULT true)`;
  await sql`INSERT INTO "apikey" (id,key,user_id,enabled) VALUES ('k1', ${createHash('sha256').update(RAW).digest('base64url')}, 'usr_1', true)`;
  const repo = new ItemSearchRepo(sql, N);
  // Anchor lives in the seeker domain; seeker -> provider is allowed by the fixture matrix.
  await repo.upsert({ item_network: net, item_domain: 'seeker', item_type: 'profile_1.0', item_id: ANCHOR, embedding: vec(0), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'anchor' });
  // Three live provider results.
  for (let i = 0; i < P.length; i++) {
    await sql`INSERT INTO items (item_network,item_domain,item_type,item_id) VALUES (${net},'provider','profile_1.0',${P[i]})`;
    await repo.upsert({ item_network: net, item_domain: 'provider', item_type: 'profile_1.0', item_id: P[i], embedding: vec(i), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: `p${i}` });
  }
  const registry = await loadNetworkRegistry('test/fixtures/networks');
  // Rerank ON with a configured (but never-called) endpoint; the anchor path has
  // no textSearch, so willRerank must resolve false and pagination must hold.
  app = buildServer({
    deps: {
      sql,
      redis: { get: async () => null, set: async () => 'OK' } as any,
      embedder: { embed: async () => [] } as any,
      registry,
      rerank: { model: 'r', defaultOn: true, baseUrl: 'http://unused-reranker:8081', topN: 50 },
      cacheTtlSeconds: 0,
      embeddingDim: N,
    },
  });
});
afterAll(async () => { await app?.close(); await sql?.end(); await pg?.stop(); });

function anchorReq(limit: number, offset: number) {
  return {
    context: { version: '1.0.0', messageId: 'm1', networkId: net, domain: 'provider', itemType: 'profile_1.0' },
    message: { intent: { item: { id: ANCHOR } }, pagination: { limit, offset } },
  };
}

describe('POST /v1/search — anchor pagination with rerank enabled', () => {
  it('honors pagination.limit on the anchor path (does not over-return topN)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: anchorReq(2, 0) });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.message.items).toHaveLength(2);
    expect(j.message.meta).toEqual({ total: 3, limit: 2, offset: 0 });
  });

  it('honors pagination.offset on the anchor path', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: anchorReq(2, 2) });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.message.items).toHaveLength(1);
    expect(j.message.meta).toEqual({ total: 3, limit: 2, offset: 2 });
  });
});
