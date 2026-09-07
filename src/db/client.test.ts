import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres } from '../../test/support/pg.js';
import { createApiSqlClient } from './client.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

// Guards the pgvector settings the query API depends on for COMPLETE deep
// relevance pages. Without hnsw.iterative_scan an HNSW scan silently returns
// fewer rows than asked for once its search list is exhausted — no error, no
// plan fallback — while the count query still reports the full total.
//
// This asserts the settings reach a real connection, which is the part that
// can regress: someone constructing the pool directly with `postgres(url)`
// again would lose them with nothing else failing. The end-to-end truncation
// itself is NOT reproduced here — it needs ~20k rows with 1024-dim vectors and
// an HNSW index, because the affected window only opens once the corpus is
// large enough that the planner keeps choosing HNSW past hnsw.ef_search. At
// 3 000 rows it switches to a sequential scan first and nothing truncates. The
// measurements live in the comment on createApiSqlClient and in the PR.

let pg: StartedPostgreSqlContainer;
let sql: Sql;

beforeAll(async () => {
  pg = await startPostgres();
  sql = createApiSqlClient(pg.getConnectionUri(), 2);
  // pgvector registers its GUCs when the library loads, which a vector
  // operation forces. Startup options are applied regardless, but SHOW cannot
  // read them back under their real definition until then.
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
}, 180_000);

afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('createApiSqlClient — pgvector connection settings', () => {
  it('applies hnsw.iterative_scan=strict_order to a real connection', async () => {
    // strict_order, never relaxed_order: the relaxed variant is faster but may
    // emit rows slightly out of distance order, which would reintroduce
    // unstable paging by another route.
    const [row] = await sql<{ s: string }[]>`SELECT current_setting('hnsw.iterative_scan') AS s`;
    expect(row.s).toBe('strict_order');
  });

  it('applies the setting to EVERY pooled connection, not just the first', async () => {
    // max=2, so run two overlapping queries and force both connections into
    // use. A per-query SET on one connection would leave the other unset.
    const [a, b] = await Promise.all([
      sql<Record<string, string>[]>`SELECT pg_sleep(0.05), current_setting('hnsw.iterative_scan') AS s`,
      sql<Record<string, string>[]>`SELECT pg_sleep(0.05), current_setting('hnsw.iterative_scan') AS s`,
    ]);
    expect(a[0].s).toBe('strict_order');
    expect(b[0].s).toBe('strict_order');
  });

  it('still connects when the server does not define the GUC (older pgvector)', async () => {
    // A dotted, extension-namespaced name is accepted as a placeholder rather
    // than rejected, so an older pgvector without iterative_scan does not turn
    // this into a FATAL connection error. Proven by connecting with a
    // namespaced setting that no extension defines.
    const probe = (await import('postgres')).default(pg.getConnectionUri(), {
      max: 1,
      connection: { options: '-c hnsw.definitely_not_a_real_setting=1' },
    });
    try {
      const [row] = await probe<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(row.ok).toBe(1);
    } finally {
      await probe.end();
    }
  });
});
