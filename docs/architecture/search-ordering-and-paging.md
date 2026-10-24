# Search ordering and deterministic paging

Code: `buildOrderBy` in `src/db/search_query.ts`; HNSW connection settings in `src/db/client.ts`.

## The `item_id` tiebreaker

SQL leaves tied rows unordered, and each page is an independent query with its own LIMIT/OFFSET, so the planner can arrange a tie group differently between page N and page N+1: some rows appear twice and others never. Measured on 200 rows sharing one `created_at` and one `indexed_at`, paging at limit 20 returned 197 distinct ids out of 200.

The distance and recency orderings therefore end in `s.item_id ASC`. It is unique per row, already in the composite primary key and already selected, and a sort only reads it inside a tie group. The geo path keeps the same Bitmap Index Scan on `item_search_geo_gist` with an identical plan.

## Why the cosine ordering has no tiebreaker

A second sort key makes pgvector's HNSW index unusable. The index scan supplies a pathkey only for the exact single-expression ordering, and being approximate it cannot promise complete tie groups, so Postgres cannot build an incremental sort over it either. Measured on 20k rows, appending `, s.item_id ASC` replaced an Index Scan using `item_search_embedding_hnsw` (2.8 ms) with a full Seq Scan plus top-N heapsort of every live row (316 ms): 115x slower and O(corpus). Disabling seqscan, hashjoin or mergejoin does not recover an HNSW plan.

The tiebreaker would buy almost nothing there. A cosine tie needs byte-identical embeddings, and HNSW traversal is deterministic for a fixed query vector, `ef_search` and index state. Measured with `hnsw.ef_search=500`: five pages at limit 20 (offsets 0/20/40/100/200) returned 100 distinct ids with no overlap, and each page was byte-identical across repeat calls and fresh connections.

## Recency key

Explicit `sort: 'newest'` orders by `items.created_at`, so a re-index or backfill does not reshuffle the feed. The inferred ordering (no `sort` sent) orders by `item_search.indexed_at`, so callers that send no `sort` see unchanged behaviour.

## HNSW iterative scan

With pgvector's defaults (`hnsw.iterative_scan` off, `hnsw.ef_search` 40) an HNSW scan stops once its search list is exhausted and returns fewer rows, with no error and no plan fallback, while the count query still reports the full total. Measured on 60 000 live rows with real 1024-dim vectors, paging at limit 20:

| offset | 0 | 100 | 300 | 500 | 700 | 1000 | 2000+ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default | 20 | 20 | 20 | 0 | 0 | 0 | 20 |
| `strict_order` | 20 | 20 | 20 | 20 | 20 | 20 | 20 |

Walking offsets 0..980 as 50 pages returned 391 of 1000 expected rows on the defaults and a clean 1000/1000 with `strict_order`. The window opens once offset+limit outruns `ef_search` and closes when the corpus is large enough that the planner abandons HNSW for a sequential scan, so its width moves with corpus size.

`createApiSqlClient` therefore sets `hnsw.iterative_scan=strict_order` as a Postgres startup option on every API connection. `relaxed_order` is faster but may emit rows slightly out of distance order, which would make paging unstable again.

`hnsw.max_scan_tuples` (default 20 000) is left at its default. On the 60 000-row corpus the planner switched to a sequential scan between offsets 1 000 and 2 000, long before offset+limit approached it, and offsets 20 000 and 40 000 returned full pages. It starts to matter only on a corpus large enough to keep HNSW chosen past 20 000.
