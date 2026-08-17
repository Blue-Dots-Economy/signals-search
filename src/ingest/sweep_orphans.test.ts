import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { sweepOrphans } from './sweep.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
const N = 1024;
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', sourceUpdatedAtEpoch: '1700000000' };
const KEEP = '11111111-1111-1111-1111-111111111111';
const ORPHAN = '22222222-2222-2222-2222-222222222222';
function vec(seed: number) { const v = Array.from({ length: N }, () => 0); v[seed % N] = 1; return v; }

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri(); await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE items (item_network text,item_domain text,item_type text,item_id uuid,
    item_state jsonb NOT NULL DEFAULT '{}', item_locations jsonb NOT NULL DEFAULT '[]',
    lifecycle_status text NOT NULL DEFAULT 'live',
    PRIMARY KEY (item_network,item_domain,item_type,item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id) VALUES (${base.item_network},${base.item_domain},${base.item_type},${KEEP})`;
  const repo = new ItemSearchRepo(sql, N);
  await repo.upsert({ ...base, item_id: KEEP, embedding: vec(0), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'k' });
  await repo.upsert({ ...base, item_id: ORPHAN, embedding: vec(1), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'o' });
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('sweepOrphans', () => {
  it('deletes item_search rows with no matching items row and returns the count', async () => {
    const deleted = await sweepOrphans(sql);
    expect(deleted).toBe(1);
    const ids = await sql<{ item_id: string }[]>`SELECT item_id FROM item_search ORDER BY item_id`;
    expect(ids.map((r) => r.item_id)).toEqual([KEEP]);
  });
  it('is a no-op when there are no orphans', async () => {
    expect(await sweepOrphans(sql)).toBe(0);
  });
});
