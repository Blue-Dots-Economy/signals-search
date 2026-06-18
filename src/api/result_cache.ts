import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function cacheKey(normalizedRequest: unknown): string {
  return createHash('sha256').update(stableStringify(normalizedRequest)).digest('hex');
}

export async function getCached<T>(redis: Redis, key: string): Promise<T | null> {
  const raw = await redis.get(`search:${key}`);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function setCached(redis: Redis, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  await redis.set(`search:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
}
