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

  it('echoes an inbound x-request-id back on the response', async () => {
    const app = buildServer({ deps: {} as any });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'trace-abc-123' },
    });
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
    await app.close();
  });

  it('generates a correlation id when none is supplied', async () => {
    const app = buildServer({ deps: {} as any });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toMatch(/^req-/);
    await app.close();
  });
});
