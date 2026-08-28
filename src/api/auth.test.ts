import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { authenticateApiKey, authenticateRequest, resetKeycloakJwksCacheForTests, type AuthConfig } from './auth.js';
import { startJwksServer, type JwksHarness } from '../../test/support/jwks.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
const RAW = 'sk_signals_test_key_abcdefghijklmnopqrstuvwxyz';
const hash = createHash('sha256').update(RAW).digest('base64url');

let jwks: JwksHarness;
let authWithKeycloak: AuthConfig;

beforeAll(async () => {
  pg = await startPostgres();
  sql = sqlClient(pg.getConnectionUri());
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, user_id text, enabled boolean NOT NULL DEFAULT true, expires_at timestamp, remaining integer)`;
  await sql`INSERT INTO "apikey" (id, key, user_id, enabled) VALUES ('k1', ${hash}, 'usr_1', true)`;

  jwks = await startJwksServer();
  authWithKeycloak = {
    acceptApiKey: true,
    keycloak: {
      issuer: jwks.issuer,
      jwksUri: jwks.jwksUri,
      audience: 'signals-search',
      serviceClientIds: ['signals-search'],
      jwksCacheMaxAgeMs: 600_000,
      clockToleranceSeconds: 0,
    },
  };
});
afterAll(async () => {
  await sql?.end();
  await pg?.stop();
  await jwks?.close();
});

describe('authenticateApiKey', () => {
  it('returns the caller for a valid enabled key', async () => {
    const caller = await authenticateApiKey(sql, RAW);
    expect(caller).toEqual({ userId: 'usr_1' });
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

describe('authenticateRequest', () => {
  it('accepts a valid bearer token as a service caller', async () => {
    const token = await jwks.mint();
    const result = await authenticateRequest(
      { authorization: `Bearer ${token}` },
      { sql, auth: authWithKeycloak },
    );
    expect(result).toEqual({
      ok: true,
      caller: { kind: 'service', clientId: 'signals-search', sub: '11111111-2222-3333-4444-555555555555' },
    });
  });

  it('accepts an x-api-key while the dual-accept flag is on', async () => {
    const result = await authenticateRequest({ apiKey: RAW }, { sql, auth: authWithKeycloak });
    expect(result).toEqual({ ok: true, caller: { kind: 'api_key', userId: 'usr_1' } });
  });

  it('rejects an x-api-key once the flag is off, even a valid one', async () => {
    const result = await authenticateRequest(
      { apiKey: RAW },
      { sql, auth: { ...authWithKeycloak, acceptApiKey: false } },
    );
    expect(result).toMatchObject({ ok: false, failure: { status: 401, error: 'UNAUTHORIZED' } });
  });

  it('does not fall back to the api key when a bearer token is present but bad', async () => {
    // A caller sending both must be judged on the bearer token — falling back
    // would let a stale key mask a broken token rollout.
    const result = await authenticateRequest(
      { authorization: 'Bearer not-a-jwt', apiKey: RAW },
      { sql, auth: authWithKeycloak },
    );
    expect(result).toMatchObject({ ok: false, failure: { status: 401 } });
  });

  it('answers 403 for a valid token from a client that may not search', async () => {
    const token = await jwks.mint({ azp: 'aggregator-dpg' });
    const result = await authenticateRequest(
      { authorization: `Bearer ${token}` },
      { sql, auth: authWithKeycloak },
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { status: 403, error: 'CLIENT_NOT_PERMITTED' },
    });
  });

  it('answers 503 — not 401 — when Keycloak cannot be reached', async () => {
    resetKeycloakJwksCacheForTests();
    const token = await jwks.mint();
    jwks.setFailing(true);
    const result = await authenticateRequest(
      { authorization: `Bearer ${token}` },
      { sql, auth: authWithKeycloak },
    );
    jwks.setFailing(false);
    expect(result).toMatchObject({
      ok: false,
      failure: { status: 503, error: 'AUTH_PROVIDER_UNAVAILABLE' },
    });
  });

  it('falls through to the api key for a bearer header when no Keycloak is configured', async () => {
    // With no Keycloak there is no token rollout for a stale key to mask, and a
    // BFF forwarding its end user's Authorization header alongside its own
    // service credential is a real shape — so the header is ignored, not refused.
    const token = await jwks.mint();
    const result = await authenticateRequest(
      { authorization: `Bearer ${token}`, apiKey: RAW },
      { sql, auth: { acceptApiKey: true } },
    );
    expect(result).toEqual({ ok: true, caller: { kind: 'api_key', userId: 'usr_1' } });
  });

  it('401s a bearer-only request when no Keycloak is configured', async () => {
    const token = await jwks.mint();
    const result = await authenticateRequest(
      { authorization: `Bearer ${token}` },
      { sql, auth: { acceptApiKey: true } },
    );
    expect(result).toMatchObject({ ok: false, failure: { status: 401 } });
    // ...and does not advertise a credential this deployment cannot accept.
    expect(result.ok === false && result.failure.message).toBe('valid x-api-key required');
  });

  it('rejects a request with no credential at all', async () => {
    const result = await authenticateRequest({}, { sql, auth: authWithKeycloak });
    expect(result).toMatchObject({ ok: false, failure: { status: 401 } });
  });
});
