import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSearchApp, oneHot, type SearchApp } from '../../test/support/search_app.js';

// #148 regression. `textSearch` used to be silently DISCARDED whenever an
// anchor was present: the anchor supplied the query vector, and text only ever
// became a query vector, never a filter — so typing into the search box on a
// profile-anchored feed changed nothing at all. Text is now an additional WHERE
// predicate, ANDed with everything else, applied with or without an anchor.

let harness: SearchApp;

const RAW = 'sk_text_narrow_test_key_abcdefghijklmn';
const net = 'purple_dot';
const T_SOLAR = 'aaaaaaaa-0000-4000-8000-00000000000a';
const T_BORE = 'bbbbbbbb-0000-4000-8000-00000000000b';
const T_PLAIN = 'cccccccc-0000-4000-8000-00000000000c';
const ANCHOR = 'dddddddd-0000-4000-8000-00000000000d'; // seeker anchor
const ALL_PROVIDERS = [T_SOLAR, T_BORE, T_PLAIN];

beforeAll(async () => {
  harness = await startSearchApp({ apiKey: RAW });
  const { sql, repo } = harness;
  const jsonb = (v: unknown) => sql.json(v as Parameters<typeof sql.json>[0]);

  const seed = async (id: string, domain: string, state: Record<string, unknown>, seedVec: number) => {
    await sql`INSERT INTO items (item_network, item_domain, item_type, item_id, item_state)
      VALUES (${net}, ${domain}, 'profile_1.0', ${id}, ${jsonb(state)})`;
    await repo.upsert({
      item_network: net, item_domain: domain, item_type: 'profile_1.0', item_id: id,
      embedding: oneHot(seedVec), locations: [], lifecycleStatus: 'live',
      modelVersion: 'm', contentHash: id, sourceUpdatedAtEpoch: '1700000000',
    });
  };

  // The purple_dot fixture marks service_details and services_offered
  // `vectorize: true`; provider_category is declared but not vectorized, and
  // contact_phone is `private: true`.
  await seed(T_SOLAR, 'provider', {
    service_details: 'solar installation', services_offered: ['Solar', 'Training'],
    provider_category: 'NGO / Trust', contact_phone: '9990001111',
  }, 0);
  await seed(T_BORE, 'provider', {
    service_details: 'borewell drilling', services_offered: ['Drilling'],
    provider_category: 'Private',
  }, 1);
  await seed(T_PLAIN, 'provider', {
    service_details: 'general repairs', services_offered: [],
    provider_category: 'Private',
  }, 2);
  await seed(ANCHOR, 'seeker', { needs: 'solar installation' }, 0);
}, 180_000);

afterAll(async () => { await harness?.stop(); });

type Body = {
  message: {
    items: { item_id: string; score?: number }[];
    meta: { total: number; sort_applied: string };
  };
};

async function search(intent: Record<string, unknown>): Promise<Body> {
  const res = await harness.app.inject({
    method: 'POST', url: '/v1/search',
    headers: { 'x-api-key': RAW },
    payload: {
      context: { version: '1.0.0', messageId: `m-${JSON.stringify(intent)}`, networkId: net, domain: 'provider', itemType: 'profile_1.0' },
      message: { intent, pagination: { limit: 20, offset: 0 } },
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Body;
}

describe('#148 — typed search must narrow even when an anchor is present', () => {
  it('anchor + text returns a STRICTLY NARROWER set than anchor alone', async () => {
    const withoutText = await search({ item: { id: ANCHOR } });
    const withText = await search({ item: { id: ANCHOR }, textSearch: 'solar' });
    expect(withoutText.message.items).toHaveLength(ALL_PROVIDERS.length);
    expect(withText.message.items.length).toBeLessThan(withoutText.message.items.length);
    expect(withText.message.items.map((i) => i.item_id)).toEqual([T_SOLAR]);
  });

  it('anchor + text keeps the anchor as the ranking basis', async () => {
    const body = await search({ item: { id: ANCHOR }, textSearch: 'solar' });
    // A cosine score is present, i.e. the anchor's embedding still drove order.
    expect(body.message.items.every((i) => i.score != null)).toBe(true);
    expect(body.message.meta.sort_applied).toBe('relevance');
  });

  it('anchor + text matching nothing returns an EMPTY set, not the unfiltered feed', async () => {
    const body = await search({ item: { id: ANCHOR }, textSearch: 'zzzznomatch' });
    expect(body.message.items).toHaveLength(0);
    expect(body.message.meta.total).toBe(0);
  });

  it('text with NO anchor is unchanged — still the query vector, and now also narrows', async () => {
    const body = await search({ textSearch: 'solar' });
    expect(body.message.items.map((i) => i.item_id)).toEqual([T_SOLAR]);
    expect(body.message.items.every((i) => i.score != null)).toBe(true);
  });

  it('two requests differing only in textSearch return different results', async () => {
    const a = await search({ item: { id: ANCHOR }, textSearch: 'solar' });
    const b = await search({ item: { id: ANCHOR }, textSearch: 'borewell' });
    expect(a.message.items.map((i) => i.item_id)).toEqual([T_SOLAR]);
    expect(b.message.items.map((i) => i.item_id)).toEqual([T_BORE]);
  });

  it('matches an array-valued vectorize field via its serialized text (contract §4)', async () => {
    // Documented looseness: item_state->>'services_offered' yields
    // ["Solar","Training"] as text, so ILIKE matches against that form.
    const body = await search({ textSearch: 'Training' });
    expect(body.message.items.map((i) => i.item_id)).toEqual([T_SOLAR]);
  });

  it('does NOT match a declared-but-not-vectorized field', async () => {
    // provider_category is in the schema but has no `vectorize: true`, so it is
    // outside the searchable set — it is filterable via intent.filters instead.
    const body = await search({ textSearch: 'NGO / Trust' });
    expect(body.message.items).toHaveLength(0);
  });

  it('does NOT match a private field, so text search cannot enumerate PII', async () => {
    // contact_phone is `private: true`. vectorizeFields throws on a private
    // field, so it can never enter the searchable set — but assert the
    // behaviour directly, since this is the PII boundary.
    const body = await search({ textSearch: '9990001111' });
    expect(body.message.items).toHaveLength(0);
  });

  it('narrows in combination with a structured filter (both predicates AND)', async () => {
    const body = await search({
      textSearch: 'solar',
      filters: [{ op: 'eq', target: 'item_state.provider_category', value: 'Private' }],
    });
    // T_SOLAR matches the text but is an NGO / Trust, so the AND is empty.
    expect(body.message.items).toHaveLength(0);
  });
});
