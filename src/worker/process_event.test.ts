import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { processEvent } from './process_event.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
const id = '5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf';
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
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state) VALUES
    ('purple_dot','provider','profile_1.0',${id},'{"service_details":"speech therapy"}')`;
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('processEvent', () => {
  it('upsert event indexes the item', async () => {
    const repo = new ItemSearchRepo(sql, 1024);
    await processEvent({
      event: { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: id, op: 'upsert', occurred_at: 'x' },
      sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024',
    });
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM item_search WHERE item_id = ${id}`;
    expect(rows[0].n).toBe(1);
  });

  it('delete event removes the item_search row', async () => {
    const repo = new ItemSearchRepo(sql, 1024);
    await processEvent({
      event: { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: id, op: 'delete', occurred_at: 'x' },
      sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024',
    });
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM item_search WHERE item_id = ${id}`;
    expect(rows[0].n).toBe(0);
  });
});
