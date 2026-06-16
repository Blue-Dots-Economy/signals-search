import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './server.js';
import { SearchRequestSchema } from './schemas.js';
import { authenticateApiKey } from './auth.js';
import { searchItems, type FilterClause } from '../db/search_query.js';
import { serializeItemText } from '../ingest/serialize.js';
import { cacheKey, getCached, setCached } from './result_cache.js';
import { TeiReranker } from '../rerank/reranker.js';

export function registerSearchRoute(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/v1/search', async (request, reply) => {
    const caller = await authenticateApiKey(deps.sql, request.headers['x-api-key'] as string | undefined);
    if (!caller) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'valid x-api-key required' });

    const parsed = SearchRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: parsed.error.message });
    const { context, message } = parsed.data;
    const { networkId, domain, itemType } = context;

    if (!deps.registry.hasDomain(networkId, domain)) {
      return reply.code(404).send({ error: 'UNSERVED_DOMAIN', message: `${networkId}/${domain} not served` });
    }

    // Anchor path: resolve the anchor's vector + domain and enforce the
    // interaction matrix BEFORE any cache lookup, so authorization and anchor
    // freshness (a deindexed anchor → 404) are always re-checked and never
    // served from a stale cache entry.
    let queryVector: number[] | undefined;
    if (message.intent.item?.id) {
      const rows = await deps.sql<{ item_domain: string; embedding: string | null }[]>`
        SELECT item_domain, embedding::text AS embedding FROM item_search WHERE item_id = ${message.intent.item.id} LIMIT 1`;
      if (rows.length === 0 || !rows[0].embedding) {
        return reply.code(404).send({ error: 'ANCHOR_NOT_FOUND', message: 'anchor item not indexed' });
      }
      if (!deps.registry.isInteractionAllowed(networkId, rows[0].item_domain, domain)) {
        return reply.code(403).send({ error: 'INTERACTION_NOT_ALLOWED', message: `${rows[0].item_domain} → ${domain} not permitted` });
      }
      queryVector = JSON.parse(rows[0].embedding) as number[];
    }

    const spatial = message.intent.spatial?.[0];
    const pagination = message.pagination;
    const normalized = { networkId, domain, itemType, intent: message.intent, pagination };
    const key = cacheKey(normalized);
    const cached = await getCached<unknown>(deps.redis, key);
    if (cached) return reply.code(200).send(cached);

    // textSearch (non-anchor) path: embedding is the most expensive hop in the
    // request, so it runs only on a cache MISS. No interaction-matrix check
    // applies here — the target is the caller-declared context.domain, already
    // gated by the served-domain check above, with no anchor source domain to
    // scope against.
    if (!message.intent.item?.id && message.intent.textSearch) {
      [queryVector] = await deps.embedder.embed([message.intent.textSearch]);
    }

    const topN = Math.max(pagination.limit, deps.rerank.topN);
    const { rows, total } = await searchItems(deps.sql, {
      item_network: networkId, item_domain: domain, item_type: itemType,
      queryVector,
      spatial: spatial ? { lat: spatial.geometry.coordinates[1], lng: spatial.geometry.coordinates[0], distanceMeters: spatial.distanceMeters } : undefined,
      filters: (message.intent.filters ?? []) as FilterClause[],
      limit: queryVector && deps.rerank.defaultOn ? topN : pagination.limit,
      offset: queryVector && deps.rerank.defaultOn ? 0 : pagination.offset,
    });

    let ordered = rows;
    if (deps.rerank.defaultOn && deps.rerank.baseUrl && message.intent.textSearch && rows.length > 1) {
      const fields = deps.registry.vectorizeFields(networkId, domain, itemType);
      const texts = rows.map((r) => serializeItemText(r.item_state, fields));
      const order = await new TeiReranker({ baseUrl: deps.rerank.baseUrl, model: deps.rerank.model })
        .rerank(message.intent.textSearch, texts);
      ordered = order.map((i) => rows[i]).slice(pagination.offset, pagination.offset + pagination.limit);
    }

    const response = {
      context,
      message: {
        items: ordered.map((r) => ({
          item_network: r.item_network, item_domain: r.item_domain, item_type: r.item_type, item_id: r.item_id,
          item_state: r.item_state, item_locations: r.item_locations,
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
