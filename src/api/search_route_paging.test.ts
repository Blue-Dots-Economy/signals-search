import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
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
// The six rows given searchable text for the rerank cases.
const TEXT_IDS = IDS.slice(0, 6);

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

  // Give the first six rows searchable text, so the P2 rerank cases below have
  // a narrowed candidate set larger than RESULT_TOPN. Row counts are unchanged,
  // so the paging assertions above are unaffected.
  await sql`UPDATE items SET item_state = ${sql.json({ service_details: 'solar installation' } as Parameters<typeof sql.json>[0])}
            WHERE item_network = ${net} AND item_id = ANY(${TEXT_IDS})`;
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

// ---------------------------------------------------------------------------
// P2 — rerank over-fetches `topN` rows from offset 0 and slices the requested
// page back out of that window. A request whose window falls OUTSIDE the band
// therefore returned an empty page under a full meta.total. The fix skips
// reranking for such a request and pages natively instead, degrading ranking
// quality at depth rather than losing the rows.
// ---------------------------------------------------------------------------

const RESULT_TOPN = 4;
let rerankApp: FastifyInstance;
let stub: Server;
let rerankCalls = 0;

beforeAll(async () => {
  // A real stub endpoint, not an unreachable URL: TeiReranker throws on a
  // failed fetch, so an unreachable host would 500 the shallow case and hide
  // whether reranking still happens for normal pages.
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      rerankCalls += 1;
      const { texts } = JSON.parse(body) as { texts: string[] };
      // Reverse the incoming order, so a rerank is observable in the output.
      const scored = texts.map((_t, i) => ({ index: i, score: i }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scored));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const { port } = stub.address() as AddressInfo;

  rerankApp = harness.buildWith({
    rerank: { model: 'r', defaultOn: true, baseUrl: `http://127.0.0.1:${port}`, topN: RESULT_TOPN },
  });
  await rerankApp.ready();
});

afterAll(async () => {
  await new Promise<void>((resolve) => stub?.close(() => resolve()));
});

async function rerankSearch(limit: number, offset: number) {
  const res = await rerankApp.inject({
    method: 'POST', url: '/v1/search',
    headers: { 'x-api-key': RAW },
    payload: {
      context: { version: '1.0.0', messageId: `p2-${limit}-${offset}`, networkId: net, domain: 'provider', itemType: 'profile_1.0' },
      message: { intent: { textSearch: 'solar' }, pagination: { limit, offset } },
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { message: { items: { item_id: string }[]; meta: { total: number } } };
}

describe('P2 — rerank must not truncate paging', () => {
  it('offset beyond topN returns real rows, not an empty page', async () => {
    // RESULT_TOPN=4, so offset 4 previously fell outside the over-fetched
    // window and returned [] while meta.total still reported the full count.
    const body = await rerankSearch(2, 4);
    expect(body.message.meta.total).toBe(TEXT_IDS.length);
    expect(body.message.meta.total).toBeGreaterThan(RESULT_TOPN);
    expect(body.message.items.length).toBeGreaterThan(0); // was 0 before the guard
  });

  it('a page inside the over-fetch window is still reranked', async () => {
    // The guard must not disable reranking for normal pages — that invariant
    // is the whole point of the shared over-fetch/slice predicate.
    const before = rerankCalls;
    const body = await rerankSearch(2, 0);
    expect(rerankCalls).toBeGreaterThan(before);
    expect(body.message.items).toHaveLength(2);
  });

  it('the deep page does NOT call the reranker', async () => {
    const before = rerankCalls;
    await rerankSearch(2, 4);
    expect(rerankCalls).toBe(before);
  });
});
