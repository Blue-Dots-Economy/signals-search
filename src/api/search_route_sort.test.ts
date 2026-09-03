import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveSort } from './search_route.js';
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
  ) => {
    await sql`INSERT INTO items (item_network, item_domain, item_type, item_id, item_state, item_locations)
      VALUES (${net}, ${domain}, 'profile_1.0', ${id}, ${jsonb(state)}, ${jsonb(locations)})`;
    await repo.upsert({
      item_network: net, item_domain: domain, item_type: 'profile_1.0', item_id: id,
      embedding: oneHot(seedVec), locations, lifecycleStatus: 'live',
      modelVersion: 'm', contentHash: id, sourceUpdatedAtEpoch: '1700000000',
    });
  };

  await seed(P_NEAR, 'provider', { service_details: 'solar installation' }, [{ lat: 12.98, lng: 77.59 }], 1);
  await seed(P_FAR, 'provider', { service_details: 'solar rooftop retrofit' }, [{ lat: 28.61, lng: 77.21 }], 2);
  await seed(P_NOLOC, 'provider', { service_details: 'borewell drilling' }, [], 3);
  // seeker → provider is a permitted interaction in the purple_dot fixture.
  await seed(ANCHOR, 'seeker', { needs: 'solar installation' }, [{ lat: 12.97, lng: 77.59 }], 1);
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
