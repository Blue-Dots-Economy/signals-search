import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ApiDeps } from './server.js';
import { RelevanceRequestSchema, RelevanceResponseSchema, ErrorSchema } from './schemas.js';
import { authenticateRequest } from './auth.js';
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
        'cosine similarity of their stored embeddings. source→target (network + domain) must be ' +
        'an allowed interaction (interaction matrix, cross-network included), and both items must ' +
        'be live + indexed with embeddings from the same model version. Score only — no ' +
        'band/confidence/reasoning.',
      // An array of alternatives: EITHER credential authenticates the call.
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: RelevanceRequestSchema,
      response: {
        200: RelevanceResponseSchema,
        400: ErrorSchema,
        401: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
  }, async (request, reply) => {
    const auth = await authenticateRequest(
      {
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'] as string | undefined,
      },
      { sql: deps.sql, auth: deps.auth },
    );
    if (!auth.ok) {
      return reply
        .code(auth.failure.status)
        .send({ error: auth.failure.error, message: auth.failure.message });
    }

    // Body is already validated by the Zod route schema (type provider).
    const { source, target } = request.body;

    // Authorization: scoring reads the target item as context, so it is gated on
    // the interaction matrix (.claude/rules/pii-and-authz.md), like the anchor
    // path in search_route.ts. source→target (network + domain) must match an
    // allowed interaction — cross-network pairs included. The network/domain
    // used here are the SAME values the PK lookup uses below, so a caller cannot
    // spoof them to pass this check and still score a real row — a mismatched PK
    // simply yields not-found.
    const allowed = deps.registry.isInteractionAllowedAcross(
      source.network, source.domain, target.network, target.domain,
    );
    if (!allowed) {
      return reply.code(403).send({
        error: 'INTERACTION_NOT_ALLOWED',
        message: `${source.network}/${source.domain} → ${target.network}/${target.domain} not permitted`,
      });
    }

    const outcome = await computeRelevance(
      deps.sql,
      { item_network: source.network, item_domain: source.domain, item_type: source.type, item_id: source.id },
      { item_network: target.network, item_domain: target.domain, item_type: target.type, item_id: target.id },
    );
    if (outcome.status === 'not_found') {
      return reply.code(404).send({
        error: 'RELEVANCE_ITEMS_NOT_INDEXED',
        message: 'both items must be live and indexed with an embedding to compute relevance',
      });
    }
    if (outcome.status === 'not_comparable') {
      return reply.code(409).send({
        error: 'RELEVANCE_NOT_COMPARABLE',
        message: 'items were embedded with different model versions and cannot be compared',
      });
    }
    return reply.code(200).send({ score: similarityToPercentage(outcome.similarity) });
  });
}
