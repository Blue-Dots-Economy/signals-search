import { describe, it, expect, afterAll } from 'vitest';
import { startPostgres, sqlClient } from './pg.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let pg: StartedPostgreSqlContainer;

afterAll(async () => { await pg?.stop(); });

describe('test postgres image', () => {
  it('can create vector and postgis extensions', async () => {
    pg = await startPostgres();
    const sql = sqlClient(pg.getConnectionUri());
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
    const rows = await sql<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname IN ('vector','postgis')`;
    expect(rows.map((r) => r.extname).sort()).toEqual(['postgis', 'vector']);
    await sql.end();
  });
});
