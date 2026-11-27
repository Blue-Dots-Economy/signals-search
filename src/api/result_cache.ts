import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

// Not String.localeCompare (which typescript:S2871 suggests): the order feeds a
// cache key shared by every replica, and localeCompare depends on locale and ICU
// build. UTF-16 code-unit order matches a bare .sort(), keeping keys stable.
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function stableEntry(obj: Record<string, unknown>, key: string): string {
  return `${JSON.stringify(key)}:${stableStringify(obj[key])}`;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const entries = Object.keys(obj).sort(compareCodeUnits).map((k) => stableEntry(obj, k));
    return `{${entries.join(',')}}`;
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
