import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ApiDeps } from './server.js';
import { RelevanceRequestSchema, RelevanceResponseSchema, ErrorSchema } from './schemas.js';
import { authenticateApiKey } from './auth.js';
import { computeRelevance } from '../db/relevance_query.js';

/**
 * Cosine similarity (in [-1, 1]) → relevance percentage (in [0, 100]).
 * Negative similarities (opposite-facing vectors) clamp to 0: there is no
 * meaningful "negative relevance" to surface to a caller. Rounded to 2 dp.
 */
export function similarityToPercentage(similarity: number): number {
  const clamped = Math.max(0, Math.min(100, similarity * 100));
  return Number(clamped.toFixed(2));
}

export function registerRelevanceRoute(app: FastifyInstance, deps: ApiDeps): void {
  app.withTypeProvider<ZodTypeProvider>().post('/v1/relevance', {
    schema: {
      tags: ['relevance'],
      summary: 'Relevance score between two indexed items',
      description:
        'Computes how relevant two items are to each other as a percentage (0–100), from the ' +
        'cosine similarity of their stored embeddings. Both items must already be indexed in ' +
        'item_search. Score only — no band/confidence/reasoning.',
      security: [{ apiKeyAuth: [] }],
      body: RelevanceRequestSchema,
      response: {
        200: RelevanceResponseSchema,
        400: ErrorSchema,
        401: ErrorSchema,
        404: ErrorSchema,
      },
    },
  }, async (request, reply) => {
    const caller = await authenticateApiKey(deps.sql, request.headers['x-api-key'] as string | undefined);
    if (!caller) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'valid x-api-key required' });
    }

    // Body is already validated by the Zod route schema (type provider).
    const { itemA, itemB } = request.body;
    const similarity = await computeRelevance(deps.sql, itemA, itemB);
    if (similarity === null) {
      return reply.code(404).send({
        error: 'RELEVANCE_ITEMS_NOT_INDEXED',
        message: 'both items must be indexed with an embedding to compute relevance',
      });
    }
    return reply.code(200).send({ score: similarityToPercentage(similarity) });
  });
}
