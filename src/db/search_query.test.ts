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
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', sourceUpdatedAtEpoch: '1700000000' };
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

// ---------------------------------------------------------------------------
// Explicit sort (contract §3). Seeded under a SEPARATE item_network so the
// assertions above — which count rows and check cosine order within
// purple_dot — stay byte-identical. searchItems scopes every query on
// (item_network, item_domain, item_type), so the two sets never interact.
// ---------------------------------------------------------------------------

const sortNet = { item_network: 'green_dot', item_domain: 'provider', item_type: 'profile_1.0', sourceUpdatedAtEpoch: '1700000000' };
const G_NEAR = 'aaaaaaaa-0000-4000-8000-00000000000a';  // Bengaluru
const G_FAR = 'bbbbbbbb-0000-4000-8000-00000000000b';   // Delhi, ~1740 km away
const G_NOLOC = 'cccccccc-0000-4000-8000-00000000000c'; // no stored location
const CENTRE = { lat: 12.97, lng: 77.59 };              // Bengaluru

beforeAll(async () => {
  // created_at and indexed_at are seeded in OPPOSITE orders, so a test that
  // asserts recency cannot be satisfied by both columns at once (spec D5/P4).
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations,created_at) VALUES
    (${sortNet.item_network},'provider','profile_1.0',${G_NEAR},'{"service_details":"solar installation"}','[{"lat":12.98,"lng":77.59}]','2026-01-01T00:00:00Z'),
    (${sortNet.item_network},'provider','profile_1.0',${G_FAR},'{"service_details":"solar rooftop retrofit"}','[{"lat":28.61,"lng":77.21}]','2026-06-01T00:00:00Z'),
    (${sortNet.item_network},'provider','profile_1.0',${G_NOLOC},'{"service_details":"borewell drilling"}','[]','2026-03-01T00:00:00Z')`;
  const repo = new ItemSearchRepo(sql, N);
  await repo.upsert({ ...sortNet, item_id: G_NEAR, embedding: vec(1), locations: [{ lat: 12.98, lng: 77.59 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'g-near' });
  await repo.upsert({ ...sortNet, item_id: G_FAR, embedding: vec(0), locations: [{ lat: 28.61, lng: 77.21 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'g-far' });
  await repo.upsert({ ...sortNet, item_id: G_NOLOC, embedding: vec(0), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'g-noloc' });
  await sql`UPDATE item_search SET indexed_at = '2026-06-01T00:00:00Z' WHERE item_id = ${G_NEAR}`;
  await sql`UPDATE item_search SET indexed_at = '2026-01-01T00:00:00Z' WHERE item_id = ${G_FAR}`;
});

describe('searchItems — explicit sort (contract §3)', () => {
  it('newest orders by items.created_at DESC, not item_search.indexed_at', async () => {
    // G_NEAR is OLDER by created_at but NEWER by indexed_at, so only one of the
    // two candidate columns can satisfy this. Guards spec D5 / P4.
    const { rows } = await searchItems(sql, { ...sortNet, filters: [], limit: 10, offset: 0, sort: 'newest' });
    const seen = rows.map((r) => r.item_id);
    expect(seen.indexOf(G_FAR)).toBeLessThan(seen.indexOf(G_NEAR));
  });

  it('nearest orders by distance and adds NO radius filter', async () => {
    // The far row must still be RETURNED. Ordering by location must not truncate.
    const { rows, total } = await searchItems(sql, {
      ...sortNet, filters: [], limit: 10, offset: 0,
      sort: 'nearest', orderingCenter: CENTRE,
    });
    // G_FAR is ~1740 km out, far outside the 30 km default radius.
    expect(rows.some((r) => (r.distanceMeters ?? 0) > 1_000_000)).toBe(true);
    expect(total).toBe(rows.length);
    const ds = rows.map((r) => r.distanceMeters ?? Number.POSITIVE_INFINITY);
    expect([...ds].sort((a, b) => a - b)).toEqual(ds); // ascending
  });

  it('nearest puts location-less rows last, not first', async () => {
    const { rows } = await searchItems(sql, {
      ...sortNet, filters: [], limit: 20, offset: 0,
      sort: 'nearest', orderingCenter: CENTRE,
    });
    const firstNull = rows.findIndex((r) => r.distanceMeters == null);
    expect(firstNull).toBeGreaterThan(-1); // G_NOLOC is in the set at all
    expect(rows.slice(firstNull).every((r) => r.distanceMeters == null)).toBe(true);
  });

  it('a spatial FILTER still truncates, unchanged', async () => {
    const { rows } = await searchItems(sql, {
      ...sortNet, filters: [], limit: 20, offset: 0, sort: 'nearest',
      spatial: { ...CENTRE, distanceMeters: 30_000 },
    });
    expect(rows.map((r) => r.item_id)).toEqual([G_NEAR]);
    expect(rows.every((r) => (r.distanceMeters ?? 0) <= 30_000)).toBe(true);
  });

  it('relevance falls back to recency when no vector was supplied', async () => {
    // Defence in depth: resolveSort should never route here, so this only
    // asserts the branch degrades sanely rather than erroring or ordering
    // by a NULL expression.
    const { rows } = await searchItems(sql, { ...sortNet, filters: [], limit: 10, offset: 0, sort: 'relevance' });
    const seen = rows.map((r) => r.item_id);
    expect(seen.indexOf(G_FAR)).toBeLessThan(seen.indexOf(G_NEAR));
  });

  it('an absent sort preserves the inferred recency path (indexed_at), unchanged', async () => {
    // Backward compatibility: no sort ⇒ today's behaviour exactly. G_NEAR is
    // newer by indexed_at, so it must lead here — the opposite of `newest`.
    const { rows } = await searchItems(sql, { ...sortNet, filters: [], limit: 10, offset: 0 });
    const seen = rows.map((r) => r.item_id);
    expect(seen.indexOf(G_NEAR)).toBeLessThan(seen.indexOf(G_FAR));
  });
});

// ---------------------------------------------------------------------------
// bbox viewport filter (#644 "search this area"). Its own item_network again,
// so the assertions above are untouched. Points sit exactly ON each edge,
// because edge semantics are the whole question: a viewport filter that drops
// a pin the user could see on the map edge is the bug this replaces.
// ---------------------------------------------------------------------------

const bboxNet = { item_network: 'teal_dot', item_domain: 'provider', item_type: 'profile_1.0', sourceUpdatedAtEpoch: '1700000000' };
const BOX = { minLat: 12.9, minLng: 77.5, maxLat: 13.0, maxLng: 77.7 };
const B_IN = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const B_OUT = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const B_N = 'cccccccc-0000-4000-8000-0000000000b3';  // exactly on maxLat
const B_S = 'dddddddd-0000-4000-8000-0000000000b4';  // exactly on minLat
const B_E = 'eeeeeeee-0000-4000-8000-0000000000b5';  // exactly on maxLng
const B_W = 'ffffffff-0000-4000-8000-0000000000b6';  // exactly on minLng
const B_NOLOC = '99999999-0000-4000-8000-0000000000b7';

beforeAll(async () => {
  const pts: [string, { lat: number; lng: number }[]][] = [
    [B_IN, [{ lat: 12.95, lng: 77.6 }]],
    [B_OUT, [{ lat: 13.5, lng: 78.5 }]],
    [B_N, [{ lat: 13.0, lng: 77.6 }]],
    [B_S, [{ lat: 12.9, lng: 77.6 }]],
    [B_E, [{ lat: 12.95, lng: 77.7 }]],
    [B_W, [{ lat: 12.95, lng: 77.5 }]],
    [B_NOLOC, []],
  ];
  const repo = new ItemSearchRepo(sql, N);
  for (const [id, locs] of pts) {
    await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_locations)
      VALUES (${bboxNet.item_network},'provider','profile_1.0',${id},
              ${sql.json(locs as unknown as Parameters<typeof sql.json>[0])})`;
    await repo.upsert({ ...bboxNet, item_id: id, embedding: vec(1), locations: locs, lifecycleStatus: 'live', modelVersion: 'm', contentHash: id });
  }
});

