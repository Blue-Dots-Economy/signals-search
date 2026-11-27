import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { loadNetworkRegistry } from '../config/network_registry.js';
import { buildServer, type ApiDeps } from './server.js';
import type { Geocoder, GeocodeResult } from '../geo/geocoder.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';
import type { FastifyInstance } from 'fastify';

let pg: StartedPostgreSqlContainer; let sql: Sql;
const apps: FastifyInstance[] = [];
const N = 1024;
const RAW = 'sk_signals_address_test_key_abcdefghijklmnop';
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', sourceUpdatedAtEpoch: '1700000000' };
const A = '11111111-1111-1111-1111-111111111111'; // [77.62, 12.93]
const F = '55555555-5555-5555-5555-555555555555'; // [75.0, 15.46], several hundred km away
const fakeEmbedder = { embed: async (t: string[]) => t.map(() => { const v = Array.from({ length: N }, () => 0); v[0] = 1; return v; }) };
const noRedis = { get: async () => null, set: async () => 'OK' } as any;
let registry: Awaited<ReturnType<typeof loadNetworkRegistry>>;

function fakeGeocoder(result: GeocodeResult): Geocoder & { calls: number } {
  const g = { calls: 0, resolve: async () => { g.calls += 1; return result; } };
  return g;
}
const foundNearA = (precision: 'locality' | 'city' = 'locality'): GeocodeResult =>
  ({ kind: 'found', label: 'Koramangala, Bengaluru', lat: 12.93, lng: 77.62, precision });

