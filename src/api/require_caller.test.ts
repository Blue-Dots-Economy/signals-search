import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { startJwksServer, type JwksHarness } from '../../test/support/jwks.js';
import { requireCaller } from './require_caller.js';
import { resetKeycloakJwksCacheForTests } from './auth.js';
import type { ApiDeps } from './server.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Unit-level: no containers. The bearer path is purely cryptographic, and the
 * api-key path only needs `sql` to answer one query — so a tagged-template stub
 * stands in for Postgres and the whole gate (statuses + the caller log line) is
 * exercised in milliseconds.
 */
const sqlStub = (async () => [{ user_id: 'usr_1' }]) as unknown as ApiDeps['sql'];
const sqlNoRows = (async () => []) as unknown as ApiDeps['sql'];

let jwks: JwksHarness;
let log: { info: ReturnType<typeof vi.fn> };

beforeAll(async () => {
  jwks = await startJwksServer();
});
afterAll(async () => {
  await jwks?.close();
});
beforeEach(() => {
  resetKeycloakJwksCacheForTests();
  jwks.setFailing(false);
  log = { info: vi.fn() };
});

function fakeRequest(headers: Record<string, string>): FastifyRequest {
  return { headers, log } as unknown as FastifyRequest;
}

function fakeReply() {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      sent.status = status;
      return reply;
    },
    async send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

const deps = (auth: ApiDeps['auth'], sql = sqlStub) => ({ sql, auth }) as ApiDeps;

const keycloakAuth = () => ({
  acceptApiKey: true,
  keycloak: {
    issuer: jwks.issuer,
    jwksUri: jwks.jwksUri,
    audience: 'signals-search',
    serviceClientIds: ['signals-search'],
    jwksCacheMaxAgeMs: 600_000,
    clockToleranceSeconds: 0,
  },
});

describe('requireCaller', () => {
  it('logs the credential kind and client id for a bearer caller', async () => {
    const { reply, sent } = fakeReply();
    const token = await jwks.mint();
    const caller = await requireCaller(
      deps(keycloakAuth()),
      fakeRequest({ authorization: `Bearer ${token}` }),
      reply,
    );
    expect(caller).toMatchObject({ kind: 'service', clientId: 'signals-search' });
    expect(sent.status).toBeUndefined(); // nothing answered; the route continues
    // The rollout gate for AUTH_ACCEPT_API_KEY=false reads off exactly this.
    expect(log.info).toHaveBeenCalledWith(
      { credential: 'bearer', clientId: 'signals-search' },
      'authenticated request',
    );
  });

  it('logs the api-key path by KIND only — never the userId', async () => {
    const { reply } = fakeReply();
    const caller = await requireCaller(
      deps(keycloakAuth()),
      fakeRequest({ 'x-api-key': 'sk_whatever' }),
      reply,
    );
    expect(caller).toEqual({ kind: 'api_key', userId: 'usr_1' });
    expect(log.info).toHaveBeenCalledWith({ credential: 'api_key' }, 'authenticated request');
    const [payload] = log.info.mock.calls[0] as [Record<string, unknown>];
    expect(payload).not.toHaveProperty('userId');
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('usr_1');
  });

  it('answers 403 and logs nothing for a token from a client that may not search', async () => {
    const { reply, sent } = fakeReply();
    const token = await jwks.mint({ azp: 'aggregator-dpg' });
    const caller = await requireCaller(
      deps(keycloakAuth()),
      fakeRequest({ authorization: `Bearer ${token}` }),
      reply,
    );
    expect(caller).toBeNull();
    expect(sent.status).toBe(403);
    expect(sent.body).toMatchObject({ error: 'CLIENT_NOT_PERMITTED' });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('answers 503 — not 401 — while Keycloak is unreachable', async () => {
    const { reply, sent } = fakeReply();
    const token = await jwks.mint();
    jwks.setFailing(true);
    const caller = await requireCaller(
      deps(keycloakAuth()),
      fakeRequest({ authorization: `Bearer ${token}` }),
      reply,
    );
    expect(caller).toBeNull();
    expect(sent.status).toBe(503);
    expect(sent.body).toMatchObject({ error: 'AUTH_PROVIDER_UNAVAILABLE' });
  });

  it('answers 401 with no credential at all', async () => {
    const { reply, sent } = fakeReply();
    const caller = await requireCaller(deps(keycloakAuth(), sqlNoRows), fakeRequest({}), reply);
    expect(caller).toBeNull();
    expect(sent.status).toBe(401);
    expect(sent.body).toMatchObject({ error: 'UNAUTHORIZED' });
  });
});