describe('searchItems — bbox viewport filter', () => {
  const run = (extra: Record<string, unknown> = {}) =>
    searchItems(sql, { ...bboxNet, filters: [], limit: 50, offset: 0, ...extra });

  it('includes a point inside and excludes one outside', async () => {
    const { rows } = await run({ bbox: BOX });
    const ids = rows.map((r) => r.item_id);
    expect(ids).toContain(B_IN);
    expect(ids).not.toContain(B_OUT);
  });

  it('includes a point on EVERY edge — the viewport is boundary-inclusive', async () => {
    const { rows } = await run({ bbox: BOX });
    const ids = rows.map((r) => r.item_id);
    expect(ids).toContain(B_N);
    expect(ids).toContain(B_S);
    expect(ids).toContain(B_E);
    expect(ids).toContain(B_W);
  });

  it('excludes location-less rows, since they cannot be in any viewport', async () => {
    const { rows } = await run({ bbox: BOX });
    expect(rows.map((r) => r.item_id)).not.toContain(B_NOLOC);
  });

  it('returns exactly the five in-box rows and a matching total', async () => {
    const { rows, total } = await run({ bbox: BOX });
    expect(rows.map((r) => r.item_id).sort()).toEqual([B_IN, B_N, B_S, B_E, B_W].sort());
    expect(total).toBe(5);
  });

  it('absent bbox is unchanged — every row in the network comes back', async () => {
    const { total } = await run();
    expect(total).toBe(7);
  });

  it('filters membership without touching ordering, and adds no distance', async () => {
    // A bbox is a WHERE predicate, not a centre: no distanceMeters appears,
    // and `newest` still orders by created_at.
    const { rows } = await run({ bbox: BOX, sort: 'newest' });
    expect(rows.every((r) => r.distanceMeters === undefined)).toBe(true);
    expect(rows.length).toBe(5);
  });

  it('composes with an explicit orderingCenter: bbox filters, centre orders', async () => {
    const { rows } = await run({ bbox: BOX, sort: 'nearest', orderingCenter: { lat: 12.9, lng: 77.5 } });
    expect(rows).toHaveLength(5); // still only the in-box rows
    const ds = rows.map((r) => r.distanceMeters ?? Number.POSITIVE_INFINITY);
    expect([...ds].sort((a, b) => a - b)).toEqual(ds); // nearest-first
    expect(rows[0].item_id).toBe(B_W); // the corner the centre sits on
  });
});

