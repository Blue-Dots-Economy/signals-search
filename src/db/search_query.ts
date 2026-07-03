import type { Sql, PendingQuery, Row } from 'postgres';

export type FilterClause = { op: 'eq' | 'neq' | 'in' | 'contains' | 'contains_any' | 'gt' | 'gte' | 'lt' | 'lte'; target: string; value: unknown };
export type SearchParams = {
  item_network: string;
  item_domain: string;
  item_type: string;
  queryVector?: number[];
  spatial?: { lat: number; lng: number; distanceMeters: number };
  filters: FilterClause[];
  limit: number;
  offset: number;
};
export type SearchRow = {
  item_network: string; item_domain: string; item_type: string; item_id: string;
  item_state: Record<string, unknown>; item_locations: { lat: number; lng: number; label?: string }[];
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

export async function searchItems(sql: Sql, p: SearchParams): Promise<{ rows: SearchRow[]; total: number }> {
  const vecLiteral = p.queryVector ? `[${p.queryVector.join(',')}]` : null;

  // Build WHERE conditions as an array of fragments
  const conds: PendingQuery<Row[]>[] = [
    sql`i.lifecycle_status = 'live'`,
    sql`s.item_network = ${p.item_network} AND s.item_domain = ${p.item_domain} AND s.item_type = ${p.item_type}`,
  ];
  for (const f of p.filters) conds.push(filterFragment(sql, f));
  if (p.spatial) {
    conds.push(sql`ST_DWithin(
      s.geo,
      ST_SetSRID(ST_MakePoint(${p.spatial.lng}, ${p.spatial.lat}), 4326)::geography,
      ${p.spatial.distanceMeters}
    )`);
  }

  // Compose WHERE with AND using sql`` fragment nesting
  // postgres.js supports nesting PendingQuery fragments inside template literals
  const where = conds.reduce<PendingQuery<Row[]>>(
    (acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`),
    conds[0],
  );

  // Score expression: (1 - cosine_distance) cast to float8; NULL when no vector
  const scoreSel = vecLiteral
    ? sql`(1 - (s.embedding <=> ${vecLiteral}::vector))::float8`
    : sql`NULL::float8`;

  // Distance expression reused in both SELECT and ORDER BY to avoid alias reference issues
  // (a bare column alias cannot appear in the same SELECT's ORDER BY in Postgres subquery context)
  const distExpr = p.spatial
    ? sql`ST_Distance(
        s.geo,
        ST_SetSRID(ST_MakePoint(${p.spatial.lng}, ${p.spatial.lat}), 4326)::geography
      )::float8`
    : sql`NULL::float8`;

  // ORDER BY: prefer cosine similarity when vector present; else distance; else recency
  const orderBy = vecLiteral
    ? sql`s.embedding <=> ${vecLiteral}::vector ASC`
    : p.spatial
      ? sql`${distExpr} ASC NULLS LAST`
      : sql`s.indexed_at DESC`;

  const raw = await sql<{
    item_network: string; item_domain: string; item_type: string; item_id: string;
    item_state: Record<string, unknown>; item_locations: unknown;
    score: string | number | null; distanceMeters: string | number | null;
  }[]>`
    SELECT s.item_network, s.item_domain, s.item_type, s.item_id::text AS item_id,
           i.item_state, i.item_locations,
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
    score: r.score !== null && r.score !== undefined ? Number(r.score) : undefined,
    distanceMeters: r.distanceMeters !== null && r.distanceMeters !== undefined ? Number(r.distanceMeters) : undefined,
  }));

  const [{ total }] = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total
    FROM item_search s JOIN items i USING (item_network, item_domain, item_type, item_id)
    WHERE ${where}`;

  return { rows, total };
}
