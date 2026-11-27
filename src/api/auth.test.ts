import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { authenticateApiKey } from './auth.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
const RAW = 'sk_signals_test_key_abcdefghijklmnopqrstuvwxyz';
const hash = createHash('sha256').update(RAW).digest('base64url');
const RAW_REF_ONLY = 'sk_signals_test_key_reference_only_0123456789';
const hashRefOnly = createHash('sha256').update(RAW_REF_ONLY).digest('base64url');

beforeAll(async () => {
  pg = await startPostgres();
  sql = sqlClient(pg.getConnectionUri());
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, reference_id text NOT NULL, user_id text, enabled boolean NOT NULL DEFAULT true, expires_at timestamp, remaining integer)`;
  await sql`INSERT INTO "apikey" (id, key, reference_id, user_id, enabled) VALUES ('k1', ${hash}, 'usr_1', 'usr_1', true)`;
  await sql`INSERT INTO "apikey" (id, key, reference_id, user_id, enabled) VALUES ('k2', ${hashRefOnly}, 'ref_9', NULL, true)`;
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('authenticateApiKey', () => {
  it('returns the caller for a valid enabled key', async () => {
    const caller = await authenticateApiKey(sql, RAW);
    expect(caller).toEqual({ userId: 'usr_1' });
  });
  it('falls back to reference_id when user_id is NULL, as Signals-DPG does', async () => {
    expect(await authenticateApiKey(sql, RAW_REF_ONLY)).toEqual({ userId: 'ref_9' });
  });
  it('prefers user_id over reference_id when both are set', async () => {
    await sql`UPDATE "apikey" SET reference_id = 'ref_1' WHERE id = 'k1'`;
    expect(await authenticateApiKey(sql, RAW)).toEqual({ userId: 'usr_1' });
    await sql`UPDATE "apikey" SET reference_id = 'usr_1' WHERE id = 'k1'`;
  });
  it('returns null for an unknown key', async () => {
    expect(await authenticateApiKey(sql, 'nope')).toBeNull();
  });
  it('returns null for a disabled key', async () => {
    await sql`UPDATE "apikey" SET enabled = false WHERE id = 'k1'`;
    expect(await authenticateApiKey(sql, RAW)).toBeNull();
    await sql`UPDATE "apikey" SET enabled = true WHERE id = 'k1'`;
  });
  it('returns null for an expired key', async () => {
    await sql`UPDATE "apikey" SET expires_at = now() - interval '1 hour' WHERE id = 'k1'`;
    expect(await authenticateApiKey(sql, RAW)).toBeNull();
    await sql`UPDATE "apikey" SET expires_at = NULL WHERE id = 'k1'`;
  });
  it('accepts a key with a future expires_at', async () => {
    await sql`UPDATE "apikey" SET expires_at = now() + interval '1 day' WHERE id = 'k1'`;
    expect(await authenticateApiKey(sql, RAW)).toEqual({ userId: 'usr_1' });
    await sql`UPDATE "apikey" SET expires_at = NULL WHERE id = 'k1'`;
  });
  it('returns null for an exhausted key (remaining = 0)', async () => {
    await sql`UPDATE "apikey" SET remaining = 0 WHERE id = 'k1'`;
    expect(await authenticateApiKey(sql, RAW)).toBeNull();
    await sql`UPDATE "apikey" SET remaining = NULL WHERE id = 'k1'`;
  });
  it('accepts a key with remaining > 0', async () => {
    await sql`UPDATE "apikey" SET remaining = 5 WHERE id = 'k1'`;
    expect(await authenticateApiKey(sql, RAW)).toEqual({ userId: 'usr_1' });
    await sql`UPDATE "apikey" SET remaining = NULL WHERE id = 'k1'`;
  });
});
