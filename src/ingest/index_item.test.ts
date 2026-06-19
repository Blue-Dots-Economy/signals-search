import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { indexItem } from './index_item.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
let repo: ItemSearchRepo;

const key = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: '5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf' };
const fields = [{ path: 'service_details', weight: 1 }];
const fakeEmbedder = { embed: async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.03125)) };

beforeAll(async () => {
  pg = await startPostgres();
  await runMigrations(pg.getConnectionUri());
  sql = sqlClient(pg.getConnectionUri());
  repo = new ItemSearchRepo(sql, 1024);
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

const item = {
  ...key,
  item_state: { service_details: 'speech therapy' },
  item_locations: [{ lat: 12.93, lng: 77.62 }],
  lifecycle_status: 'live',
};

describe('indexItem', () => {
  it('embeds + upserts when content changed', async () => {
    const res = await indexItem({ item, fields, embedder: fakeEmbedder, repo, modelVersion: 'm@1024' });
    expect(res.action).toBe('indexed');
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM item_search WHERE item_id = ${key.item_id}`;
    expect(rows[0].n).toBe(1);
  });

  it('skips re-embedding when content hash unchanged', async () => {
    let calls = 0;
    const countingEmbedder = { embed: async (t: string[]) => { calls++; return t.map(() => Array.from({ length: 1024 }, () => 0.03125)); } };
    const res = await indexItem({ item, fields, embedder: countingEmbedder, repo, modelVersion: 'm@1024' });
    expect(res.action).toBe('skipped');
    expect(calls).toBe(0);
  });

  it('indexes geo-only (no embed call) when there is no vectorizable content', async () => {
    // Regression: an item with none of the vectorized fields populated serializes
    // to '' — embedding [''] makes TEI 413 ("inputs cannot be empty") and fails
    // the whole sweep. Such items must index with a NULL vector instead.
    let calls = 0;
    const countingEmbedder = { embed: async (t: string[]) => { calls++; return t.map(() => Array.from({ length: 1024 }, () => 0.03125)); } };
    const emptyContentItem = {
      item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0',
      item_id: '9c8b7a65-1111-4222-8333-444455556666',
      item_state: { provider_category: 'NGO' }, // `fields` is [service_details], absent here
      item_locations: [{ lat: 12.93, lng: 77.62 }],
      lifecycle_status: 'live',
    };
    const res = await indexItem({ item: emptyContentItem, fields, embedder: countingEmbedder, repo, modelVersion: 'm@1024' });
    expect(res.action).toBe('indexed');
    expect(calls).toBe(0); // embedder never called for empty text
    const rows = await sql<{ embedding: unknown; has_geo: boolean }[]>`
      SELECT embedding, geo IS NOT NULL AS has_geo FROM item_search WHERE item_id = ${emptyContentItem.item_id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].embedding).toBeNull();
    expect(rows[0].has_geo).toBe(true);
  });
});
