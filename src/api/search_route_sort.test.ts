import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveSort, resolveOrderingCenter } from './search_route.js';
import { startSearchApp, oneHot, type SearchApp } from '../../test/support/search_app.js';

const base = { hasAnchor: false, hasText: false, hasCenter: false, hasSpatialFilter: false };

describe('resolveSort — explicit requests', () => {
  it('honours relevance when an anchor is present', () => {
    expect(resolveSort({ ...base, requested: 'relevance', hasAnchor: true })).toBe('relevance');
  });

  it('honours relevance when only text is present', () => {
    expect(resolveSort({ ...base, requested: 'relevance', hasText: true })).toBe('relevance');
  });

  it('falls back to newest for relevance with neither anchor nor text', () => {
    expect(resolveSort({ ...base, requested: 'relevance' })).toBe('newest');
  });

  it('honours nearest when a centre resolves', () => {
    expect(resolveSort({ ...base, requested: 'nearest', hasCenter: true })).toBe('nearest');
  });

  it('falls back to newest for nearest with no centre', () => {
    expect(resolveSort({ ...base, requested: 'nearest' })).toBe('newest');
  });

  it('always honours newest', () => {
    expect(resolveSort({ ...base, requested: 'newest' })).toBe('newest');
  });
});

describe('resolveSort — inferred (no sort requested), preserving today’s behaviour', () => {
  it('infers relevance from an anchor', () => {
    expect(resolveSort({ ...base, hasAnchor: true })).toBe('relevance');
  });

  it('infers relevance from text', () => {
    expect(resolveSort({ ...base, hasText: true })).toBe('relevance');
  });

  it('infers nearest from a spatial filter when there is no query vector', () => {
    expect(resolveSort({ ...base, hasSpatialFilter: true, hasCenter: true })).toBe('nearest');
  });

  it('prefers the query vector over a spatial filter, as today', () => {
    expect(resolveSort({ ...base, hasAnchor: true, hasSpatialFilter: true, hasCenter: true })).toBe('relevance');
  });

  it('infers newest with no signals at all', () => {
    expect(resolveSort(base)).toBe('newest');
  });
});

describe('resolveOrderingCenter — contract §1.3 precedence', () => {
  const none = { anchorLat: null, anchorLng: null };

  it('prefers an explicit orderingCenter over everything, converting [lng, lat]', () => {
    expect(resolveOrderingCenter({
      explicit: { coordinates: [77.59, 12.97] },
      spatialFilter: { lat: 1, lng: 2 },
      anchorLat: 3, anchorLng: 4,
    })).toEqual({ lat: 12.97, lng: 77.59 });
  });

  it('falls back to the spatial filter’s own centre', () => {
    expect(resolveOrderingCenter({
      spatialFilter: { lat: 1, lng: 2 }, anchorLat: 3, anchorLng: 4,
    })).toEqual({ lat: 1, lng: 2 });
  });

  it('falls back to the anchor’s stored location', () => {
    expect(resolveOrderingCenter({ ...none, anchorLat: 3, anchorLng: 4 })).toEqual({ lat: 3, lng: 4 });
  });

  it('returns undefined when nothing resolves, so nearest degrades to newest', () => {
    expect(resolveOrderingCenter(none)).toBeUndefined();
  });

  it('treats a partially-known anchor location as no location', () => {
    expect(resolveOrderingCenter({ anchorLat: 3, anchorLng: null })).toBeUndefined();
    expect(resolveOrderingCenter({ anchorLat: null, anchorLng: 4 })).toBeUndefined();
  });

  it('accepts a 0,0 anchor location rather than treating it as absent', () => {
    // Null Island is a valid point; a truthiness check here would drop it.
    expect(resolveOrderingCenter({ anchorLat: 0, anchorLng: 0 })).toEqual({ lat: 0, lng: 0 });
  });
});

