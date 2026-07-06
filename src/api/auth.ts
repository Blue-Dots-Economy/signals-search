import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';

export type Caller = { userId: string };

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('base64url');
}

export async function authenticateApiKey(sql: Sql, rawKey: string | undefined): Promise<Caller | null> {
  if (!rawKey) return null;
  const hashed = hashApiKey(rawKey);
  // Validity mirrors better-auth's own gate: not-disabled, not-expired,
  // not-exhausted. We READ remaining but never decrement it — better-auth
  // (Signals-DPG) owns the key write path; a decrement here would race it.
  // Hash-scheme parity with better-auth is verified separately (PLAN.md 2.2).
  const rows = await sql<{ user_id: string | null }[]>`
    SELECT user_id FROM "apikey"
    WHERE key = ${hashed}
      AND enabled = true
      AND (expires_at IS NULL OR expires_at > now())
      AND (remaining IS NULL OR remaining > 0)
    LIMIT 1`;
  if (rows.length === 0 || !rows[0].user_id) return null;
  return { userId: rows[0].user_id };
}
