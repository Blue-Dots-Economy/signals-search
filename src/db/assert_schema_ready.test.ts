import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations, assertSchemaReady } from './migrate.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let pg: StartedPostgreSqlContainer;
let url: string;

beforeAll(async () => { pg = await startPostgres(); url = pg.getConnectionUri(); });
afterAll(async () => { await pg?.stop(); });

describe('assertSchemaReady', () => {
  it('rejects with a clear message when item_search is missing', async () => {
    await expect(assertSchemaReady(url)).rejects.toThrow(/item_search/i);
  });
  it('resolves once the schema has been migrated', async () => {
    await runMigrations(url);
    await expect(assertSchemaReady(url)).resolves.toBeUndefined();
  });

  // Deploy-order guard (#122). Signals-DPG owns this DDL, so a worker can boot
  // against a database whose item_search predates `source_updated_at` — and every
  // sweep AND every upsert references that column. Without this check the worker
  // looks healthy while each sweep tick throws and each ingest message retries to
  // the DLQ; fail fast at boot with the actionable message instead.
  it('rejects when item_search predates the source_updated_at column', async () => {
    const sql = sqlClient(url);
    try {
      await sql`ALTER TABLE item_search DROP COLUMN source_updated_at`;
      await expect(assertSchemaReady(url)).rejects.toThrow(/source_updated_at/i);
    } finally {
      await sql`ALTER TABLE item_search ADD COLUMN IF NOT EXISTS source_updated_at timestamptz`;
      await sql.end();
    }
  });
});
