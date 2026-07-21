import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import type { Embedder } from '../embedding/provider.js';
import type { NetworkRegistry } from '../config/network_registry.js';
import { registerSearchRoute } from './search_route.js';

export type ApiDeps = {
  sql: Sql;
  redis: Redis;
  embedder: Embedder;
  registry: NetworkRegistry;
  rerank: { baseUrl?: string; model: string; defaultOn: boolean; topN: number };
  cacheTtlSeconds: number;
  embeddingDim: number;
  defaultDistanceMeters: number;
};

export function buildServer(opts: { deps: ApiDeps }): FastifyInstance {
  const app = Fastify({
    // Redact credential headers so a raw API key can never reach the logs,
    // even if a custom/error serializer ever emits request headers.
    logger: { redact: ['req.headers["x-api-key"]', 'req.headers.authorization'] },
    // Correlation id: always run genReqId (requestIdHeader:false) so we can
    // read AND length-cap an inbound `x-request-id` (from Kong or an upstream
    // caller), falling back to a generated id. Logged as `reqId`.
    requestIdHeader: false,
    requestIdLogLabel: 'reqId',
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 200) {
        return incoming;
      }
      return `req-${randomUUID()}`;
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Echo the resolved correlation id back so callers/Kong can stitch the trace.
  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });

  // Route schemas are now Zod (so they self-document via @fastify/swagger). Map the
  // type provider's request-validation failures back to the service's stable 400
  // contract; everything else falls through to default handling (e.g. 500).
  app.setErrorHandler((err, _req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: err.message });
    }
    return reply.send(err);
  });

  // OpenAPI generation from the route Zod schemas (must be registered before the
  // routes so its onRoute hook captures them — hence routes live in the deferred
  // plugin below). Served as a spec at /documentation/json and a UI at /documentation.
  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Signals Search API',
        version: '1.0.0',
        description:
          'V1 search & discovery for Signals-DPG (pgvector + PostGIS). Meaning + geo + ' +
          'structured search over the shared Signals database. Auth: x-api-key header.',
      },
      components: {
        securitySchemes: {
          apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        },
      },
      tags: [
        { name: 'search', description: 'Item search & discovery' },
        { name: 'health', description: 'Operational probes' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  app.register(fastifySwaggerUi, { routePrefix: '/documentation' });

  // Routes in a deferred plugin so they register AFTER the swagger plugin's onRoute
  // hook is in place (otherwise they wouldn't appear in the generated spec).
  app.register(async (instance) => {
    instance.withTypeProvider<ZodTypeProvider>().get(
      '/health',
      {
        schema: {
          tags: ['health'],
          summary: 'Liveness probe',
          security: [],
          response: { 200: z.object({ status: z.string() }) },
        },
      },
      async () => ({ status: 'ok' }),
    );
    registerSearchRoute(instance, opts.deps);
  });

  return app;
}
