import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { runSweep } from './sweep.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;

const fields = [{ path: 'service_details', weight: 1 }];
const fakeEmbedder = { embed: async (t: string[]) => t.map(() => Array.from({ length: 1024 }, () => 0.03125)) };

beforeAll(async () => {
  pg = await startPostgres();
  const url = pg.getConnectionUri();
  await runMigrations(url);
  sql = sqlClient(url);
  await sql`CREATE TABLE items (
    item_network text, item_domain text, item_type text, item_id uuid,
    item_state jsonb NOT NULL DEFAULT '{}', item_locations jsonb NOT NULL DEFAULT '[]',
    lifecycle_status text NOT NULL DEFAULT 'live', updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (item_network, item_domain, item_type, item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations) VALUES
    ('purple_dot','provider','profile_1.0','5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf',
     '{"service_details":"speech therapy"}','[{"lat":12.93,"lng":77.62}]')`;
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('runSweep', () => {
  it('indexes items missing from item_search', async () => {
    const repo = new ItemSearchRepo(sql, 1024);
    const n = await runSweep({ sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024', batchSize: 50 });
    expect(n).toBe(1);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM item_search`;
    expect(rows[0].n).toBe(1);
  });

  it('re-indexes items whose updated_at is newer than indexed_at', async () => {
    await sql`UPDATE items SET item_state = '{"service_details":"physiotherapy"}', updated_at = now() + interval '1 hour'`;
    const repo = new ItemSearchRepo(sql, 1024);
    const n = await runSweep({ sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024', batchSize: 50 });
    expect(n).toBe(1);
  });

  it('isolates a failing item — one bad item does not abort the batch', async () => {
    // The previous test left the base item with a future updated_at (now()+1h),
    // so it would stay perpetually stale and be re-selected here. Neutralize it
    // so this sweep only considers the two items inserted below.
    await sql`UPDATE items SET updated_at = now() - interval '1 hour'
      WHERE item_id = '5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf'`;
    await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations) VALUES
      ('purple_dot','provider','profile_1.0','11111111-1111-4111-8111-111111111111','{"service_details":"BOOM"}','[]'),
      ('purple_dot','provider','profile_1.0','22222222-2222-4222-8222-222222222222','{"service_details":"good one"}','[]')`;
    const repo = new ItemSearchRepo(sql, 1024);
    const flakyEmbedder = {
      embed: async (t: string[]) => {
        if (t.some((x) => x.includes('BOOM'))) throw new Error('embed boom');
        return t.map(() => Array.from({ length: 1024 }, () => 0.03125));
      },
    };
    // Must not throw despite the BOOM item failing; the good item still indexes.
    const n = await runSweep({ sql, repo, embedder: flakyEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024', batchSize: 50 });
    expect(n).toBe(1);
    const rows = await sql<{ item_id: string }[]>`
      SELECT item_id::text AS item_id FROM item_search
      WHERE item_id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')`;
    expect(rows.map((r) => r.item_id)).toEqual(['22222222-2222-4222-8222-222222222222']);
  });

  // #122. The staleness check must compare the VERSION that was indexed, not the
  // clock time of the index write. An update that lands while the embedder is in
  // flight is committed BEFORE the upsert but carries an EARLIER updated_at, so a
  // `now()`-stamped marker records the stale snapshot as newer than the fresh data
  // and the row is never re-selected. This is the signals-dpg#557 U18 flow exactly:
  // profile created `draft`, guardian consent promotes it to `live` mid-embed.
  it('re-selects an item whose lifecycle changed during the embed window', async () => {
    await sql`DELETE FROM item_search`;
    await sql`DELETE FROM items`;
    const raced = '33333333-3333-4333-8333-333333333333';
    await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,lifecycle_status) VALUES
      ('purple_dot','provider','profile_1.0',${raced},'{"service_details":"speech therapy"}','draft')`;
    const repo = new ItemSearchRepo(sql, 1024);

    // Promote the row to `live` while the embedder is in flight — the worker has
    // already read `draft` and will write that stale snapshot back.
    const promotingEmbedder = {
      embed: async (t: string[]) => {
        await sql`UPDATE items SET lifecycle_status = 'live', updated_at = now() WHERE item_id = ${raced}`;
        return t.map(() => Array.from({ length: 1024 }, () => 0.03125));
      },
    };
    await runSweep({ sql, repo, embedder: promotingEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024', batchSize: 50 });
    const [afterRace] = await sql<{ lifecycle_status: string }[]>`
      SELECT lifecycle_status FROM item_search WHERE item_id = ${raced}`;
    expect(afterRace.lifecycle_status).toBe('draft'); // the stale write we must recover from

    const n = await runSweep({ sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024', batchSize: 50 });
    expect(n).toBe(1);
    const [repaired] = await sql<{ lifecycle_status: string }[]>`
      SELECT lifecycle_status FROM item_search WHERE item_id = ${raced}`;
    expect(repaired.lifecycle_status).toBe('live');
  });

  // #122. A skip must still advance the marker. An `items` update that touches
  // nothing the content hash covers (a private-state-only edit, or a public field
  // that isn't vectorized) otherwise leaves the row matching the sweep predicate
  // forever — and `ORDER BY updated_at ASC LIMIT batchSize` puts those rows at the
  // head of every batch, where enough of them starve genuinely-new rows out.
  it('stops re-selecting a row once an update leaves the content hash unchanged', async () => {
    await sql`DELETE FROM item_search`;
    await sql`DELETE FROM items`;
    const unchanged = '44444444-4444-4444-8444-444444444444';
    await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state) VALUES
      ('purple_dot','provider','profile_1.0',${unchanged},'{"service_details":"speech therapy"}')`;
    const repo = new ItemSearchRepo(sql, 1024);
    await runSweep({ sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024', batchSize: 50 });

    // Bump updated_at without touching any hashed field — the sweep selects it once,
    // hits the skip path, and must then consider it settled.
    await sql`UPDATE items SET updated_at = now() + interval '1 hour' WHERE item_id = ${unchanged}`;
    const selected = await runSweep({ sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024', batchSize: 50 });
    expect(selected).toBe(1);

    const reselected = await runSweep({ sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024', batchSize: 50 });
    expect(reselected).toBe(0);
  });
});
