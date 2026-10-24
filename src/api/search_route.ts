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

// Re-exported from the wire schema so accepted and reported values cannot drift.
export type { SortMode } from './schemas.js';

/**
 * Resolves the order the request actually gets. An unsatisfiable `sort` never
 * errors: it degrades to `newest`, reported via `meta.sort_applied`. With no
 * `sort`, the inferred precedence (cosine, else distance, else recency) applies.
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

  // No explicit sort: the inferred ordering.
  if (canRelevance) return 'relevance';
  if (input.hasSpatialFilter && input.hasCenter) return 'nearest';
  return 'newest';
}

export type OrderingCenter = { lat: number; lng: number };

/**
 * Resolves the centre that `sort: 'nearest'` orders around. First match wins:
 * explicit `intent.orderingCenter`, then the radius filter's centre, then the
 * anchor's stored location. Undefined makes resolveSort degrade `nearest` to
 * `newest`. A centre needs no spatial filter, so nearest-first can span the
 * whole network.
 */
export function resolveOrderingCenter(input: {
  explicit?: { coordinates: [number, number] };
  spatialFilter?: { lat: number; lng: number };
  anchorLat: number | null;
  anchorLng: number | null;
}): OrderingCenter | undefined {
  // GeoJSON order is [lng, lat].
  if (input.explicit) {
    return { lat: input.explicit.coordinates[1], lng: input.explicit.coordinates[0] };
  }
  if (input.spatialFilter) {
    return { lat: input.spatialFilter.lat, lng: input.spatialFilter.lng };
  }
  if (input.anchorLat != null && input.anchorLng != null) {
    return { lat: input.anchorLat, lng: input.anchorLng };
  }
  return undefined;
}