describe('searchItems — bbox wider than a hemisphere', () => {
  // Regression: the geography `&&` prefilter is only valid below a hemisphere.
  // Past that a geography polygon's edges take the SHORTER great-circle arc, so
  // the envelope inverts and the prefilter excluded everything; and an exactly
  // antipodal edge made the cast THROW, i.e. a 500 rather than an empty page.
  // teal_dot has 6 located rows (all in/near Bengaluru) and 1 with no location.
  const LOCATED = [B_IN, B_OUT, B_N, B_S, B_E, B_W];
  const run = (bbox: Record<string, number>) =>
    searchItems(sql, { ...bboxNet, filters: [], limit: 50, offset: 0, bbox: bbox as never });

  it('a 358° longitude span returns every located row instead of none', async () => {
    const { rows } = await run({ minLat: -85, minLng: -179, maxLat: 85, maxLng: 179 });
    expect(rows.map((r) => r.item_id).sort()).toEqual([...LOCATED].sort());
  });

  it('a longitude span of exactly 180° still works (the safe boundary)', async () => {
    const { rows } = await run({ minLat: -85, minLng: -90, maxLat: 85, maxLng: 90 });
    expect(rows.map((r) => r.item_id).sort()).toEqual([...LOCATED].sort());
  });

  it('the whole globe (±90 / ±180) returns rows rather than throwing', async () => {
    // Pole-to-pole latitude makes the meridian edges exactly antipodal, which
    // errored on the geography cast.
    const { rows } = await run({ minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 });
    expect(rows.map((r) => r.item_id).sort()).toEqual([...LOCATED].sort());
  });

  it('a 180° longitude span with an edge on the equator does not throw', async () => {
    // The horizontal edge from (-90, 0) to (90, 0) is antipodal.
    const { rows } = await run({ minLat: 0, minLng: -90, maxLat: 30, maxLng: 90 });
    expect(rows.map((r) => r.item_id).sort()).toEqual([...LOCATED].sort());
  });

  it('a wide box still EXCLUDES a row with no location', async () => {
    const { rows } = await run({ minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 });
    expect(rows.map((r) => r.item_id)).not.toContain(B_NOLOC);
  });

  it('a realistic viewport is unaffected', async () => {
    const { rows } = await run({ minLat: 12.9, minLng: 77.5, maxLat: 13.0, maxLng: 77.7 });
    expect(rows.map((r) => r.item_id).sort()).toEqual([B_IN, B_N, B_S, B_E, B_W].sort());
  });
});
