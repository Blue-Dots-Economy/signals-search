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
  auth: { acceptApiKey: true },
} as ApiDeps;

describe('OpenAPI / served docs', () => {
  it('documents POST /v1/search with bearer + apiKey security and request/response schemas', async () => {
    const app = buildServer({ deps });
    await app.ready();
    const spec = app.swagger() as {
      paths: Record<string, Record<string, { security?: unknown; requestBody?: unknown; responses?: Record<string, unknown> }>>;
      components: { securitySchemes: Record<string, unknown> };
    };

    const search = spec.paths['/v1/search']?.post;
    expect(search).toBeTruthy();
    expect(search.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    expect(search.requestBody).toBeTruthy();
    expect(search.responses?.['200']).toBeTruthy();

    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
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
    expect(flat.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    expect(flat.requestBody).toBeTruthy();
    expect(flat.responses?.['200']).toBeTruthy();
    expect(flat.responses?.['400']).toBeTruthy();
    await app.close();
  });

  it('documents POST /v1/relevance with bearer + apiKey security and request/response schemas', async () => {
    const app = buildServer({ deps });
    await app.ready();
    const spec = app.swagger() as {
      paths: Record<string, Record<string, { security?: unknown; requestBody?: unknown; responses?: Record<string, unknown> }>>;
    };
    const relevance = spec.paths['/v1/relevance']?.post;
    expect(relevance).toBeTruthy();
    expect(relevance.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    expect(relevance.requestBody).toBeTruthy();
    expect(relevance.responses?.['200']).toBeTruthy();
    expect(relevance.responses?.['403']).toBeTruthy();
    expect(relevance.responses?.['404']).toBeTruthy();
    expect(relevance.responses?.['409']).toBeTruthy();
    await app.close();
  });

  // Was "serves the spec JSON at /documentation/json" — that route is gone
  // now that swagger-ui is replaced by Scalar (which doesn't serve a bare
  // JSON document route), so this exercises the same OpenAPI-document
  // validity check via the swagger() decorator instead of an HTTP route.
  it('exposes a valid OpenAPI 3.x document via swagger()', async () => {
    const app = buildServer({ deps });
    await app.ready();
    const spec = app.swagger() as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths['/v1/search']).toBeTruthy();
    await app.close();
  });

  it('serves the Scalar reference UI at /api/reference when enabled', async () => {
    const app = buildServer({ deps });
    const res = await app.inject({ method: 'GET', url: '/api/reference' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    await app.close();
  });

  it('registers no docs surface when apiReference is disabled', async () => {
    const app = buildServer({ deps, apiReference: { enabled: false } });
    const res = await app.inject({ method: 'GET', url: '/api/reference' });
    expect(res.statusCode).toBe(404);
    // swagger plugin is skipped too — the decorator must not exist
    expect((app as { swagger?: unknown }).swagger).toBeUndefined();
    await app.close();
  });

  it('embeds the public server URL and package.json version when configured', async () => {
    const app = buildServer({
      deps,
      apiReference: { enabled: true, publicBaseUrl: 'https://search.example.org' },
    });
    await app.ready();
    const spec = app.swagger() as {
      info: { version: string };
      servers?: Array<{ url: string }>;
    };
    expect(spec.servers?.[0]?.url).toBe('https://search.example.org');
    expect(spec.info.version).not.toBe('1.0.0'); // hard-coded literal is gone
    await app.close();
  });
});
