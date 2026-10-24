import type { Sql, PendingQuery, Row } from 'postgres';

export type FilterClause = { op: 'eq' | 'neq' | 'in' | 'contains' | 'contains_any' | 'gt' | 'gte' | 'lt' | 'lte'; target: string; value: unknown };
// Re-declared rather than imported so the db layer never imports from api/.
// The wire enum lives in api/schemas.ts.
export type SortMode = 'relevance' | 'newest' | 'nearest';

export type SearchParams = {
  item_network: string;
  item_domain: string;
  item_type: string;
  queryVector?: number[];
  /** ST_DWithin filter: decides membership. */
  spatial?: { lat: number; lng: number; distanceMeters: number };
  /**
   * Viewport filter: decides membership like `spatial` and is mutually exclusive
   * with it (schema-enforced). It contributes no ordering, so "search this area"
   * never changes the sort; send `orderingCenter` too for nearest-first.
   */
  bbox?: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  /**
   * Centre used only to order. It never adds a WHERE predicate, so
   * `sort: 'nearest'` returns the whole candidate set nearest-first.
   */
  orderingCenter?: { lat: number; lng: number };
  /**
   * Resolved by the caller via resolveSort, never inferred here. Absent selects
   * the inferred ordering (cosine, else distance, else indexed_at recency) that
   * callers sending no `sort` rely on.
   */
  sort?: SortMode;
  /**
   * Value-match WHERE predicate over the `vectorize: true` fields, so text
   * narrows while an anchor's embedding still ranks. Set only when an anchor
   * supplies the query vector: without one the text is the query vector, and
   * literal-gating it would remove semantic recall. A `private` field is never
   * in the field set (vectorizeFields throws on one).
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
      // Must bind via sql.json(). A `${JSON.stringify(arr)}::jsonb` cast is sent
      // as text and re-parsed into a jsonb string scalar, so `@>` never matches.
      return sql`(i.item_state->${key}) @> ${sql.json(arr as unknown as Parameters<typeof sql.json>[0])}`;
    }
    case 'contains_any': {
      // jsonb `?|`: the array field shares at least one value with the list.
      // Values are bound as a text[] parameter; postgres.js treats `?|` as a
      // literal operator, not a placeholder.
      const arr = (Array.isArray(f.value) ? f.value : [f.value]).map(String);
      return sql`(i.item_state->${key}) ?| ${arr}::text[]`;
    }
  }
}

// Escapes ILIKE metacharacters so a typed `%`, `_` or `\` matches itself
// (backslash is ILIKE's default escape character).
function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Text narrowing predicate: every whitespace-separated term must appear in some
 * vectorized field (AND across terms, OR across fields). Tokenized because one
 * contiguous `%q%` misses multi-word queries whose words sit in different
 * fields. Field names and terms are bound as parameters. For an array-valued
 * field, `->>` yields the serialized JSON array, so ILIKE matches that text.
 */
function textFragment(sql: Sql, q: string, fields: string[]): PendingQuery<Row[]> | undefined {
  if (fields.length === 0) return undefined;
  const terms = q.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return undefined;

  const perTerm = terms.map((term) => {
    const like = `%${escapeLikePattern(term)}%`;
    const parts = fields.map((f) => sql`COALESCE(i.item_state->>${f}, '') ILIKE ${like}`);
    return parts.reduce((acc, part, i) => (i === 0 ? part : sql`${acc} OR ${part}`), parts[0]);
  });
  const wrapped = perTerm.map((frag) => sql`(${frag})`);
  return wrapped.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc} AND ${frag}`), wrapped[0]);
}

// Only the spatial clause (radius or bbox) filters on location; an ordering
// centre never appears here.
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
    // ST_MakeEnvelope takes (xmin, ymin, xmax, ymax) = (minLng, minLat, maxLng, maxLat).
    const envelope = sql`ST_MakeEnvelope(${p.bbox.minLng}, ${p.bbox.minLat}, ${p.bbox.maxLng}, ${p.bbox.maxLat}, 4326)`;

    // Design: docs/architecture/bbox-filter.md
    // The exact test is planar because a map viewport is a lat/lng rectangle;
    // geodesic polygon edges bow toward the pole. Boundary-inclusive.
    const exact = sql`ST_Intersects(s.geo::geometry, ${envelope})`;

    // The geography `&&` prefilter keeps item_search_geo_gist in use (the
    // geometry cast alone defeats it). It is only valid when both spans are
    // under 180°: wider envelopes invert and match nothing, and antipodal edges
    // make the geography cast throw.
    const withinGeodeticLimits =
      p.bbox.maxLng - p.bbox.minLng < 180 && p.bbox.maxLat - p.bbox.minLat < 180;

    conds.push(
      withinGeodeticLimits
        ? sql`s.geo && ${envelope}::geography AND ${exact}`
        : exact,
    );
  }

  return conds.reduce<PendingQuery<Row[]>>(
    (acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`),
    conds[0],
  );
}

/**
 * Centre used to measure and order by distance. The ordering centre wins over
 * the radius filter's centre; with neither, no distance is computed.
 */
function distanceCenter(p: SearchParams): { lat: number; lng: number } | undefined {
  if (p.orderingCenter) return p.orderingCenter;
  if (p.spatial) return { lat: p.spatial.lat, lng: p.spatial.lng };
  return undefined;
}

/**
 * ORDER BY for one search. Every path except cosine ends in an `item_id`
 * tiebreaker so tied rows page deterministically. Cosine has none because a
 * second sort key makes the HNSW index unusable.
 *
 * Design: docs/architecture/search-ordering-and-paging.md
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
  // Recency is i.created_at, not indexed_at, so a re-index or backfill does not
  // reshuffle the feed. The inferred (no-sort) path keeps indexed_at so its
  // behaviour does not change.
  const byRecency = sql`i.created_at DESC, ${tiebreak}`;

  if (p.sort === undefined) {
    // No sort requested: the inferred ordering.
    if (vecLiteral) return byCosine();
    if (p.spatial) return byDistance;
    return sql`s.indexed_at DESC, ${tiebreak}`;
  }

  switch (p.sort) {
    case 'relevance':
      // Defence in depth: resolveSort already degrades vectorless relevance.
      return vecLiteral ? byCosine() : byRecency;
    case 'nearest':
      // Ordering adds no ST_DWithin, so the candidate set is never truncated.
      // Location-less rows sort last.
      return hasDistCenter ? byDistance : byRecency;
    case 'newest':
      return byRecency;
  }
}

export async function searchItems(sql: Sql, p: SearchParams): Promise<{ rows: SearchRow[]; total: number }> {
  const vecLiteral = p.queryVector ? `[${p.queryVector.join(',')}]` : null;

  const where = buildWhere(sql, p);

  const scoreSel = vecLiteral
    ? sql`(1 - (s.embedding <=> ${vecLiteral}::vector))::float8`
    : sql`NULL::float8`;

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
    // postgres.js returns Date; ItemResultSchema declares these as ISO strings.
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
