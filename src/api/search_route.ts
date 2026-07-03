import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ApiDeps } from './server.js';
import { SearchRequestSchema, SearchResponseSchema, ErrorSchema, type SearchResponse } from './schemas.js';
import { authenticateApiKey } from './auth.js';
import { searchItems, type FilterClause } from '../db/search_query.js';
import { serializeItemText } from '../ingest/serialize.js';
import { cacheKey, getCached, setCached } from './result_cache.js';
import { TeiReranker } from '../rerank/reranker.js';

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
      response: {
        200: SearchResponseSchema,
        400: ErrorSchema,
        401: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        422: ErrorSchema,
      },
    },
  }, async (request, reply) => {
    const caller = await authenticateApiKey(deps.sql, request.headers['x-api-key'] as string | undefined);
    if (!caller) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'valid x-api-key required' });

    // Body is already validated by the Zod route schema (type provider).
    const { context, message } = request.body;
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
      const rows = await deps.sql<{ item_domain: string; embedding: string | null; lat: number | null; lng: number | null }[]>`
        SELECT item_domain, embedding::text AS embedding,
               ST_Y(ST_GeometryN(geo::geometry, 1)) AS lat,
               ST_X(ST_GeometryN(geo::geometry, 1)) AS lng
        FROM item_search WHERE item_id = ${message.intent.item.id} LIMIT 1`;
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
    if (!message.intent.item?.id && message.intent.textSearch) {
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

    const willRerank = deps.rerank.defaultOn && !!deps.rerank.baseUrl && !!message.intent.textSearch;
    const topN = Math.max(pagination.limit, deps.rerank.topN);
    const { rows, total } = await searchItems(deps.sql, {
      item_network: networkId, item_domain: domain, item_type: itemType,
      queryVector,
      spatial: spatialParam,
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
          ...(r.score != null ? { score: Number(r.score.toFixed(4)) } : {}),
          ...(r.distanceMeters != null ? { distanceMeters: Math.round(r.distanceMeters) } : {}),
        })),
        meta: { total, limit: pagination.limit, offset: pagination.offset },
      },
    };
    await setCached(deps.redis, key, response, deps.cacheTtlSeconds);
    return reply.code(200).send(response);
  });
}
