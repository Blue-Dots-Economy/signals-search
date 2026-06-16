import { describe, it, expect, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from './migrate.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let pg: StartedPostgreSqlContainer;
afterAll(async () => { await pg?.stop(); });

describe('runMigrations', () => {
  it('creates item_search with vector + geography columns', async () => {
    pg = await startPostgres();
    const url = pg.getConnectionUri();
    await runMigrations(url);
    const sql = sqlClient(url);
    const cols = await sql<{ column_name: string; udt_name: string }[]>`
      SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_name = 'item_search'`;
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.udt_name]));
    expect(byName['embedding']).toBe('vector');
    expect(byName['geo']).toBe('geography');
    await sql.end();
  });

  it('is idempotent (safe to run twice)', async () => {
    await expect(runMigrations(pg.getConnectionUri())).resolves.not.toThrow();
  });
});
