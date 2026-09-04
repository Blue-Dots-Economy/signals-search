import type { Sql, PendingQuery, Row } from 'postgres';

export type FilterClause = { op: 'eq' | 'neq' | 'in' | 'contains' | 'contains_any' | 'gt' | 'gte' | 'lt' | 'lte'; target: string; value: unknown };
// Re-declared here rather than imported from the API layer: search_route.ts
// imports from this module and never the reverse, and that direction is worth
// preserving. The wire enum lives in api/schemas.ts.
export type SortMode = 'relevance' | 'newest' | 'nearest';

export type SearchParams = {
  item_network: string;
  item_domain: string;
  item_type: string;
  queryVector?: number[];
  /** ST_DWithin FILTER — decides membership. Unchanged. */
  spatial?: { lat: number; lng: number; distanceMeters: number };
  /**
   * Rectangular viewport FILTER — decides membership, exactly like `spatial`,
   * and mutually exclusive with it (enforced at the schema layer). Contributes
   * NO ordering: a bbox has a centre, but using it to order would make "search
   * this area" quietly change the sort. A caller that wants nearest-first
   * within a viewport sends `orderingCenter` alongside it.
   */
  bbox?: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  /**
   * Centre used ONLY to ORDER. Never contributes a WHERE predicate, so
   * `sort: 'nearest'` returns the whole candidate set nearest-first instead of
   * truncating it (#644). When `spatial` is also set, the caller may pass its
   * centre here too.
   */
  orderingCenter?: { lat: number; lng: number };
  /**
   * Resolved by the caller via resolveSort — never inferred here.
   *
   * OPTIONAL, and absent is meaningful: it selects the historical inferred
   * ordering (cosine > distance > indexed_at recency) so a caller that sends no
   * `sort` gets byte-identical behaviour to before #644.
   */
  sort?: SortMode;
  /**
   * #148: applied as an additional value-match WHERE predicate, ANDed with
   * everything else — NOT as a competing query vector. So text narrows while
   * an anchor's embedding still ranks. Matched against the `vectorize: true`
   * fields, so narrowing and cosine ranking describe the same content (and a
   * `private` field can never be in that set — vectorizeFields throws on one).
   */
  textSearch?: string;
  /** The `vectorize: true` field names, from registry.vectorizeFields(). */
  textSearchFields?: string[];
  filters: FilterClause[];
  limit: number;
  offset: number;
};
export type SearchRow = {
  item_network: string; item_domain: string; item_type: string; item_id: string;
  item_state: Record<string, unknown>; item_locations: { lat: number; lng: number; label?: string }[];
  item_instance_url: string | null; item_schema_url: string | null;
  created_at: string; updated_at: string; created_by: string | null; lifecycle_status: string;
  score?: number; distanceMeters?: number;
};

function fieldKey(target: string): string {
  return target.slice('item_state.'.length); // schema-validated as item_state.<field>
}

function filterFragment(sql: Sql, f: FilterClause): PendingQuery<Row[]> {
  const key = fieldKey(f.target);
  switch (f.op) {
    case 'eq':  return sql`(i.item_state->>${key}) = ${String(f.value)}`;
    case 'neq': return sql`(i.item_state->>${key}) IS DISTINCT FROM ${String(f.value)}`;
    case 'in':  return sql`(i.item_state->>${key}) = ANY(${(f.value as unknown[]).map(String)})`;
    case 'gt':  return sql`(i.item_state->>${key})::numeric >  ${Number(f.value)}`;
    case 'gte': return sql`(i.item_state->>${key})::numeric >= ${Number(f.value)}`;
    case 'lt':  return sql`(i.item_state->>${key})::numeric <  ${Number(f.value)}`;
    case 'lte': return sql`(i.item_state->>${key})::numeric <= ${Number(f.value)}`;
    case 'contains': {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      // Bind the value as real jsonb via postgres.js's sql.json(). A plain
      // `${JSON.stringify(arr)}::jsonb` is sent as a text param and the cast
      // re-parses it into a jsonb *string scalar* (double-encoded), so
      // `array @> "..."` is always false — array-field filtering silently
      // returned nothing. sql.json() sends a proper jsonb array.
      return sql`(i.item_state->${key}) @> ${sql.json(arr as unknown as Parameters<typeof sql.json>[0])}`;
    }
    case 'contains_any': {
      // jsonb `?|`: true when the array-valued field shares AT LEAST ONE
      // element with the given list ("contains any of"). Complements `contains`
      // (`@>` = must contain ALL). Values bound as a text[] parameter (never
      // interpolated); `?|` is a literal operator, not a placeholder, in
      // postgres.js. A single non-array value is wrapped, mirroring `contains`.
      const arr = (Array.isArray(f.value) ? f.value : [f.value]).map(String);
      return sql`(i.item_state->${key}) ?| ${arr}::text[]`;
    }
  }
}

