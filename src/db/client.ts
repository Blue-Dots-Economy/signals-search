import postgres, { type Sql } from 'postgres';

/**
 * pgvector settings applied to every API connection as Postgres STARTUP
 * options, so no code path can run a search without them and no per-query
 * `SET` can be forgotten by a new one.
 *
 * `hnsw.iterative_scan=strict_order` fixes SILENT TRUNCATION of deep relevance
 * pages. With it off (the pgvector default) an HNSW scan stops once its search
 * list is exhausted and simply returns fewer rows — no error, no plan fallback
 * — while the count query still reports the full total. Measured on 60 000 live
 * rows with real 1024-dim vectors, paging at limit 20:
 *
 *   offset      0 |  100 |  300 |  500 |  700 | 1000 | 2000+
 *   default    20 |   20 |   20 |    0 |    0 |    0 |    20
 *   strict     20 |   20 |   20 |   20 |   20 |   20 |    20
 *
 * Walking offsets 0..980 as 50 pages returned 391 of the expected 1000 rows on
 * the defaults (609 silently lost, no duplicates) versus a clean 1000/1000
 * partition with strict_order. The window is bounded on both sides: it opens
 * once offset+limit outruns `hnsw.ef_search` (default 40) and closes when the
 * corpus grows large enough that the planner abandons HNSW for a sequential
 * scan, which does return complete results. Its width therefore moves with
 * corpus size, which is exactly why this must not be left to chance.
 *
 * `strict_order` rather than `relaxed_order`: the relaxed variant is faster but
 * may emit rows slightly out of distance order, which would reintroduce
 * unstable paging by another route.
 *
 * `hnsw.max_scan_tuples` (default 20 000) is deliberately left alone — it was
 * measured not to bite, because the planner switches to a sequential scan long
 * before offset+limit approaches it (between offsets 1 000 and 2 000 on the
 * 60 000-row corpus); offsets 20 000 and 40 000 both returned full pages with
 * it at its default. On a corpus large enough to keep HNSW chosen past 20 000
 * it would start to matter.
 *
 * Safe on an older pgvector that does not define these GUCs: a DOTTED
 * (extension-namespaced) name is accepted as a placeholder rather than
 * rejected, so the connection still succeeds and the setting is ignored —
 * verified. An UNDOTTED unknown name is a FATAL connection error, so do not
 * add one here.
 */
const HNSW_CONNECTION_OPTIONS = '-c hnsw.iterative_scan=strict_order';

/**
 * The query API's Postgres pool. Separate from the ingestion worker's on
 * purpose: the worker writes `item_search` and never runs an ANN-ordered read,
 * so it needs none of the above.
 */
export function createApiSqlClient(databaseUrl: string, max = 8): Sql {
  return postgres(databaseUrl, {
    max,
    connection: { options: HNSW_CONNECTION_OPTIONS },
  });
}
