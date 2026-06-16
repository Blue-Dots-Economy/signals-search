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
});
