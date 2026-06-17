import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { cacheKey, getCached, setCached } from './result_cache.js';

let c: StartedTestContainer; let redis: Redis;
beforeAll(async () => { c = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(); redis = new Redis(c.getMappedPort(6379), c.getHost()); });
afterAll(async () => { redis?.disconnect(); await c?.stop(); });

describe('result cache', () => {
  it('is deterministic regardless of key ordering in the request', () => {
    const k1 = cacheKey({ a: 1, b: 2 });
    const k2 = cacheKey({ b: 2, a: 1 });
    expect(k1).toBe(k2);
  });
  it('round-trips a value with TTL', async () => {
    const key = cacheKey({ q: 'x' });
    await setCached(redis, key, { items: [1] }, 60);
    expect(await getCached<{ items: number[] }>(redis, key)).toEqual({ items: [1] });
    expect(await redis.ttl(`search:${key}`)).toBeGreaterThan(0);
  });
  it('returns null on miss', async () => {
    expect(await getCached(redis, cacheKey({ q: 'absent' }))).toBeNull();
  });
});
