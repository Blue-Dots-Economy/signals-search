import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startJwksServer, type JwksHarness } from '../../test/support/jwks.js';
import {
  extractBearerToken,
  resetKeycloakJwksCache,
  verifyKeycloakToken,
  type KeycloakAuthConfig,
} from './keycloak_token.js';

/**
 * Find a port nothing is listening on: start a throwaway server, read the
 * port the OS assigned, close it immediately. Deterministic — no guessing at
 * an unused port and risking a flaky collision with something else on the
 * box.
 */
async function closedLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  return port;
}

let jwks: JwksHarness;
let cfg: KeycloakAuthConfig;

beforeAll(async () => {
  jwks = await startJwksServer();
});
afterAll(async () => {
  await jwks.close();
});

beforeEach(() => {
  resetKeycloakJwksCache();
  jwks.setFailing(false);
  cfg = {
    issuer: jwks.issuer,
    jwksUri: jwks.jwksUri,
    audience: 'signals-search',
    serviceClientIds: ['signals-search', 'voice-dpg'],
    jwksCacheMaxAgeMs: 600_000,
    clockToleranceSeconds: 0,
  };
});

describe('extractBearerToken', () => {
  it('pulls the token out of a Bearer header, case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer   abc.def.ghi  ')).toBe('abc.def.ghi');
  });
  it('returns undefined for a missing, empty, or non-bearer header', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('Bearer   ')).toBeUndefined();
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
  });
  it('reads the first value when the header arrives as an array', () => {
    expect(extractBearerToken(['Bearer abc.def.ghi', 'Bearer zzz'])).toBe('abc.def.ghi');
  });
});

describe('verifyKeycloakToken', () => {
  it('accepts a token from an allowlisted client that names the audience', async () => {
    const token = await jwks.mint({ azp: 'voice-dpg' });
    const result = await verifyKeycloakToken(token, cfg);
    expect(result).toEqual({
      ok: true,
      caller: { clientId: 'voice-dpg', sub: '11111111-2222-3333-4444-555555555555' },
    });
  });

  it('rejects a token whose aud does not name signals-search', async () => {
    // The shared-realm case: a valid service token minted for Signals.
    const token = await jwks.mint({ azp: 'voice-dpg', aud: ['signals-api', 'account'] });
    const result = await verifyKeycloakToken(token, cfg);
    expect(result).toMatchObject({ ok: false, code: 'TOKEN_CLIENT_REJECTED' });
  });

  it('rejects an allowlisted audience from a non-allowlisted client', async () => {
    const token = await jwks.mint({ azp: 'aggregator-dpg' });
    const result = await verifyKeycloakToken(token, cfg);
    expect(result).toMatchObject({ ok: false, code: 'TOKEN_CLIENT_REJECTED' });
  });

  it('falls back to the service-account username when azp and client_id are absent', async () => {
    const token = await jwks.mint({
      azp: null,
      claims: { preferred_username: 'service-account-voice-dpg' },
    });
    const result = await verifyKeycloakToken(token, cfg);
    expect(result).toEqual({
      ok: true,
      caller: { clientId: 'voice-dpg', sub: '11111111-2222-3333-4444-555555555555' },
    });
  });

  it('reports an expired token distinctly from an invalid one', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await jwks.mint({ expiresIn: past });
    const result = await verifyKeycloakToken(token, cfg);
    expect(result).toMatchObject({ ok: false, code: 'TOKEN_EXPIRED' });
  });

  it('rejects a token signed by a key outside the published JWKS', async () => {
    const token = await jwks.mint({ signWithForeignKey: true });
    const result = await verifyKeycloakToken(token, cfg);
    expect(result).toMatchObject({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('rejects a token from another issuer', async () => {
    const token = await jwks.mint({ iss: 'https://evil.example/realms/bluedots' });
    const result = await verifyKeycloakToken(token, cfg);
    expect(result).toMatchObject({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('rejects a token with no sub claim', async () => {
    const token = await jwks.mint({ sub: null });
    const result = await verifyKeycloakToken(token, cfg);
    expect(result).toMatchObject({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('rejects a syntactically broken token', async () => {
    const result = await verifyKeycloakToken('not-a-jwt', cfg);
    expect(result).toMatchObject({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('reports a JWKS fetch failure as an outage, not an auth failure', async () => {
    const token = await jwks.mint();
    jwks.setFailing(true);
    const result = await verifyKeycloakToken(token, cfg);
    expect(result).toMatchObject({ ok: false, code: 'KEYCLOAK_UNAVAILABLE' });
  });

  it('reports a connection-level JWKS failure (refused connection) as an outage too', async () => {
    // Unlike the 500-from-Keycloak case above, this never reaches an HTTP
    // response at all: `createRemoteJWKSet`'s underlying `fetch` throws a
    // `TypeError` whose real errno is nested under `.cause.code`, not on the
    // error itself. Exercises that branch specifically.
    const port = await closedLoopbackPort();
    resetKeycloakJwksCache();
    const unreachableCfg: KeycloakAuthConfig = {
      ...cfg,
      jwksUri: `http://127.0.0.1:${port}/realms/bluedots/protocol/openid-connect/certs`,
    };
    const token = await jwks.mint();
    const result = await verifyKeycloakToken(token, unreachableCfg);
    expect(result).toMatchObject({ ok: false, code: 'KEYCLOAK_UNAVAILABLE' });
  });

  it('fetches the key set once across repeated verifications', async () => {
    const before = jwks.requests();
    await verifyKeycloakToken(await jwks.mint(), cfg);
    await verifyKeycloakToken(await jwks.mint(), cfg);
    expect(jwks.requests()).toBe(before + 1);
  });
});
