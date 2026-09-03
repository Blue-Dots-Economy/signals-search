import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ApiDeps } from './server.js';
import { SearchRequestSchema, FlatSearchRequestSchema, SearchResponseSchema, ErrorSchema, type SearchRequest, type SearchResponse, type SortMode } from './schemas.js';
import { authenticateApiKey } from './auth.js';
import { searchItems, type FilterClause } from '../db/search_query.js';
import { serializeItemText } from '../ingest/serialize.js';
import { cacheKey, getCached, setCached } from './result_cache.js';
import { TeiReranker } from '../rerank/reranker.js';
import { unflatten } from './unflatten.js';

// Re-exported from the wire schema rather than re-declared, so the decision
// table and the accepted/reported values can never drift apart.
export type { SortMode } from './schemas.js';

/**
 * Resolve the ORDER the request will actually get. Pure and exported so the
 * decision table is testable without a database or a live route.
 *
 * Contract (docs/superpowers/plans/2026-09-03-list-view-wire-contract.md §1.2):
 * an unsatisfiable `sort` NEVER errors — it degrades to `newest`, and the caller
 * is told via `meta.sort_applied`. With no `sort` requested we reproduce today's
 * inferred precedence exactly (cosine > distance > recency) so existing callers
 * see no change.
 */
export function resolveSort(input: {
  requested?: SortMode;
  hasAnchor: boolean;
  hasText: boolean;
  hasCenter: boolean;
  hasSpatialFilter: boolean;
}): SortMode {
  const canRelevance = input.hasAnchor || input.hasText;

  if (input.requested === 'relevance') return canRelevance ? 'relevance' : 'newest';
  if (input.requested === 'nearest') return input.hasCenter ? 'nearest' : 'newest';
  if (input.requested === 'newest') return 'newest';

  // No explicit sort: today's inferred behaviour, preserved exactly.
  if (canRelevance) return 'relevance';
  if (input.hasSpatialFilter && input.hasCenter) return 'nearest';
  return 'newest';
}

