import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';

export type Caller = { userId: string };

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('base64url');
}

export async function authenticateApiKey(sql: Sql, rawKey: string | undefined): Promise<Caller | null> {
  if (!rawKey) return null;
  const hashed = hashApiKey(rawKey);
  // Same validity checks and hash as Signals-DPG's verifyApiKey: enabled, not
  // expired, not exhausted. `remaining` is read, never decremented; neither
  // service writes it. Keys are minted by Signals-DPG's service-user provisioning
  // (provision_service_users.sql, seed_service_users.ts). The owner is
  // `user_id`, falling back to `reference_id`, as in Signals-DPG.
  const rows = await sql<{ owner_id: string | null }[]>`
    SELECT COALESCE(user_id, reference_id) AS owner_id FROM "apikey"
    WHERE key = ${hashed}
      AND enabled = true
      AND (expires_at IS NULL OR expires_at > now())
      AND (remaining IS NULL OR remaining > 0)
    LIMIT 1`;
  if (rows.length === 0 || !rows[0].owner_id) return null;
  return { userId: rows[0].owner_id };
}
