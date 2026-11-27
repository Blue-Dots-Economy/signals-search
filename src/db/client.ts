import postgres, { type Sql } from 'postgres';

/**
 * pgvector settings applied to every API connection as Postgres startup
 * options, so no search can run without them.
 *
 * `hnsw.iterative_scan=strict_order` stops HNSW scans from silently returning
 * short or empty pages once offset+limit outruns `hnsw.ef_search`.
 * `relaxed_order` would emit rows slightly out of order and destabilise paging.
 *
 * A dotted (extension-namespaced) GUC is accepted as a placeholder on an older
 * pgvector that does not define it, so the connection still succeeds. An
 * undotted unknown name is a fatal connection error: do not add one here.
 *
 * Design: docs/architecture/search-ordering-and-paging.md
 */
const HNSW_CONNECTION_OPTIONS = '-c hnsw.iterative_scan=strict_order';

/**
 * The query API's Postgres pool. The worker uses its own pool without these
 * options because it never runs an ANN-ordered read.
 */
export function createApiSqlClient(databaseUrl: string, max = 8): Sql {
  return postgres(databaseUrl, {
    max,
    connection: { options: HNSW_CONNECTION_OPTIONS },
  });
}