// Shared execution core for both /v1/search (nested body) and
// /v1/search/flat (flattened body). Both routes obtain a validated
// SearchRequest and then delegate here — the ONLY difference between the
// routes is how the request body is parsed into that SearchRequest, so there
// is exactly one execution path (cache, embed, spatial, search, rerank).
async function runSearch(reply: FastifyReply, deps: ApiDeps, body: SearchRequest): Promise<FastifyReply> {
  const { context, message } = body;
  const { networkId, domain, itemType } = context;

  if (!deps.registry.hasDomain(networkId, domain)) {
    return reply.code(404).send({ error: 'UNSERVED_DOMAIN', message: `${networkId}/${domain} not served` });
  }

  // Anchor path: resolve the anchor's vector + domain and enforce the
  // interaction matrix BEFORE any cache lookup, so authorization and anchor
  // freshness (a deindexed anchor → 404) are always re-checked and never
  // served from a stale cache entry.
  let queryVector: number[] | undefined;
  // Anchor's own stored location (first point of its geo), used when a
  // spatial clause omits geometry ("search near this profile's location").
  let anchorLat: number | null = null;
  let anchorLng: number | null = null;
  if (message.intent.item?.id) {
    // geo is a geography(MultiPoint); use ST_GeometryN to take the first
    // point (ST_PointN only works on LineStrings → NULL for MultiPoint).
    // Scope by item_network so the lookup uses the composite-PK index
    // (item_network is the leading column) instead of a seq scan, AND can
    // only ever resolve an anchor inside the caller's own network — the
    // anchor's embedding/domain/lat/lng below all come from THIS row, so a
    // cross-network anchor would be an authz hole. We intentionally do NOT
    // scope by domain/item_type: the anchor legitimately belongs to a
    // different domain/type than context (interaction matrix = authz).
    const rows = await deps.sql<{ item_domain: string; embedding: string | null; lat: number | null; lng: number | null }[]>`
      SELECT item_domain, embedding::text AS embedding,
             ST_Y(ST_GeometryN(geo::geometry, 1)) AS lat,
             ST_X(ST_GeometryN(geo::geometry, 1)) AS lng
      FROM item_search
      WHERE item_network = ${networkId} AND item_id = ${message.intent.item.id}
      LIMIT 1`;
    if (rows.length === 0 || !rows[0].embedding) {
      return reply.code(404).send({ error: 'ANCHOR_NOT_FOUND', message: 'anchor item not indexed' });
    }
    if (!deps.registry.isInteractionAllowed(networkId, rows[0].item_domain, domain)) {
      return reply.code(403).send({ error: 'INTERACTION_NOT_ALLOWED', message: `${rows[0].item_domain} → ${domain} not permitted` });
    }
    queryVector = JSON.parse(rows[0].embedding) as number[];
    anchorLat = rows[0].lat;
    anchorLng = rows[0].lng;
  }

  const spatial = message.intent.spatial?.[0];
  const pagination = message.pagination;
  const normalized = { networkId, domain, itemType, intent: message.intent, pagination };
  const key = cacheKey(normalized);
  const cached = await getCached<SearchResponse>(deps.redis, key);
  if (cached) return reply.code(200).send(cached);

  // textSearch (non-anchor) path: embedding is the most expensive hop in the
  // request, so it runs only on a cache MISS. No interaction-matrix check
  // applies here — the target is the caller-declared context.domain, already
  // gated by the served-domain check above, with no anchor source domain to
  // scope against.
  // #148: text and an anchor are NO LONGER mutually exclusive. With an anchor
  // present its stored embedding remains the query vector (so relevance still
  // explains the order) and the text is applied as a narrowing WHERE predicate
  // in search_query.ts. Without an anchor, text becomes the query vector as
  // before. Gating on `!queryVector` rather than on the anchor id keeps the
  // embed call on the cache-MISS-only path it was always on.
  if (!queryVector && message.intent.textSearch) {
    [queryVector] = await deps.embedder.embed([message.intent.textSearch]);
  }

  // Rerank only applies to free-text search (the cross-encoder scores query-vs-doc)
  // and only when enabled with a configured endpoint. The SAME predicate must gate
  // both the stage-1 over-fetch and the slice-back — otherwise we over-fetch without
  // re-paginating (e.g. an anchor search with rerank on would return up to topN rows
  // and ignore the requested offset). See PR #7 review.
  // Resolve the spatial search center:
  //  - geometry present → use the explicit point (profile location ignored)
  //  - geometry absent  → use the anchor's own location (item.id guaranteed
  //    by the schema refine); 422 if the anchor has no stored location
  //  - distanceMeters falls back to the configured default when omitted
  let spatialParam: { lat: number; lng: number; distanceMeters: number } | undefined;
  if (spatial) {
    const distanceMeters = spatial.distanceMeters ?? deps.defaultDistanceMeters;
    if (spatial.geometry) {
      spatialParam = { lat: spatial.geometry.coordinates[1], lng: spatial.geometry.coordinates[0], distanceMeters };
    } else if (anchorLat != null && anchorLng != null) {
      spatialParam = { lat: anchorLat, lng: anchorLng, distanceMeters };
    } else {
      return reply.code(422).send({
        error: 'ANCHOR_HAS_NO_LOCATION',
        message: 'the anchor item has no stored location. Provide geometry with distanceMeters to search a specific area, or remove the spatial clause to search without a location filter.',
      });
    }
  }

  // Contract §1.3 — centre resolution for `nearest`, first match wins:
  // explicit orderingCenter > the spatial filter's own centre > the anchor's
  // stored location. Independent of the area filter by design: with no spatial
  // clause the candidate set stays network-wide while the order is
  // nearest-first (#644). This is only a CANDIDATE — whether it reaches the
  // query at all depends on the sort resolved below.
  const oc = message.intent.orderingCenter;
  const candidateCenter =
    oc ? { lat: oc.coordinates[1], lng: oc.coordinates[0] }
      : spatialParam ? { lat: spatialParam.lat, lng: spatialParam.lng }
      : anchorLat != null && anchorLng != null ? { lat: anchorLat, lng: anchorLng }
      : undefined;

  const sortApplied: SortMode = resolveSort({
    requested: message.intent.sort,
    hasAnchor: !!message.intent.item?.id,
    hasText: !!message.intent.textSearch,
    hasCenter: !!candidateCenter,
    hasSpatialFilter: !!spatialParam,
  });

  // Rerank over-fetches `topN` rows from offset 0 and slices the requested page
  // back out of that window, so a request whose window falls OUTSIDE the band
  // returned an EMPTY page under a full meta.total — and burned a reranker call
  // producing it. Degrade ranking quality at depth instead: skip reranking for
  // that request and page natively from the requested offset (spec §3.6).
  const rerankEligible = deps.rerank.defaultOn && !!deps.rerank.baseUrl && !!message.intent.textSearch;
  const topN = Math.max(pagination.limit, deps.rerank.topN);
  const willRerank = rerankEligible && pagination.offset + pagination.limit <= topN;
  // The centre reaches the query ONLY when the applied sort actually orders by
  // distance. Otherwise it would populate the SELECT's distance expression and
  // start emitting distanceMeters on every anchor search — a silent wire change
  // for callers that never asked for a location. A spatial FILTER still
  // supplies its own centre inside search_query, so area-filtered searches keep
  // reporting distances exactly as before.
  //
  // `sort` is likewise only forwarded when the caller actually sent one: absent
  // means "use the historical inferred ordering", which search_query preserves
  // byte-for-byte. meta.sort_applied above still names whichever path ran.
  const requestedSort = message.intent.sort;
  const { rows, total } = await searchItems(deps.sql, {
    item_network: networkId, item_domain: domain, item_type: itemType,
    queryVector,
    spatial: spatialParam,
    ...(requestedSort ? { sort: sortApplied } : {}),
    ...(requestedSort && sortApplied === 'nearest' ? { orderingCenter: candidateCenter } : {}),
    // #148: narrow on the same fields that define semantic relevance. `.path`
    // because vectorizeFields returns {path, weight}, and the weights only
    // matter for serialization/reranking, not for a match predicate.
    ...(message.intent.textSearch
      ? {
          textSearch: message.intent.textSearch,
          textSearchFields: deps.registry.vectorizeFields(networkId, domain, itemType).map((f) => f.path),
        }
      : {}),
    filters: (message.intent.filters ?? []) as FilterClause[],
    limit: willRerank ? topN : pagination.limit,
    offset: willRerank ? 0 : pagination.offset,
  });

  let ordered = rows;
  if (willRerank) {
    if (rows.length > 1 && message.intent.textSearch && deps.rerank.baseUrl) {
      const fields = deps.registry.vectorizeFields(networkId, domain, itemType);
      const texts = rows.map((r) => serializeItemText(r.item_state, fields));
      const order = await new TeiReranker({ baseUrl: deps.rerank.baseUrl, model: deps.rerank.model })
        .rerank(message.intent.textSearch, texts);
      ordered = order.map((i) => rows[i]);
    }
    // We over-fetched from offset 0; apply the requested page now. This also yields
    // an empty page when offset >= the over-fetched window, which is correct.
    ordered = ordered.slice(pagination.offset, pagination.offset + pagination.limit);
  }

  const response = {
    context,
    message: {
      items: ordered.map((r) => ({
        item_network: r.item_network, item_domain: r.item_domain, item_type: r.item_type, item_id: r.item_id,
        item_state: r.item_state, item_locations: r.item_locations ?? [],
        item_instance_url: r.item_instance_url, item_schema_url: r.item_schema_url,
        created_at: r.created_at, updated_at: r.updated_at, created_by: r.created_by, lifecycle_status: r.lifecycle_status,
        ...(r.score != null ? { score: Number(r.score.toFixed(4)) } : {}),
        ...(r.distanceMeters != null ? { distanceMeters: Math.round(r.distanceMeters) } : {}),
      })),
      meta: { total, limit: pagination.limit, offset: pagination.offset, sort_applied: sortApplied },
    },
  };
  await setCached(deps.redis, key, response, deps.cacheTtlSeconds);
  return reply.code(200).send(response);
}

