import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
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
  // Pins the key ordering to UTF-16 code-unit order, which is locale-independent
  // and identical across ICU builds. A String.localeCompare comparator would sort
  // these the other way ('a' before 'B', 'ä' before 'z') and change every hash,
  // so this fails loudly if the comparator is ever swapped for a locale-aware one.
  it('orders keys by code unit, not locale, when hashing', () => {
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(cacheKey({ a: 2, B: 1 })).toBe(sha('{"B":1,"a":2}'));
    expect(cacheKey({ 'ä': 1, z: 2 })).toBe(sha('{"z":2,"\u00e4":1}'));
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