// ---------------------------------------------------------------------------
// Route-level cases. These boot a real Postgres (Testcontainers) and assert the
// order the service REPORTS, which is the half of the contract a client can see.
// ---------------------------------------------------------------------------

const RAW = 'sk_signals_sort_test_key_abcdefghijklmno';
const net = 'purple_dot';
// Bengaluru — the ordering centre used throughout.
const CENTRE: [number, number] = [77.59, 12.97];
const P_NEAR = 'aaaaaaaa-0000-4000-8000-00000000000a'; // ~1 km from CENTRE
const P_FAR = 'bbbbbbbb-0000-4000-8000-00000000000b';  // Delhi, ~1740 km
const P_NOLOC = 'cccccccc-0000-4000-8000-00000000000c'; // no location at all
const ANCHOR = 'dddddddd-0000-4000-8000-00000000000d';  // seeker anchor

let harness: SearchApp;

beforeAll(async () => {
  harness = await startSearchApp({ apiKey: RAW });
  const { sql, repo } = harness;

  // sql.json(), never `${JSON.stringify(x)}::jsonb` — the latter is sent as a
  // text param and the cast re-parses it into a jsonb STRING scalar, so
  // item_state comes back as a string and the response fails serialization.
  // Same trap as the `contains` filter operator (see CLAUDE.md).
  const jsonb = (v: unknown) => sql.json(v as Parameters<typeof sql.json>[0]);

  const seed = async (
    id: string,
    domain: string,
    state: Record<string, unknown>,
    locations: { lat: number; lng: number }[],
    seedVec: number,
    createdAt: string,
  ) => {
    await sql`INSERT INTO items (item_network, item_domain, item_type, item_id, item_state, item_locations, created_at)
      VALUES (${net}, ${domain}, 'profile_1.0', ${id}, ${jsonb(state)}, ${jsonb(locations)}, ${createdAt}::timestamptz)`;
    await repo.upsert({
      item_network: net, item_domain: domain, item_type: 'profile_1.0', item_id: id,
      embedding: oneHot(seedVec), locations, lifecycleStatus: 'live',
      modelVersion: 'm', contentHash: id, sourceUpdatedAtEpoch: '1700000000',
    });
  };

  // created_at is explicit so `newest` has a defined expected order:
  // P_NOLOC (Mar) is newest, then P_FAR (Feb), then P_NEAR (Jan).
  await seed(P_NEAR, 'provider', { service_details: 'solar installation' }, [{ lat: 12.98, lng: 77.59 }], 1, '2026-01-01T00:00:00Z');
  await seed(P_FAR, 'provider', { service_details: 'solar rooftop retrofit' }, [{ lat: 28.61, lng: 77.21 }], 2, '2026-02-01T00:00:00Z');
  await seed(P_NOLOC, 'provider', { service_details: 'borewell drilling' }, [], 3, '2026-03-01T00:00:00Z');
  // seeker → provider is a permitted interaction in the purple_dot fixture.
  await seed(ANCHOR, 'seeker', { needs: 'solar installation' }, [{ lat: 12.97, lng: 77.59 }], 1, '2026-01-01T00:00:00Z');
}, 180_000);

afterAll(async () => { await harness?.stop(); });

type Body = {
  message: {
    items: { item_id: string; distanceMeters?: number; score?: number }[];
    meta: { total: number; sort_applied: string };
  };
};

