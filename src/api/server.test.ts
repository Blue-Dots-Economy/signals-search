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
});
