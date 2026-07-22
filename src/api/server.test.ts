import { describe, it, expect } from 'vitest';
import { buildServer } from './server.js';

describe('buildServer', () => {
  it('serves GET /health', async () => {
    const app = buildServer({ deps: {} as any });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /ready returns 200 when Postgres + Redis are reachable', async () => {
    const deps = {
      sql: () => Promise.resolve([{ ok: 1 }]),
      redis: { ping: async () => 'PONG' },
    } as any;
    const app = buildServer({ deps });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('GET /ready returns 503 and names the failing dependency', async () => {
    const deps = {
      sql: () => Promise.reject(new Error('pg down')),
      redis: { ping: async () => 'PONG' },
    } as any;
    const app = buildServer({ deps });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'not_ready',
      checks: { postgres: 'error', redis: 'ok' },
    });
    await app.close();
  });
});
