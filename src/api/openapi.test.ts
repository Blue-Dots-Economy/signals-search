import { describe, it, expect } from 'vitest';
import { buildServer, type ApiDeps } from './server.js';

// No DB/Redis needed: ready() + swagger() only exercise route registration and
// OpenAPI generation, not the handlers. Stub deps satisfy the types.
const deps = {
  sql: {} as ApiDeps['sql'],
  redis: {} as ApiDeps['redis'],
  embedder: { embed: async () => [] },
  registry: {} as ApiDeps['registry'],
  rerank: { model: 'r', defaultOn: false, topN: 50 },
  cacheTtlSeconds: 0,
  embeddingDim: 1024,
  defaultDistanceMeters: 30000,
} as ApiDeps;

describe('OpenAPI / served docs', () => {
  it('documents POST /v1/search with apiKey security and request/response schemas', async () => {
    const app = buildServer({ deps });
    await app.ready();
    const spec = app.swagger() as {
      paths: Record<string, Record<string, { security?: unknown; requestBody?: unknown; responses?: Record<string, unknown> }>>;
      components: { securitySchemes: Record<string, unknown> };
    };

    const search = spec.paths['/v1/search']?.post;
    expect(search).toBeTruthy();
    expect(search.security).toEqual([{ apiKeyAuth: [] }]);
    expect(search.requestBody).toBeTruthy();
    expect(search.responses?.['200']).toBeTruthy();

    expect(spec.components.securitySchemes.apiKeyAuth).toMatchObject({
      type: 'apiKey', in: 'header', name: 'x-api-key',
    });

    expect(spec.paths['/health']?.get).toBeTruthy();
    await app.close();
  });

  it('documents POST /v1/search/flat (the Raya-compatible flattened wrapper)', async () => {
    const app = buildServer({ deps });
    await app.ready();
    const spec = app.swagger() as {
      paths: Record<string, Record<string, { security?: unknown; requestBody?: unknown; responses?: Record<string, unknown> }>>;
    };
    const flat = spec.paths['/v1/search/flat']?.post;
    expect(flat).toBeTruthy();
    expect(flat.security).toEqual([{ apiKeyAuth: [] }]);
    expect(flat.requestBody).toBeTruthy();
    expect(flat.responses?.['200']).toBeTruthy();
    expect(flat.responses?.['400']).toBeTruthy();
    await app.close();
  });

  it('serves the spec JSON at /documentation/json', async () => {
    const app = buildServer({ deps });
    const res = await app.inject({ method: 'GET', url: '/documentation/json' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toMatch(/^3\./);
    expect(body.paths['/v1/search']).toBeTruthy();
    await app.close();
  });
});