async function search(intent: Record<string, unknown>): Promise<Body> {
  const res = await harness.app.inject({
    method: 'POST', url: '/v1/search',
    headers: { 'x-api-key': RAW },
    payload: {
      context: { version: '1.0.0', messageId: `m-${JSON.stringify(intent)}`, networkId: net, domain: 'provider', itemType: 'profile_1.0' },
      message: { intent, pagination: { limit: 5, offset: 0 } },
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Body;
}

describe('route — meta.sort_applied (contract §2)', () => {
  it('reports newest when relevance was requested with no anchor and no text', async () => {
    const body = await search({ sort: 'relevance' });
    expect(body.message.meta.sort_applied).toBe('newest');
  });

  it('reports nearest when a centre was supplied', async () => {
    const body = await search({ sort: 'nearest', orderingCenter: { type: 'Point', coordinates: CENTRE } });
    expect(body.message.meta.sort_applied).toBe('nearest');
  });

  it('reports newest when nearest was requested with no centre', async () => {
    const body = await search({ sort: 'nearest' });
    expect(body.message.meta.sort_applied).toBe('newest');
  });

  it('reports a sort even when none was requested', async () => {
    const body = await search({});
    expect(['relevance', 'newest', 'nearest']).toContain(body.message.meta.sort_applied);
  });

  it('does not share a cache entry between two sorts (placement guard)', async () => {
    // Same everything except `sort`. If sort had been placed outside `intent`,
    // the second call would be served the first call's cached order.
    const a = await search({ sort: 'newest' });
    const b = await search({ sort: 'nearest', orderingCenter: { type: 'Point', coordinates: CENTRE } });
    expect(a.message.meta.sort_applied).toBe('newest');
    expect(b.message.meta.sort_applied).toBe('nearest');
  });

  it('an anchor-only search still reports no distances (ordering centre must not leak into the payload)', async () => {
    // Backward compatibility: the anchor's own location is a CANDIDATE ordering
    // centre (contract §1.3), but with the applied sort `relevance` nothing is
    // ordered by distance, so distanceMeters must stay absent exactly as before.
    const body = await search({ item: { id: ANCHOR } });
    expect(body.message.meta.sort_applied).toBe('relevance');
    expect(body.message.items.every((i) => i.distanceMeters === undefined)).toBe(true);
  });
});

describe('route — the applied sort actually orders the results (contract §3)', () => {
  it('nearest returns the FAR row too: ordering by location must not truncate', async () => {
    const body = await search({ sort: 'nearest', orderingCenter: { type: 'Point', coordinates: CENTRE } });
    const ids = body.message.items.map((i) => i.item_id);
    // P_FAR is ~1740 km out, far beyond the 30 km default radius a filter
    // would have applied. It must still be present, and ordered after P_NEAR.
    expect(ids).toContain(P_FAR);
    expect(ids.indexOf(P_NEAR)).toBeLessThan(ids.indexOf(P_FAR));
    expect(body.message.meta.total).toBe(3);
    expect(body.message.items.some((i) => (i.distanceMeters ?? 0) > 1_000_000)).toBe(true);
  });

  it('nearest puts the location-less row last', async () => {
    const body = await search({ sort: 'nearest', orderingCenter: { type: 'Point', coordinates: CENTRE } });
    const ids = body.message.items.map((i) => i.item_id);
    expect(ids[ids.length - 1]).toBe(P_NOLOC);
  });

  it('newest orders by created_at DESC', async () => {
    const body = await search({ sort: 'newest' });
    expect(body.message.items.map((i) => i.item_id)).toEqual([P_NOLOC, P_FAR, P_NEAR]);
  });

  it('a spatial FILTER still truncates while nearest orders', async () => {
    // spatial keeps its meaning: it filters. Only P_NEAR is within 30 km.
    const body = await search({
      sort: 'nearest',
      spatial: [{ op: 's_dwithin', geometry: { type: 'Point', coordinates: CENTRE }, distanceMeters: 30000 }],
    });
    expect(body.message.items.map((i) => i.item_id)).toEqual([P_NEAR]);
    expect(body.message.meta.sort_applied).toBe('nearest');
  });
});

describe('cross-repo contract fixture (wire-contract §9)', () => {
  // The exact fixture Signals-DPG asserts from the client side. Both repos
  // check it independently, so a divergence in field names or semantics fails
  // a test here rather than only on the dev cluster — every Signals-DPG test
  // mocks this service, so nothing else would catch it.
  it('anchor + text + nearest + orderingCenter behaves exactly as contracted', async () => {
    const body = await search({
      item: { id: ANCHOR },
      textSearch: 'solar',
      sort: 'nearest',
      orderingCenter: { type: 'Point', coordinates: CENTRE },
    });
    const ids = body.message.items.map((i) => i.item_id);

    // 1. No ST_DWithin predicate: `nearest` orders, it must never filter. The
    //    ~1740 km row survives, far outside any default radius.
    expect(ids).toContain(P_FAR);
    expect(body.message.items.some((i) => (i.distanceMeters ?? 0) > 1_000_000)).toBe(true);

    // 2. Ordered by distance, nearest first.
    expect(ids).toEqual([P_NEAR, P_FAR]);

    // 3. Text applied as a WHERE predicate — P_NOLOC ("borewell drilling")
    //    is excluded — while the anchor remains the query vector, so every
    //    row still carries a cosine score.
    expect(ids).not.toContain(P_NOLOC);
    expect(body.message.meta.total).toBe(2);
    expect(body.message.items.every((i) => i.score != null)).toBe(true);

    // 4. The applied sort is reported, and it is the one requested.
    expect(body.message.meta.sort_applied).toBe('nearest');
  });
});

describe('route — bbox viewport filter on the wire', () => {
  // A box around Bengaluru: contains P_NEAR, excludes P_FAR (Delhi) and the
  // location-less row.
  const BOX = { op: 'bbox', minLat: 12.9, minLng: 77.5, maxLat: 13.05, maxLng: 77.7 };

  it('filters to the viewport, end to end', async () => {
    const body = await search({ spatial: [BOX] });
    expect(body.message.items.map((i) => i.item_id)).toEqual([P_NEAR]);
    expect(body.message.meta.total).toBe(1);
  });

  it('adds no distanceMeters — a bbox is membership, not a centre', async () => {
    const body = await search({ spatial: [BOX] });
    expect(body.message.items.every((i) => i.distanceMeters === undefined)).toBe(true);
  });

  it('nearest with a bbox but no orderingCenter degrades to newest', async () => {
    // A viewport deliberately does NOT supply an ordering centre: using its
    // midpoint would make "search this area" silently change the sort. A caller
    // wanting nearest-first inside a viewport sends orderingCenter too.
    const body = await search({ spatial: [BOX], sort: 'nearest' });
    expect(body.message.meta.sort_applied).toBe('newest');
  });

  it('bbox filters while an explicit orderingCenter orders', async () => {
    const body = await search({
      spatial: [BOX],
      sort: 'nearest',
      orderingCenter: { type: 'Point', coordinates: CENTRE },
    });
    expect(body.message.meta.sort_applied).toBe('nearest');
    expect(body.message.items.map((i) => i.item_id)).toEqual([P_NEAR]); // still viewport-bound
  });

  it('a bbox with an orderingCenter and NO sort reports newest, not nearest', async () => {
    // The inferred SQL branch orders by distance only for an s_dwithin radius;
    // a bbox filters without ordering. Counting the bbox as a spatial filter
    // made meta.sort_applied claim `nearest` over an indexed_at-ordered page.
    const body = await search({ spatial: [BOX], orderingCenter: { type: 'Point', coordinates: CENTRE } });
    expect(body.message.meta.sort_applied).toBe('newest');
  });

  it('400s when a bbox and a radius clause are both supplied', async () => {
    const res = await harness.app.inject({
      method: 'POST', url: '/v1/search',
      headers: { 'x-api-key': RAW },
      payload: {
        context: { version: '1.0.0', messageId: 'both', networkId: net, domain: 'provider', itemType: 'profile_1.0' },
        message: {
          intent: { spatial: [BOX, { op: 's_dwithin', geometry: { type: 'Point', coordinates: CENTRE }, distanceMeters: 5000 }] },
          pagination: { limit: 5, offset: 0 },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });
});