const SEARCH_RESPONSES = {
  200: SearchResponseSchema,
  400: ErrorSchema,
  401: ErrorSchema,
  403: ErrorSchema,
  404: ErrorSchema,
  422: ErrorSchema,
} as const;

async function requireApiKey(deps: ApiDeps, apiKey: string | undefined, reply: FastifyReply): Promise<boolean> {
  const caller = await authenticateApiKey(deps.sql, apiKey);
  if (!caller) {
    await reply.code(401).send({ error: 'UNAUTHORIZED', message: 'valid x-api-key required' });
    return false;
  }
  return true;
}

export function registerSearchRoute(app: FastifyInstance, deps: ApiDeps): void {
  app.withTypeProvider<ZodTypeProvider>().post('/v1/search', {
    schema: {
      tags: ['search'],
      summary: 'Search items by meaning, location, and/or structured filters',
      description:
        'Beckn-aligned envelope. Provide any combination of textSearch, an anchor item.id, ' +
        'spatial, and filters. Ranking: cosine similarity (text/anchor) → distance (spatial) → recency.',
      security: [{ apiKeyAuth: [] }],
      body: SearchRequestSchema,
      response: SEARCH_RESPONSES,
    },
  }, async (request, reply) => {
    if (!(await requireApiKey(deps, request.headers['x-api-key'] as string | undefined, reply))) return reply;
    // Body is already validated by the Zod route schema (type provider).
    return runSearch(reply, deps, request.body);
  });

  // Flat wrapper for callers that can only emit a one-level object of strings
  // (e.g. Raya LLM tools — see the design spec). The body is a flat object of
  // dot-delimited canonical paths; we unflatten + JSON-parse leaves, then
  // validate with the SAME SearchRequestSchema and run the SAME core. The
  // canonical /v1/search contract is untouched.
  app.withTypeProvider<ZodTypeProvider>().post('/v1/search/flat', {
    schema: {
      tags: ['search'],
      summary: 'Flattened search for one-level-only tool integrations (e.g. Raya)',
      description:
        'Same search as POST /v1/search, but the body is a FLAT object whose keys are ' +
        'dot-delimited canonical paths (a numeric segment is an array index) and whose ' +
        'values may all be strings. Leaves are JSON-parsed to restore real types, then ' +
        'validated against the canonical schema. Numeric-looking filter values are parsed ' +
        'as numbers; send a JSON-quoted string (e.g. "\\"560001\\"") to keep one a string.',
      security: [{ apiKeyAuth: [] }],
      // Permissive body: the flat shape can't be described by SearchRequestSchema,
      // so we accept any object here and validate after unflattening.
      body: FlatSearchRequestSchema,
      response: SEARCH_RESPONSES,
    },
  }, async (request, reply) => {
    if (!(await requireApiKey(deps, request.headers['x-api-key'] as string | undefined, reply))) return reply;
    // unflatten can throw on malformed input (an over-large array index, or a
    // key that both is a scalar and has children, e.g. {"a":"1","a.b":"2"}).
    // Map those to the same 400 the schema path returns — never a 500.
    let nested: unknown;
    try {
      nested = unflatten(request.body as Record<string, unknown>);
    } catch {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'malformed flat body: keys could not be un-flattened' });
    }
    const parsed = SearchRequestSchema.safeParse(nested);
    if (!parsed.success) {
      // Concise, path-prefixed message (the raw ZodError JSON is unhelpful to
      // the non-developer integrators this route targets). The canonical route
      // returns the fastify-zod message; both share error:'VALIDATION_ERROR'/400.
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message });
    }
    return runSearch(reply, deps, parsed.data);
  });
}