function build(extra: Partial<ApiDeps>): FastifyInstance {
  const app = buildServer({ deps: { sql, redis: noRedis, embedder: fakeEmbedder, registry, rerank: { model: 'r', defaultOn: false, topN: 50 }, cacheTtlSeconds: 0, embeddingDim: N, defaultDistanceMeters: 30000, ...extra } });
  apps.push(app);
  return app;
}

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri(); await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE items (item_network text,item_domain text,item_type text,item_id uuid,item_state jsonb NOT NULL DEFAULT '{}',item_locations jsonb NOT NULL DEFAULT '[]',lifecycle_status text NOT NULL DEFAULT 'live',item_instance_url text,item_schema_url text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by text,PRIMARY KEY (item_network,item_domain,item_type,item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations) VALUES
    (${base.item_network},${base.item_domain},${base.item_type},${A},'{"service_details":"speech therapy"}','[{"lat":12.93,"lng":77.62}]'),
    (${base.item_network},${base.item_domain},${base.item_type},${F},'{"service_details":"speech therapy"}','[{"lat":15.46,"lng":75.0}]')`;
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, reference_id text, user_id text, enabled boolean NOT NULL DEFAULT true, expires_at timestamp, remaining integer)`;
  await sql`INSERT INTO "apikey" (id,key,user_id,enabled) VALUES ('k1', ${createHash('sha256').update(RAW).digest('base64url')}, 'usr_1', true)`;
  const repo = new ItemSearchRepo(sql, N);
  const v = Array.from({ length: N }, () => 0); v[0] = 1;
  await repo.upsert({ ...base, item_id: A, embedding: v, locations: [{ lat: 12.93, lng: 77.62 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'a' });
  await repo.upsert({ ...base, item_id: F, embedding: v, locations: [{ lat: 15.46, lng: 75.0 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'f' });
  registry = await loadNetworkRegistry('test/fixtures/networks');
});
afterAll(async () => { await Promise.all(apps.map((a) => a.close())); await sql?.end(); await pg?.stop(); });

const ctx = { version: '1.0.0', messageId: 'm1', networkId: 'purple_dot', domain: 'provider', itemType: 'profile_1.0' };
const req = (intent: Record<string, unknown>) => ({ context: ctx, message: { intent } });
const addr = (extra: Record<string, unknown> = {}, intent: Record<string, unknown> = {}) =>
  req({ ...intent, spatial: [{ op: 's_dwithin', address: 'Koramangala', ...extra }] });
const post = (app: FastifyInstance, payload: unknown, url = '/v1/search') =>
  app.inject({ method: 'POST', url, headers: { 'x-api-key': RAW }, payload: payload as object });
const ids = (res: { json(): any }) => res.json().message.items.map((i: { item_id: string }) => i.item_id);

describe('POST /v1/search with spatial address', () => {
  it('filters by the precision radius and echoes resolvedLocation', async () => {
    const app = build({ geocoder: fakeGeocoder(foundNearA()) });
    const res = await post(app, addr());
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([A]);
    expect(res.json().message.resolvedLocation).toEqual({
      input: 'Koramangala',
      label: 'Koramangala, Bengaluru',
      point: { type: 'Point', coordinates: [77.62, 12.93] },
      precision: 'locality',
      radiusMeters: 10000,
    });
  });

  it('an explicit distanceMeters overrides the precision radius', async () => {
    const app = build({ geocoder: fakeGeocoder(foundNearA()) });
    const res = await post(app, addr({ distanceMeters: 500000 }));
    expect(res.statusCode).toBe(200);
    expect(ids(res).sort()).toEqual([A, F].sort());
    expect(res.json().message.resolvedLocation.radiusMeters).toBe(500000);
  });

  it('city precision uses the city radius', async () => {
    const app = build({ geocoder: fakeGeocoder(foundNearA('city')) });
    const res = await post(app, addr());
    expect(res.json().message.resolvedLocation.radiusMeters).toBe(25000);
  });

  it('422 LOCATION_NOT_RESOLVED when the address is not found', async () => {
    const app = build({ geocoder: fakeGeocoder({ kind: 'not_found' }) });
    const res = await post(app, addr());
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'LOCATION_NOT_RESOLVED', message: "Could not resolve location 'Koramangala' to a place" });
  });

  it('503 GEOCODER_UNAVAILABLE when the geocoder is unavailable', async () => {
    const app = build({ geocoder: fakeGeocoder({ kind: 'unavailable', reason: 'timeout' }) });
    const res = await post(app, addr());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'GEOCODER_UNAVAILABLE', message: 'Geocoding is temporarily unavailable; retry later' });
  });

  it('503 for an address request when no geocoder is configured; textSearch still works', async () => {
    const app = build({});
    expect((await post(app, addr())).statusCode).toBe(503);
    const ok = await post(app, req({ textSearch: 'speech therapy' }));
    expect(ok.statusCode).toBe(200);
  });

  it('sort nearest reports sort_applied and distanceMeters', async () => {
    const app = build({ geocoder: fakeGeocoder(foundNearA()) });
    const res = await post(app, addr({}, { sort: 'nearest' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().message.meta.sort_applied).toBe('nearest');
    expect(res.json().message.items[0].distanceMeters).toBeTypeOf('number');
  });

  it('no resolvedLocation key without an address', async () => {
    const app = build({ geocoder: fakeGeocoder(foundNearA()) });
    const res = await post(app, req({ textSearch: 'speech therapy' }));
    expect(res.json().message).not.toHaveProperty('resolvedLocation');
  });

  it('the flat route resolves an address identically', async () => {
    const app = build({ geocoder: fakeGeocoder(foundNearA()) });
    const nested = await post(app, addr());
    const flat = await post(app, {
      'context.messageId': 'm1',
      'context.networkId': ctx.networkId,
      'context.domain': ctx.domain,
      'context.itemType': ctx.itemType,
      'message.intent.spatial.0.op': 's_dwithin',
      'message.intent.spatial.0.address': 'Koramangala',
    }, '/v1/search/flat');
    expect(flat.statusCode).toBe(200);
    expect(flat.json()).toEqual(nested.json());
  });
});

describe('address resolution and the result cache', () => {
  const memoryRedis = () => {
    const m = new Map<string, string>();
    return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => { m.set(k, v); return 'OK'; } } as any;
  };

  it('a cache hit skips the geocoder and keeps resolvedLocation', async () => {
    const geocoder = fakeGeocoder(foundNearA());
    const app = build({ geocoder, redis: memoryRedis(), cacheTtlSeconds: 60 });
    const first = await post(app, addr());
    const second = await post(app, addr());
    expect(second.statusCode).toBe(200);
    expect(second.json().message.resolvedLocation).toEqual(first.json().message.resolvedLocation);
    expect(geocoder.calls).toBe(1);
  });

  it('a 503 is not cached', async () => {
    const geocoder = fakeGeocoder({ kind: 'unavailable', reason: 'timeout' });
    const app = build({ geocoder, redis: memoryRedis(), cacheTtlSeconds: 60 });
    await post(app, addr());
    await post(app, addr());
    expect(geocoder.calls).toBe(2);
  });

  it('the flat route accepts a numeric pincode address and sends it as a string', async () => {
    const seen: string[] = [];
    const geocoder: Geocoder = {
      resolve: async (address: string) => {
        seen.push(address);
        return foundNearA();
      },
    };
    const app = build({ geocoder });
    const flat = await post(app, {
      'context.messageId': 'm1',
      'context.networkId': ctx.networkId,
      'context.domain': ctx.domain,
      'context.itemType': ctx.itemType,
      'message.intent.spatial.0.op': 's_dwithin',
      'message.intent.spatial.0.address': '580001',
    }, '/v1/search/flat');
    expect(flat.statusCode).toBe(200);
    expect(seen).toEqual(['580001']);
    expect(flat.json().message.resolvedLocation.input).toBe('580001');
  });
});