// OR across the vectorize fields, ANDed into the WHERE. Runs against
// i.item_state — item_search stores no serialized text, and the `JOIN items i`
// is already present. Field names are BOUND as parameters to `->>`, never
// interpolated, matching filterFragment.
//
// Known looseness (accepted, contract §4): for an array-valued field, `->>'f'`
// yields the serialized JSON array as text (e.g. ["solar","wind"]), so ILIKE
// matches against that text form. Fine for a narrowing predicate.
function textFragment(sql: Sql, q: string, fields: string[]): PendingQuery<Row[]> | undefined {
  if (fields.length === 0) return undefined;
  const like = `%${q}%`;
  const parts = fields.map((f) => sql`COALESCE(i.item_state->>${f}, '') ILIKE ${like}`);
  return parts.reduce((acc, part, i) => (i === 0 ? part : sql`${acc} OR ${part}`), parts[0]);
}

// Every WHERE predicate, ANDed together. The spatial clause — a point radius
// or a bbox — is the only thing that filters on location; an ordering centre
// never appears here, which is what lets `sort: 'nearest'` order the full
// candidate set (#644).
function buildWhere(sql: Sql, p: SearchParams): PendingQuery<Row[]> {
  const conds: PendingQuery<Row[]>[] = [
    sql`i.lifecycle_status = 'live'`,
    sql`s.item_network = ${p.item_network} AND s.item_domain = ${p.item_domain} AND s.item_type = ${p.item_type}`,
  ];
  for (const f of p.filters) conds.push(filterFragment(sql, f));
  if (p.textSearch && p.textSearchFields?.length) {
    const frag = textFragment(sql, p.textSearch, p.textSearchFields);
    if (frag) conds.push(sql`(${frag})`);
  }
  if (p.spatial) {
    conds.push(sql`ST_DWithin(
      s.geo,
      ST_SetSRID(ST_MakePoint(${p.spatial.lng}, ${p.spatial.lat}), 4326)::geography,
      ${p.spatial.distanceMeters}
    )`);
  }
  if (p.bbox) {
    // Two predicates, deliberately. ST_MakeEnvelope takes
    // (xmin, ymin, xmax, ymax) = (minLng, minLat, maxLng, maxLat).
    //
    // 1. `&&` against the GEOGRAPHY envelope is the index-accelerated
    //    prefilter — it is what keeps the existing item_search_geo_gist index
    //    in play, the same access path ST_DWithin uses. It compares geodetic
    //    bounding boxes, which strictly CONTAIN the rectangle below, so it can
    //    never exclude a row the exact test would have kept.
    //
    // 2. ST_Intersects on the GEOMETRY cast is the exact test, and it is
    //    planar on purpose. A map viewport IS a lat/lng rectangle, but a
    //    geography polygon's edges are geodesics: the arc joining two corners
    //    at the same latitude bows toward the pole, so the shape is shifted
    //    north of the rectangle the user actually saw. Measured on a 0.1° x
    //    0.2° box at 12.9°N, a pin sitting exactly on the southern edge at
    //    mid-longitude fell ~2 m OUTSIDE the geography polygon and was dropped,
    //    while a pin just north of the top edge was wrongly included. Small,
    //    but it is the same class of error — a list disagreeing with the map —
    //    that made the circumscribed-circle approximation unacceptable (spec
    //    D6), so the exact test uses the true rectangle. Boundary-inclusive.
    const envelope = sql`ST_MakeEnvelope(${p.bbox.minLng}, ${p.bbox.minLat}, ${p.bbox.maxLng}, ${p.bbox.maxLat}, 4326)`;
    conds.push(sql`s.geo && ${envelope}::geography AND ST_Intersects(s.geo::geometry, ${envelope})`);
  }
  // postgres.js supports nesting PendingQuery fragments inside template literals.
  return conds.reduce<PendingQuery<Row[]>>(
    (acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`),
    conds[0],
  );
}

/**
 * The centre used to MEASURE and ORDER by distance. The ORDERING centre wins
 * over the FILTER centre, per contract §1.3: `nearest` may be requested with no
 * spatial filter at all. When only a spatial clause is present its own centre
 * is used, so an area-filtered search keeps emitting distanceMeters exactly as
 * before.
 */
function distanceCenter(p: SearchParams): { lat: number; lng: number } | undefined {
  if (p.orderingCenter) return p.orderingCenter;
  if (p.spatial) return { lat: p.spatial.lat, lng: p.spatial.lng };
  return undefined;
}

/**
 * ORDER BY for one search. Pure fragment builder: prefer cosine when a vector
 * is present, else distance, else recency.
 *
 * Why the tiebreaker exists (spec §3.4): SQL leaves tied rows unordered, and
 * each page is an independent query execution whose LIMIT+OFFSET bound differs,
 * so the planner can arrange a tie group differently between page N and page
 * N+1 — rows appear twice while others are never returned. Measured on 200 rows
 * sharing one created_at and one indexed_at: paging at limit 20 returned 197
 * distinct ids out of 200. item_id is unique per row, already in the composite
 * PK and already selected, and a sort comparator only reads it INSIDE a tie
 * group, so distinct leading keys never pay for it.
 *
 * ...EXCEPT on the cosine path, which deliberately has NO tiebreaker.
 * Appending a second sort key makes pgvector's HNSW index unusable: the scan
 * supplies a pathkey only for the exact single-expression ordering, and being
 * approximate it cannot promise it emits complete tie groups, so Postgres
 * cannot build an incremental sort over it either. Measured on 20k rows, adding
 * `, s.item_id ASC` here replaced
 *   Index Scan using item_search_embedding_hnsw   (2.8 ms)
 * with a full Seq Scan + top-N heapsort of every live row (316 ms) — 115x
 * slower and O(corpus). Forcing seqscan/hashjoin/mergejoin off does not recover
 * an HNSW plan; none exists.
 *
 * The cost would also buy almost nothing. A cosine tie needs byte-identical
 * embeddings, and the HNSW traversal is deterministic for a fixed query vector,
 * ef_search and index state — so even tied rows already come back in a stable
 * order. Measured: five pages at limit 20 (offsets 0/20/40/100/200) with
 * hnsw.ef_search=500 returned 100 distinct ids and zero overlap between any
 * pair of pages, and a given page was byte-identical across repeat calls in one
 * session and on a fresh connection.
 *
 * Distance and recency pay nothing for the tiebreaker: the geo path keeps the
 * same Bitmap Index Scan on item_search_geo_gist with a byte-identical plan,
 * and recency sorts either way.
 *
 * Separate, unrelated limitation worth knowing when reading relevance results:
 * pgvector's hnsw.ef_search defaults to 40 with hnsw.iterative_scan off, and in
 * that configuration the scan silently truncates. See src/db/client.ts, which
 * sets iterative_scan on every API connection; it is not something this ORDER
 * BY can address.
 */
function buildOrderBy(
  sql: Sql,
  p: SearchParams,
  vecLiteral: string | null,
  distExpr: PendingQuery<Row[]>,
  hasDistCenter: boolean,
): PendingQuery<Row[]> {
  const tiebreak = sql`s.item_id ASC`;
  const byDistance = sql`${distExpr} ASC NULLS LAST, ${tiebreak}`;
  const byCosine = () => sql`s.embedding <=> ${vecLiteral}::vector ASC`;
  // Recency means i.created_at, NOT item_search.indexed_at (spec D5 / P4): a
  // re-index or a backfill must not reshuffle the user-facing feed. The
  // INFERRED path is the one exception — it keeps indexed_at, because that is
  // what it has always done and an absent `sort` must not change.
  const byRecency = sql`i.created_at DESC, ${tiebreak}`;

  if (p.sort === undefined) {
    // No sort requested: today's inferred ordering, preserved exactly.
    if (vecLiteral) return byCosine();
    if (p.spatial) return byDistance;
    return sql`s.indexed_at DESC, ${tiebreak}`;
  }

  switch (p.sort) {
    case 'relevance':
      // Degrades to recency when no vector was supplied. resolveSort should
      // already have prevented that, so this is defence in depth, not a second
      // decision point.
      return vecLiteral ? byCosine() : byRecency;
    case 'nearest':
      // No ST_DWithin is added by this sort — ordering by location must never
      // truncate the candidate set (#644). Location-less rows sort last.
      return hasDistCenter ? byDistance : byRecency;
    case 'newest':
      return byRecency;
  }
}

export async function searchItems(sql: Sql, p: SearchParams): Promise<{ rows: SearchRow[]; total: number }> {
  const vecLiteral = p.queryVector ? `[${p.queryVector.join(',')}]` : null;

  const where = buildWhere(sql, p);

  // Score expression: (1 - cosine_distance) cast to float8; NULL when no vector
  const scoreSel = vecLiteral
    ? sql`(1 - (s.embedding <=> ${vecLiteral}::vector))::float8`
    : sql`NULL::float8`;

  // Distance expression reused in both SELECT and ORDER BY to avoid alias reference issues
  // (a bare column alias cannot appear in the same SELECT's ORDER BY in Postgres subquery context).
  const distCenter = distanceCenter(p);
  const distExpr = distCenter
    ? sql`ST_Distance(
        s.geo,
        ST_SetSRID(ST_MakePoint(${distCenter.lng}, ${distCenter.lat}), 4326)::geography
      )::float8`
    : sql`NULL::float8`;

  const orderBy = buildOrderBy(sql, p, vecLiteral, distExpr, !!distCenter);

  const raw = await sql<{
    item_network: string; item_domain: string; item_type: string; item_id: string;
    item_state: Record<string, unknown>; item_locations: unknown;
    item_instance_url: string | null; item_schema_url: string | null;
    created_at: Date; updated_at: Date; created_by: string | null; lifecycle_status: string;
    score: string | number | null; distanceMeters: string | number | null;
  }[]>`
    SELECT s.item_network, s.item_domain, s.item_type, s.item_id::text AS item_id,
           i.item_state, i.item_locations,
           i.item_instance_url, i.item_schema_url,
           i.created_at, i.updated_at, i.created_by, i.lifecycle_status,
           ${scoreSel} AS score,
           ${distExpr} AS "distanceMeters"
    FROM item_search s
    JOIN items i USING (item_network, item_domain, item_type, item_id)
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${p.limit} OFFSET ${p.offset}`;

  const rows: SearchRow[] = raw.map((r) => ({
    item_network: r.item_network,
    item_domain: r.item_domain,
    item_type: r.item_type,
    item_id: r.item_id,
    item_state: r.item_state,
    item_locations: r.item_locations as { lat: number; lng: number; label?: string }[],
    item_instance_url: r.item_instance_url,
    item_schema_url: r.item_schema_url,
    // postgres.js returns timestamptz as Date; serialize to ISO strings so the
    // JSON response (and ItemResultSchema, which declares these as z.string())
    // carries a stable, timezone-unambiguous representation.
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    created_by: r.created_by,
    lifecycle_status: r.lifecycle_status,
    score: r.score !== null && r.score !== undefined ? Number(r.score) : undefined,
    distanceMeters: r.distanceMeters !== null && r.distanceMeters !== undefined ? Number(r.distanceMeters) : undefined,
  }));

  const [{ total }] = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total
    FROM item_search s JOIN items i USING (item_network, item_domain, item_type, item_id)
    WHERE ${where}`;

  return { rows, total };
}
