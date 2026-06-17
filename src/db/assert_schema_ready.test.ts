import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres } from '../../test/support/pg.js';
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
});
