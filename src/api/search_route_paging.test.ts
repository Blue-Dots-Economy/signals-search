import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSearchApp, oneHot, type SearchApp } from '../../test/support/search_app.js';

// P1 regression (spec §3.4). SQL leaves tied rows unordered, and each page is
// an independent query whose LIMIT+OFFSET bound differs, so the planner can
// arrange a tie group differently between page N and page N+1 — duplicating
// some rows and never returning others. Every seeded row shares ONE created_at
// AND one indexed_at, so every ordering path hits the tie.

let harness: SearchApp;

const RAW = 'sk_paging_tiebreaker_test_key_abcdefgh';
const net = 'purple_dot';
// Tie-group size and page size. Six rows is enough to prove the ORDER BY is
// under-specified, but Postgres can still pick a coincidentally stable plan at
// that size; the group is deliberately large enough that the top-N heapsort
// bound differs meaningfully between page 1 and page 2.
const TIED = 200;
const LIMIT = 20;
const TIED_AT = '2026-01-15T10:00:00.000Z';

function id(i: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
}
const IDS = Array.from({ length: TIED }, (_, i) => id(i + 1));

beforeAll(async () => {
  harness = await startSearchApp({ apiKey: RAW });
  const { sql, repo } = harness;

  for (let i = 0; i < IDS.length; i++) {
    // Identical created_at across every row — the bulk-migration tie.
    await sql`INSERT INTO items (item_network, item_domain, item_type, item_id, created_at)
      VALUES (${net}, 'provider', 'profile_1.0', ${IDS[i]}, ${TIED_AT}::timestamptz)`;
    await repo.upsert({
      item_network: net, item_domain: 'provider', item_type: 'profile_1.0', item_id: IDS[i],
      embedding: oneHot(i), locations: [], lifecycleStatus: 'live',
      modelVersion: 'm', contentHash: `p${i}`, sourceUpdatedAtEpoch: '1700000000',
    });
  }
  // Force indexed_at to tie as well, so the inferred recency path also ties.
  await sql`UPDATE item_search SET indexed_at = ${TIED_AT}::timestamptz WHERE item_network = ${net}`;
}, 180_000);

afterAll(async () => { await harness?.stop(); });

async function page(offset: number, sort?: string): Promise<string[]> {
  const res = await harness.app.inject({
    method: 'POST', url: '/v1/search',
    headers: { 'x-api-key': RAW },
    payload: {
      context: { version: '1.0.0', messageId: `m${offset}-${sort}`, networkId: net, domain: 'provider', itemType: 'profile_1.0' },
      message: { intent: { ...(sort ? { sort } : {}) }, pagination: { limit: LIMIT, offset } },
    },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { message: { items: { item_id: string }[] } }).message.items.map((i) => i.item_id);
}

/** Walk every page of the tie group and return the concatenated ids. */
async function allPages(sort?: string): Promise<string[]> {
  const seen: string[] = [];
  for (let offset = 0; offset < TIED; offset += LIMIT) {
    seen.push(...(await page(offset, sort)));
  }
  return seen;
}

describe('P1 — paging over tied sort keys', () => {
  it('newest: pages partition the set with no duplicates and no omissions', async () => {
    const union = await allPages('newest');
    expect(union).toHaveLength(TIED);
    expect(new Set(union).size).toBe(TIED);            // no duplicates
    expect([...union].sort()).toEqual([...IDS].sort()); // no omissions
  });

  it('newest: repeated identical requests return an identical order', async () => {
    expect(await page(0, 'newest')).toEqual(await page(0, 'newest'));
  });

  it('inferred (no sort) path is also deterministic', async () => {
    const union = await allPages();
    expect(new Set(union).size).toBe(TIED);
    expect([...union].sort()).toEqual([...IDS].sort());
  });
});