// Single execution path for /v1/search and /v1/search/flat; the routes differ
// only in how they parse the body into a SearchRequest.
async function runSearch(reply: FastifyReply, deps: ApiDeps, body: SearchRequest): Promise<FastifyReply> {
  const { context, message } = body;
  const { networkId, domain, itemType } = context;

  if (!deps.registry.hasDomain(networkId, domain)) {
    return reply.code(404).send({ error: 'UNSERVED_DOMAIN', message: `${networkId}/${domain} not served` });
  }

  // The anchor and the interaction matrix are checked before the cache lookup,
  // so authorization and anchor freshness are never served from cache.
  let queryVector: number[] | undefined;
  // Anchor's stored location, used when a radius clause omits geometry.
  let anchorLat: number | null = null;
  let anchorLng: number | null = null;
  if (message.intent.item?.id) {
    // geo is a MultiPoint: ST_GeometryN takes the first point (ST_PointN
    // returns NULL). Scoping by item_network uses the PK index and keeps the
    // anchor inside the caller's network; a cross-network anchor would be an
    // authz hole. Domain and type are not scoped because the anchor may belong
    // to another domain; the interaction matrix below authorizes that.
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

  // At most one spatial clause (schema-enforced): a radius or a bbox.
  const spatialClause = message.intent.spatial?.[0];
  const radiusClause = spatialClause?.op === 's_dwithin' ? spatialClause : undefined;
  const bboxClause = spatialClause?.op === 'bbox' ? spatialClause : undefined;
  const pagination = message.pagination;
  const normalized = { networkId, domain, itemType, intent: message.intent, pagination };
  const key = cacheKey(normalized);
  const cached = await getCached<SearchResponse>(deps.redis, key);
  if (cached) return reply.code(200).send(cached);

  // Without an anchor, the text is embedded as the query vector; with one, the
  // anchor's vector ranks and the text narrows (see textSearch below). Embedding
  // is the most expensive hop, so it runs only on a cache miss. No
  // interaction-matrix check applies: there is no anchor source domain, and
  // context.domain passed the served-domain check above.
  if (!queryVector && message.intent.textSearch) {
    [queryVector] = await deps.embedder.embed([message.intent.textSearch]);
  }

  // Radius centre: the explicit geometry, else the anchor's location (the schema
  // requires item.id when geometry is absent), else 422.
  let spatialParam: { lat: number; lng: number; distanceMeters: number } | undefined;
  if (radiusClause) {
    const distanceMeters = radiusClause.distanceMeters ?? deps.defaultDistanceMeters;
    if (radiusClause.geometry) {
      spatialParam = { lat: radiusClause.geometry.coordinates[1], lng: radiusClause.geometry.coordinates[0], distanceMeters };
    } else if (anchorLat != null && anchorLng != null) {
      spatialParam = { lat: anchorLat, lng: anchorLng, distanceMeters };
    } else {
      return reply.code(422).send({
        error: 'ANCHOR_HAS_NO_LOCATION',
        message: 'the anchor item has no stored location. Provide geometry with distanceMeters to search a specific area, or remove the spatial clause to search without a location filter.',
      });
    }
  }

  // A candidate only: it reaches the query only if the resolved sort is nearest.
  const candidateCenter = resolveOrderingCenter({
    explicit: message.intent.orderingCenter,
    spatialFilter: spatialParam,
    anchorLat,
    anchorLng,
  });

  const sortApplied: SortMode = resolveSort({
    requested: message.intent.sort,
    hasAnchor: !!message.intent.item?.id,
    hasText: !!message.intent.textSearch,
    hasCenter: !!candidateCenter,
    // Radius only, not bbox: the inferred SQL orders by distance only for a
    // radius clause, so counting a bbox would misreport `meta.sort_applied`.
    hasSpatialFilter: !!spatialParam,
  });

  // Rerank needs free text (the cross-encoder scores query vs document), a
  // configured endpoint, and a resolved `relevance` sort; reranking a recency or
  // distance page would contradict meta.sort_applied. It over-fetches `topN`
  // rows from offset 0 and slices the page back out, so a page beyond that
  // window skips reranking and pages natively. willRerank must gate both the
  // over-fetch and the slice-back.
  const rerankEligible = deps.rerank.defaultOn
    && !!deps.rerank.baseUrl
    && !!message.intent.textSearch
    && sortApplied === 'relevance';
  const topN = Math.max(pagination.limit, deps.rerank.topN);
  const willRerank = rerankEligible && pagination.offset + pagination.limit <= topN;
  // The centre is forwarded only for a nearest sort; otherwise every anchor
  // search would emit distanceMeters. A radius filter still supplies its own
  // centre inside search_query. `sort` is forwarded only when the caller sent
  // one, so an absent sort keeps the inferred ordering.
  const requestedSort = message.intent.sort;
  const { rows, total } = await searchItems(deps.sql, {
    item_network: networkId, item_domain: domain, item_type: itemType,
    queryVector,
    spatial: spatialParam,
    // Membership only: a bbox never contributes an ordering centre.
    ...(bboxClause
      ? { bbox: { minLat: bboxClause.minLat, minLng: bboxClause.minLng, maxLat: bboxClause.maxLat, maxLng: bboxClause.maxLng } }
      : {}),
    ...(requestedSort ? { sort: sortApplied } : {}),
    ...(requestedSort && sortApplied === 'nearest' ? { orderingCenter: candidateCenter } : {}),
    // Text narrows on the vectorized fields only when an anchor is present.
    // Without one the text is the query vector and must rank, not filter, or
    // semantic recall is lost.
    ...(message.intent.textSearch && message.intent.item?.id
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
    // Over-fetched from offset 0, so slice out the requested page.
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
        'spatial, orderingCenter, sort, and filters. Ordering: pass `intent.sort` ' +
        '(relevance | newest | nearest); when omitted, ordering is inferred as ' +
        'cosine → distance → recency for backward compatibility. `intent.spatial` ' +
        'FILTERS (s_dwithin); `intent.orderingCenter` only ORDERS and never filters. ' +
        '`meta.sort_applied` always reports the order actually used — an order whose ' +
        'precondition is unmet degrades to newest rather than erroring. textSearch ' +
        'narrows results even when an anchor supplies the ranking vector.',
      security: [{ apiKeyAuth: [] }],
      body: SearchRequestSchema,
      response: SEARCH_RESPONSES,
    },
  }, async (request, reply) => {
    if (!(await requireApiKey(deps, request.headers['x-api-key'] as string | undefined, reply))) return reply;
    return runSearch(reply, deps, request.body);
  });

  // For callers that can only emit a one-level object of strings (e.g. Raya LLM
  // tools). The body is unflattened, then validated with SearchRequestSchema.
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
      // Permissive: validation happens after unflattening.
      body: FlatSearchRequestSchema,
      response: SEARCH_RESPONSES,
    },
  }, async (request, reply) => {
    if (!(await requireApiKey(deps, request.headers['x-api-key'] as string | undefined, reply))) return reply;
    // unflatten throws on malformed keys (e.g. {"a":"1","a.b":"2"}); map that to
    // the schema path's 400, never a 500.
    let nested: unknown;
    try {
      nested = unflatten(request.body as Record<string, unknown>);
    } catch {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'malformed flat body: keys could not be un-flattened' });
    }
    const parsed = SearchRequestSchema.safeParse(nested);
    if (!parsed.success) {
      // Path-prefixed message: raw ZodError JSON is unhelpful to this route's
      // non-developer integrators.
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message });
    }
    return runSearch(reply, deps, parsed.data);
  });
}
