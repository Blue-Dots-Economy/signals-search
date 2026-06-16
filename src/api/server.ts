import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import type { Embedder } from '../embedding/provider.js';
import type { NetworkRegistry } from '../config/network_registry.js';

export type ApiDeps = {
  sql: Sql;
  redis: Redis;
  embedder: Embedder;
  registry: NetworkRegistry;
  rerank: { baseUrl?: string; model: string; defaultOn: boolean; topN: number };
  cacheTtlSeconds: number;
  embeddingDim: number;
};

export function buildServer(opts: { deps: ApiDeps }): FastifyInstance {
  const app = Fastify({ logger: true });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.get('/health', async () => ({ status: 'ok' }));
  // registerSearchRoute(app, opts.deps)  // added in Task 8
  return app;
}
