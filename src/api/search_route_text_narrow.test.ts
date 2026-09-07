import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSearchApp, oneHot, type SearchApp } from '../../test/support/search_app.js';

// #148 regression. `textSearch` used to be silently DISCARDED whenever an
// anchor was present: the anchor supplied the query vector, and text only ever
// became a query vector, never a filter — so typing into the search box on a
// profile-anchored feed changed nothing at all. Text is now an additional WHERE
// predicate, ANDed with everything else.
//
// It applies ONLY when an anchor is present. With no anchor the text IS the
// query vector and must rank rather than filter — a literal predicate there
// would let cosine reorder only rows already containing the typed string,
// which deletes semantic recall on the main browse path.

let harness: SearchApp;

const RAW = 'sk_text_narrow_test_key_abcdefghijklmn';
const net = 'purple_dot';
const T_SOLAR = 'aaaaaaaa-0000-4000-8000-00000000000a';
const T_BORE = 'bbbbbbbb-0000-4000-8000-00000000000b';
const T_PLAIN = 'cccccccc-0000-4000-8000-00000000000c';
const T_PCT = 'eeeeeeee-0000-4000-8000-00000000000e';   // holds a literal '%'
const ANCHOR = 'dddddddd-0000-4000-8000-00000000000d'; // seeker anchor
const ALL_PROVIDERS = [T_SOLAR, T_BORE, T_PLAIN, T_PCT];

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
  // Deliberately contains no 'solar', so the assertions above are unaffected.
  await seed(T_PCT, 'provider', {
    service_details: 'battery 50% capacity', services_offered: [],
    provider_category: 'Private',
  }, 3);
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

  it('text with NO anchor RANKS but does not filter — semantic recall preserved', async () => {
    // Pre-#148 behaviour on this path, restored deliberately: the text becomes
    // the query vector, so every live row stays a candidate and cosine decides
    // the order. Narrowing here would gate an embedding search on a literal
    // substring.
    const body = await search({ textSearch: 'solar' });
    expect(body.message.items).toHaveLength(ALL_PROVIDERS.length);
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
    const body = await search({ item: { id: ANCHOR }, textSearch: 'Training' });
    expect(body.message.items.map((i) => i.item_id)).toEqual([T_SOLAR]);
  });

  it('does NOT match a declared-but-not-vectorized field', async () => {
    // provider_category is in the schema but has no `vectorize: true`, so it is
    // outside the searchable set — it is filterable via intent.filters instead.
    // Every term here is absent from the vectorized fields, so the AND is empty.
    const body = await search({ item: { id: ANCHOR }, textSearch: 'NGO / Trust' });
    expect(body.message.items).toHaveLength(0);
  });

  it('does NOT match a private field, so text search cannot enumerate PII', async () => {
    // contact_phone is `private: true`. vectorizeFields throws on a private
    // field, so it can never enter the searchable set — but assert the
    // behaviour directly, since this is the PII boundary.
    const body = await search({ item: { id: ANCHOR }, textSearch: '9990001111' });
    expect(body.message.items).toHaveLength(0);
  });

  it('narrows in combination with a structured filter (both predicates AND)', async () => {
    const body = await search({
      item: { id: ANCHOR },
      textSearch: 'solar',
      filters: [{ op: 'eq', target: 'item_state.provider_category', value: 'Private' }],
    });
    // T_SOLAR matches the text but is an NGO / Trust, so the AND is empty.
    expect(body.message.items).toHaveLength(0);
  });
});

describe('#148 follow-up — multi-word queries and semantic recall', () => {
  it('anchor + a TWO-WORD query matches an item whose words span two fields', async () => {
    // T_SOLAR has service_details 'solar installation' and services_offered
    // ['Solar','Training']. No single field contains the contiguous string
    // 'solar training', so a whole-query substring gate returns nothing.
    const body = await search({ item: { id: ANCHOR }, textSearch: 'solar training' });
    expect(body.message.items.map((i) => i.item_id)).toEqual([T_SOLAR]);
  });

  it('anchor + words in a different order than the stored text still matches', async () => {
    const body = await search({ item: { id: ANCHOR }, textSearch: 'installation solar' });
    expect(body.message.items.map((i) => i.item_id)).toEqual([T_SOLAR]);
  });

  it('anchor + multi-word still EXCLUDES an item missing one of the words', async () => {
    // Terms are ANDed, so 'solar drilling' matches neither T_SOLAR (no
    // drilling) nor T_BORE (no solar).
    const body = await search({ item: { id: ANCHOR }, textSearch: 'solar drilling' });
    expect(body.message.items).toHaveLength(0);
  });

  it('collapses extra whitespace rather than treating it as a term', async () => {
    const body = await search({ item: { id: ANCHOR }, textSearch: '  solar   training  ' });
    expect(body.message.items.map((i) => i.item_id)).toEqual([T_SOLAR]);
  });

  it('NO anchor: a semantically-related but literally-absent query still returns rows', async () => {
    // With no anchor, `q` IS the query vector, so it must RANK and not filter.
    // A literal gate here would delete semantic recall entirely — the opposite
    // of what an embedding search is for.
    const body = await search({ textSearch: 'renewable energy' });
    expect(body.message.items.length).toBeGreaterThan(0);
    expect(body.message.items.every((i) => i.score != null)).toBe(true);
  });

  it('NO anchor: a multi-word query does not collapse the result set to zero', async () => {
    const body = await search({ textSearch: 'solar training' });
    expect(body.message.items.length).toBeGreaterThan(0);
  });
});

describe('#148 follow-up — ILIKE metacharacters are literals, not wildcards', () => {
  it("a lone '_' matches only literal underscores, not every row", async () => {
    // Unescaped this is `%_%`, which matches any row with at least one
    // character — i.e. the whole feed, silently un-narrowing the search.
    const body = await search({ item: { id: ANCHOR }, textSearch: '_' });
    expect(body.message.items).toHaveLength(0);
  });

  it("a lone '%' matches only rows containing a literal percent sign", async () => {
    // Unescaped this is `%%%`, which matches everything.
    const body = await search({ item: { id: ANCHOR }, textSearch: '%' });
    expect(body.message.items.map((i) => i.item_id)).toEqual([T_PCT]);
  });

  it("'50%' narrows to the row that really says 50%", async () => {
    const body = await search({ item: { id: ANCHOR }, textSearch: '50%' });
    expect(body.message.items.map((i) => i.item_id)).toEqual([T_PCT]);
  });

  it('a backslash is treated as a literal too', async () => {
    const body = await search({ item: { id: ANCHOR }, textSearch: '\\' });
    expect(body.message.items).toHaveLength(0);
  });
});
