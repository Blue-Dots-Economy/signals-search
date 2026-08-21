# Keycloak Bearer Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace signals-search's `x-api-key` credential with Keycloak client-credentials bearer validation, keeping `x-api-key` accepted behind a flag for a dual-accept migration window.

**Architecture:** A new pure module (`src/api/keycloak_token.ts`) verifies a bearer token against the realm JWKS — signature, `iss`, `exp`/`nbf`, then a **two-part client gate**: `aud` must name `signals-search` AND the token's client id must be in an allowlist. `src/api/auth.ts` gains a single `authenticateRequest` resolver that picks bearer or api-key per request and returns a typed failure carrying its own HTTP status. The three authenticated routes call that one resolver. Nothing touches Postgres on the bearer path.

**Tech Stack:** Node 24, TypeScript (ESM, `.js` import specifiers), Fastify 5 + `fastify-type-provider-zod`, zod 4, `jose` ^6 (new dependency), vitest + Testcontainers.

**Spec:** https://github.com/Blue-Dots-Economy/signals-search/issues/108 — plus the decisions resolved after it was filed, restated below. Reference implementations to read before starting:
- `Signals-DPG/apps/api/src/utils/keycloak_token.ts` — JWKS memoisation, outage-vs-bad-token discrimination, the audience gate
- `Signals-DPG/apps/api/src/utils/__tests__/keycloak_token.test.ts` — the loopback-JWKS test pattern this plan reuses
- `Signals-DPG/infra/keycloak/README.md` — shared-realm caveats

## Global Constraints

- **Realm client is `signals-search`** — a single confidential client that is both the resource server (the `aud` every caller must name) and the credential Signals-DPG uses to mint tokens. Its service account is enabled. Callers keep their own clients: `voice-dpg` mints with `azp: voice-dpg` and gains a second audience mapper naming `signals-search`.
- **The client gate is `aud` AND `azp`, not either/or.** Signals' `verifyKeycloakToken` accepts on an `azp` *or* `aud` match; signals-search must require both. The realm is shared, so `azp`-only would admit any allowlisted service token minted for Signals, and `aud`-only would admit any client handed an audience mapper.
- **Nothing throws on an auth failure.** Every route in this repo answers `reply.code(N).send({ error, message })`. A verification failure is a value.
- **A Keycloak outage is `503`, never `401`.** Signals-DPG's discover BFF falls back to a native path when signals-search fails; a 401 storm during a JWKS blip would read as every credential breaking at once.
- **`GET /health` and `GET /ready` stay unauthenticated** (`security: []`), unchanged.
- **Service clients only — there is no human path.** Signals keeps two lists (`KEYCLOAK_ACCEPTED_CLIENT_IDS` for humans, `KEYCLOAK_SERVICE_CLIENT_IDS` for integrating DPGs) and a realm-role gate on top. signals-search has one list and no realm-role check, because it has no browser callers: Signals-DPG's BFF fronts every user-facing search. A token held by a browser can therefore never be honoured here, by construction.
- **`userId` is not carried forward as a per-caller scope.** Nothing downstream reads it today. The bearer path produces `{ kind: 'service', clientId, sub }` for logging only.
- **Realm and caller-side changes are out of scope for this plan.** The realm JSON edit (both producers: `Signals-DPG/infra/keycloak/realms/bluedots-realm.json` and `aggregator-dpg/infra/keycloak/realms/realm.json`), the Signals-DPG outbound token mint+cache helper, and voice-dpg's migration each land as their own PR. This plan ships the server side, dual-accept, so it is deployable before any caller moves.
- **ESM import specifiers end in `.js`** even for TypeScript sources. Match the existing files.
- **Branch:** cut from `origin/feature`; PR targets `feature`. `Closes #108` does not auto-fire on a merge into `feature` — use `Part of #108`.
- **Commands:** `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm spec:dump`.

## Config to add (exact names)

| Var | Default | Meaning |
|---|---|---|
| `KEYCLOAK_BASE_URL` | unset | Browser-facing realm base. **Unset = bearer auth disabled entirely.** |
| `KEYCLOAK_INTERNAL_BASE_URL` | falls back to `KEYCLOAK_BASE_URL` | In-cluster base used for the JWKS fetch. |
| `KEYCLOAK_REALM` | `bluedots` | Realm name. |
| `KEYCLOAK_AUDIENCE` | `signals-search` | Value that must appear in the token's `aud`. |
| `KEYCLOAK_SERVICE_CLIENT_IDS` | `''` | Comma-separated allowlist. Required (non-empty) when `KEYCLOAK_BASE_URL` is set. |
| `KEYCLOAK_JWKS_CACHE_MAX_AGE_MS` | `600000` | Passed to jose's remote key set. |
| `KEYCLOAK_CLOCK_TOLERANCE_SECONDS` | `30` | `exp`/`nbf` skew allowance. |
| `AUTH_ACCEPT_API_KEY` | `true` | The dual-accept flag. Set `false` to retire `x-api-key`. |

## File Structure

**Create**
- `src/api/keycloak_token.ts` — bearer extraction + JWKS verification + the client gate. Pure: config arrives as a parameter, so no module mocking in tests.
- `src/api/keycloak_token.test.ts`
- `test/support/jwks.ts` — loopback JWKS server + token minter, shared by three test files.

**Modify**
- `src/api/auth.ts` — keep `hashApiKey`/`authenticateApiKey` as-is; add `Caller`, `AuthConfig`, `authenticateRequest`.
- `src/api/auth.test.ts` — add the dual-accept cases.
- `src/config.ts` — the `KEYCLOAK_*` / `AUTH_ACCEPT_API_KEY` env block, `Config.auth`, fail-fast validation.
- `src/config.test.ts`
- `src/api/server.ts` — `ApiDeps.auth`, the `bearerAuth` security scheme, the spec description.
- `src/api/main.ts` — pass `cfg.auth` into deps.
- `src/api/search_route.ts` — `requireCaller` replaces `requireApiKey`; add `503` to the response map; per-route `security`.
- `src/api/relevance_route.ts` — same.
- `scripts/dump-openapi.ts`, `src/api/search_route.test.ts`, `src/api/search_flat_route.test.ts`, `src/api/relevance_route.test.ts`, `src/api/search_route_rerank.test.ts`, `src/api/server.test.ts`, `src/api/openapi.test.ts` — every `buildServer` caller needs the new required `auth` dep.
- `openapi.json` — regenerated, never hand-edited.
- `.env.example`, `README.md`, `CLAUDE.md`.

**Interfaces at a glance** (later tasks depend on these exact names)

```ts
// keycloak_token.ts
type KeycloakAuthConfig = { issuer: string; jwksUri: string; audience: string;
  serviceClientIds: string[]; jwksCacheMaxAgeMs: number; clockToleranceSeconds: number };
type ServiceCaller = { clientId: string; sub: string };
type KeycloakTokenErrorCode = 'TOKEN_INVALID' | 'TOKEN_EXPIRED' | 'TOKEN_CLIENT_REJECTED' | 'KEYCLOAK_UNAVAILABLE';
type KeycloakTokenResult = { ok: true; caller: ServiceCaller } | { ok: false; code: KeycloakTokenErrorCode; message: string };
function extractBearerToken(authorization: string | string[] | undefined): string | undefined;
function verifyKeycloakToken(token: string, cfg: KeycloakAuthConfig): Promise<KeycloakTokenResult>;
function resetKeycloakJwksCache(): void;

// auth.ts
type Caller = { kind: 'service'; clientId: string; sub: string } | { kind: 'api_key'; userId: string };
type AuthConfig = { keycloak?: KeycloakAuthConfig; acceptApiKey: boolean };
type AuthFailure = { status: 401 | 403 | 503; error: string; message: string };
type AuthResult = { ok: true; caller: Caller } | { ok: false; failure: AuthFailure };
function authenticateRequest(
  headers: { authorization?: string | string[]; apiKey?: string },
  deps: { sql: Sql; auth: AuthConfig },
): Promise<AuthResult>;

// config.ts
type Config = { /* ...existing... */ auth: AuthConfig };
```

---

### Task 1: JWKS verification module

**Files:**
- Create: `src/api/keycloak_token.ts`
- Create: `test/support/jwks.ts`
- Test: `src/api/keycloak_token.test.ts`
- Modify: `package.json` (add `jose`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `KeycloakAuthConfig`, `ServiceCaller`, `KeycloakTokenErrorCode`, `KeycloakTokenResult`, `extractBearerToken`, `verifyKeycloakToken`, `resetKeycloakJwksCache` (signatures above).

- [ ] **Step 1: Add the dependency**

```bash
cd /path/to/signals-search
pnpm add jose@^6.2.2
```

Same major as Signals-DPG (`apps/api/package.json:58`), so the two validators cannot drift on jose behaviour.

- [ ] **Step 2: Write the shared JWKS test harness**

`jose`'s remote key set fetches over `node:http`, not global `fetch` — stubbing `fetch` does nothing. Serve a real key set on a loopback port instead; that also exercises the caching and failure paths for real.

Create `test/support/jwks.ts`:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';

const KID = 'signals-search-test-key';

export type MintOverrides = {
  /** Pass null to mint a token with no `sub` claim at all. */
  sub?: string | null;
  iss?: string;
  /** Emitted as BOTH `azp` and `client_id`, the way Keycloak shapes a client-credentials token. */
  azp?: string;
  aud?: string | string[];
  /** Anything `jose`'s setExpirationTime accepts; pass a past epoch second for an expired token. */
  expiresIn?: string | number;
  claims?: Record<string, unknown>;
  /** Sign with a key that is NOT published in the served JWKS. */
  signWithForeignKey?: boolean;
};

export type JwksHarness = {
  issuer: string;
  jwksUri: string;
  /** How many times the JWKS endpoint has been hit — asserts the cache caches. */
  requests: () => number;
  /** Flip to make the endpoint 500, simulating a Keycloak outage. */
  setFailing: (failing: boolean) => void;
  mint: (overrides?: MintOverrides) => Promise<string>;
  close: () => Promise<void>;
};

export async function startJwksServer(): Promise<JwksHarness> {
  const pair = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

  let requests = 0;
  let failing = false;
  const server: Server = createServer((_req, res) => {
    requests += 1;
    if (failing) {
      res.writeHead(500).end('keycloak is down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}/realms/bluedots`;

  return {
    issuer,
    jwksUri: `${issuer}/protocol/openid-connect/certs`,
    requests: () => requests,
    setFailing: (f) => {
      failing = f;
    },
    async mint(overrides: MintOverrides = {}) {
      const {
        sub = '11111111-2222-3333-4444-555555555555',
        iss = issuer,
        azp = 'signals-search',
        // Keycloak's shape once the audience mapper is in place: the resource
        // server plus the default `account`.
        aud = ['signals-search', 'account'],
        expiresIn = '5m',
        claims = {},
        signWithForeignKey = false,
      } = overrides;
      const jwt = new SignJWT({ ...(azp ? { azp, client_id: azp } : {}), ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(expiresIn);
      if (sub !== null) jwt.setSubject(sub);
      return jwt.sign(signWithForeignKey ? foreign.privateKey : pair.privateKey);
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
```

- [ ] **Step 3: Write the failing test**

Create `src/api/keycloak_token.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startJwksServer, type JwksHarness } from '../../test/support/jwks.js';
import {
  extractBearerToken,
  resetKeycloakJwksCache,
  verifyKeycloakToken,
  type KeycloakAuthConfig,
} from './keycloak_token.js';

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
      azp: undefined,
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

  it('fetches the key set once across repeated verifications', async () => {
    const before = jwks.requests();
    await verifyKeycloakToken(await jwks.mint(), cfg);
    await verifyKeycloakToken(await jwks.mint(), cfg);
    expect(jwks.requests()).toBe(before + 1);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run src/api/keycloak_token.test.ts`
Expected: FAIL — `Failed to resolve import "./keycloak_token.js"`.

- [ ] **Step 5: Write the implementation**

Create `src/api/keycloak_token.ts`:

```ts
/**
 * Keycloak access-token validation (JWKS-backed) for signals-search's service
 * auth (#108). Ported from Signals-DPG's `apps/api/src/utils/keycloak_token.ts`,
 * with two deliberate differences:
 *
 * 1. **Config is a parameter, not a module import.** Signals reads a module-level
 *    `keycloakConfig`, which forces its tests to `vi.mock('@/config')`. Here the
 *    config travels through `ApiDeps`, so this module stays pure and testable.
 *
 * 2. **The client gate is `aud` AND `azp`, not either/or.** Signals accepts on
 *    an `azp` OR `aud` match. That is too loose for a second resource server in
 *    the same realm: `azp`-only would admit any allowlisted service token minted
 *    for Signals, and `aud`-only would admit any client handed an audience
 *    mapper. A caller must both name `signals-search` in `aud` and be an
 *    allowlisted client.
 *
 * As in Signals, **nothing here throws** — a verification failure is a
 * discriminated value and the caller maps it to a status code.
 */

import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

export type KeycloakAuthConfig = {
  /** Browser-facing realm URL; must equal the token's `iss` exactly. */
  issuer: string;
  /** In-cluster JWKS URL. Differs from `issuer` when Keycloak is reached internally. */
  jwksUri: string;
  /** Value the token's `aud` must contain — this service's realm client id. */
  audience: string;
  /** Client ids permitted to call signals-search. */
  serviceClientIds: string[];
  jwksCacheMaxAgeMs: number;
  clockToleranceSeconds: number;
};

/** Who the token says is calling. Logged, not used for scoping (#108). */
export type ServiceCaller = { clientId: string; sub: string };

export type KeycloakTokenErrorCode =
  /** Malformed, wrong signature, wrong issuer, or no subject. */
  | 'TOKEN_INVALID'
  /** Well-formed and correctly signed, but past `exp` (or before `nbf`). */
  | 'TOKEN_EXPIRED'
  /** Valid realm token, but not for this service or not from a permitted client. */
  | 'TOKEN_CLIENT_REJECTED'
  /** JWKS could not be fetched — Keycloak down or unreachable. Retryable. */
  | 'KEYCLOAK_UNAVAILABLE';

export type KeycloakTokenResult =
  | { ok: true; caller: ServiceCaller }
  | { ok: false; code: KeycloakTokenErrorCode; message: string };

/**
 * JWKS sets are memoised per URL. jose's remote set does its own caching,
 * rate-limited refetch on an unknown `kid`, and cooldown — but only if we reuse
 * one instance. Creating one per request would refetch the keys per request.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(cfg: KeycloakAuthConfig) {
  let jwks = jwksCache.get(cfg.jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(cfg.jwksUri), {
      cacheMaxAge: cfg.jwksCacheMaxAgeMs,
      // Floor between refetches when an unknown `kid` arrives, so a burst of
      // bogus tokens cannot become a burst of requests to Keycloak.
      cooldownDuration: 30_000,
    });
    jwksCache.set(cfg.jwksUri, jwks);
  }
  return jwks;
}

/** Test seam: drop the memoised JWKS sets. Not used in normal operation. */
export function resetKeycloakJwksCache(): void {
  jwksCache.clear();
}

/** Node socket-level failures that mean "Keycloak was unreachable". */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

/**
 * Distinguish "we could not fetch the key set" from "the token is bad".
 *
 * Both arrive at the same catch, and conflating them turns a Keycloak outage
 * into a wave of 401s that looks like every caller's credential breaking at
 * once. jose signals a non-200 from the JWKS endpoint with a plain `JOSEError`
 * (not a `JWKS*` subclass), and an unreachable host surfaces as a Node system
 * error, so neither is caught by an `instanceof JWKSTimeout` check alone.
 *
 * `JWKSNoMatchingKey` is deliberately NOT an outage — the key set was fetched
 * fine; the token just named a `kid` that is not in it.
 */
function isJwksRetrievalFailure(err: unknown): boolean {
  if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid) {
    return true;
  }
  if (
    err instanceof joseErrors.JOSEError &&
    err.code === 'ERR_JOSE_GENERIC' &&
    err.message.includes('JSON Web Key Set')
  ) {
    return true;
  }
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

/** Normalise the `aud` claim, which Keycloak emits as a string or an array. */
function toAudienceList(aud: JWTPayload['aud']): string[] {
  if (!aud) return [];
  return Array.isArray(aud) ? aud : [aud];
}

/**
 * Pull the bearer token out of an Authorization header. Returns undefined for a
 * missing or non-bearer header rather than throwing.
 */
export function extractBearerToken(
  authorization: string | string[] | undefined,
): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header) return undefined;
  const trimmed = header.trim();
  // Match only the scheme prefix and slice the rest: a `(.+)$` capture after
  // `\s+` is ambiguous (both match spaces) and backtracks super-linearly.
  const scheme = /^Bearer\s+/i.exec(trimmed);
  if (!scheme) return undefined;
  return trimmed.slice(scheme[0].length).trim() || undefined;
}

/**
 * The client id a token was issued to. Keycloak puts it in `client_id` on
 * client-credentials tokens and in `azp` on all of them; the
 * `service-account-<clientId>` username is the fallback for realms that strip
 * both.
 */
function serviceClientId(payload: JWTPayload): string | null {
  if (typeof payload.client_id === 'string' && payload.client_id) return payload.client_id;
  if (typeof payload.azp === 'string' && payload.azp) return payload.azp;
  if (
    typeof payload.preferred_username === 'string' &&
    payload.preferred_username.startsWith('service-account-')
  ) {
    return payload.preferred_username.slice('service-account-'.length) || null;
  }
  return null;
}

export async function verifyKeycloakToken(
  token: string,
  cfg: KeycloakAuthConfig,
): Promise<KeycloakTokenResult> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(cfg), {
      issuer: cfg.issuer,
      clockTolerance: cfg.clockToleranceSeconds,
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, code: 'TOKEN_EXPIRED', message: 'Access token has expired' };
    }
    // Infrastructure, not an auth failure — the caller maps this to 503.
    if (isJwksRetrievalFailure(err)) {
      return {
        ok: false,
        code: 'KEYCLOAK_UNAVAILABLE',
        message: 'Could not fetch the Keycloak JWKS to verify the token',
      };
    }
    return {
      ok: false,
      code: 'TOKEN_INVALID',
      message: err instanceof Error ? err.message : 'Access token is not valid',
    };
  }

  if (typeof payload.sub !== 'string' || !payload.sub) {
    return { ok: false, code: 'TOKEN_INVALID', message: 'Access token has no subject (sub) claim' };
  }

  // Gate 1: the token must be FOR this service. `aud` is not checked via
  // jwtVerify's own `audience` option on purpose — jose reports a mismatch as a
  // generic claim failure, and this deserves its own code (and a 403, not a 401).
  if (!toAudienceList(payload.aud).includes(cfg.audience)) {
    return {
      ok: false,
      code: 'TOKEN_CLIENT_REJECTED',
      message: `Access token does not name '${cfg.audience}' in its audience`,
    };
  }

  // Gate 2: and it must be FROM a client permitted to search.
  const clientId = serviceClientId(payload);
  if (!clientId || !cfg.serviceClientIds.includes(clientId)) {
    return {
      ok: false,
      code: 'TOKEN_CLIENT_REJECTED',
      message: `Token was issued to client '${clientId ?? 'unknown'}', which is not permitted to call signals-search`,
    };
  }

  return { ok: true, caller: { clientId, sub: payload.sub } };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run src/api/keycloak_token.test.ts`
Expected: PASS (all cases). Then `pnpm typecheck` — expected: clean.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/api/keycloak_token.ts src/api/keycloak_token.test.ts test/support/jwks.ts
git commit -m "feat(auth): validate Keycloak bearer tokens against the realm JWKS (#108)"
```

---

### Task 2: Dual-accept request authenticator

**Files:**
- Modify: `src/api/auth.ts:1-26` (whole file — keep both existing exports, add the resolver)
- Test: `src/api/auth.test.ts` (append; the existing `authenticateApiKey` block stays untouched)

**Interfaces:**
- Consumes: `extractBearerToken`, `verifyKeycloakToken`, `KeycloakAuthConfig` from Task 1.
- Produces: `Caller`, `AuthConfig`, `AuthFailure`, `AuthResult`, `authenticateRequest`. `ApiKeyCaller` replaces the old exported name `Caller` for `authenticateApiKey`'s return type.

- [ ] **Step 1: Write the failing test**

Append to `src/api/auth.test.ts` (its existing `beforeAll` already starts Postgres and seeds `apikey`; add the JWKS harness alongside):

```ts
import { startJwksServer, type JwksHarness } from '../../test/support/jwks.js';
import { authenticateRequest, resetKeycloakJwksCacheForTests, type AuthConfig } from './auth.js';

let jwks: JwksHarness;
let authWithKeycloak: AuthConfig;

beforeAll(async () => {
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
afterAll(async () => { await jwks?.close(); });

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

  it('rejects a bearer token when no Keycloak is configured', async () => {
    const token = await jwks.mint();
    const result = await authenticateRequest(
      { authorization: `Bearer ${token}` },
      { sql, auth: { acceptApiKey: true } },
    );
    expect(result).toMatchObject({ ok: false, failure: { status: 401 } });
  });

  it('rejects a request with no credential at all', async () => {
    const result = await authenticateRequest({}, { sql, auth: authWithKeycloak });
    expect(result).toMatchObject({ ok: false, failure: { status: 401 } });
  });
});
```

Note: `auth.test.ts` already declares `beforeAll`/`afterAll` for Postgres — merge these bodies into the existing hooks rather than declaring a second pair, and add `startJwksServer` to the existing import block.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/api/auth.test.ts`
Expected: FAIL — `authenticateRequest` is not exported from `./auth.js`.

- [ ] **Step 3: Write the implementation**

Replace `src/api/auth.ts` with:

```ts
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  extractBearerToken,
  resetKeycloakJwksCache,
  verifyKeycloakToken,
  type KeycloakAuthConfig,
} from './keycloak_token.js';

/** The caller identity `authenticateApiKey` resolves. Nothing downstream reads it. */
export type ApiKeyCaller = { userId: string };

/**
 * Who is calling, and on which credential. Carried for logging only — there is
 * no per-caller scoping in this service (#108).
 */
export type Caller =
  | { kind: 'service'; clientId: string; sub: string }
  | { kind: 'api_key'; userId: string };

/**
 * How this deployment authenticates. `keycloak` absent = bearer auth is off
 * (KEYCLOAK_BASE_URL unset); `acceptApiKey` false = the dual-accept window has
 * been closed. `config.ts` refuses to boot with both off.
 */
export type AuthConfig = { keycloak?: KeycloakAuthConfig; acceptApiKey: boolean };

/** A failure already carrying the status the route should answer with. */
export type AuthFailure = { status: 401 | 403 | 503; error: string; message: string };

export type AuthResult = { ok: true; caller: Caller } | { ok: false; failure: AuthFailure };

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('base64url');
}

export async function authenticateApiKey(
  sql: Sql,
  rawKey: string | undefined,
): Promise<ApiKeyCaller | null> {
  if (!rawKey) return null;
  const hashed = hashApiKey(rawKey);
  // Validity mirrors better-auth's own gate: not-disabled, not-expired,
  // not-exhausted. We READ remaining but never decrement it — better-auth
  // (Signals-DPG) owns the key write path; a decrement here would race it.
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

/** Test seam, re-exported so route/auth tests need not import the token module. */
export const resetKeycloakJwksCacheForTests = resetKeycloakJwksCache;

/**
 * The one entry point every authenticated route uses.
 *
 * A present bearer token is **decided on** — never fallen back from. If a caller
 * sends both credentials during the dual-accept window and the token is bad,
 * answering on the api key instead would hide a broken token rollout behind a
 * stale key.
 *
 * The api-key path is the only one that touches Postgres; the bearer path is
 * purely cryptographic.
 */
export async function authenticateRequest(
  headers: { authorization?: string | string[]; apiKey?: string },
  deps: { sql: Sql; auth: AuthConfig },
): Promise<AuthResult> {
  const bearer = extractBearerToken(headers.authorization);

  if (bearer) {
    if (!deps.auth.keycloak) {
      return {
        ok: false,
        failure: {
          status: 401,
          error: 'UNAUTHORIZED',
          message: 'bearer tokens are not accepted by this deployment',
        },
      };
    }
    const result = await verifyKeycloakToken(bearer, deps.auth.keycloak);
    if (result.ok) {
      return {
        ok: true,
        caller: { kind: 'service', clientId: result.caller.clientId, sub: result.caller.sub },
      };
    }
    if (result.code === 'KEYCLOAK_UNAVAILABLE') {
      // Infrastructure, not credentials. Signals-DPG's discover BFF degrades to
      // its native path on a 5xx; a 401 here would read as a credential break.
      return {
        ok: false,
        failure: { status: 503, error: 'AUTH_PROVIDER_UNAVAILABLE', message: result.message },
      };
    }
    if (result.code === 'TOKEN_CLIENT_REJECTED') {
      return {
        ok: false,
        failure: { status: 403, error: 'CLIENT_NOT_PERMITTED', message: result.message },
      };
    }
    return { ok: false, failure: { status: 401, error: 'UNAUTHORIZED', message: result.message } };
  }

  if (deps.auth.acceptApiKey) {
    const caller = await authenticateApiKey(deps.sql, headers.apiKey);
    if (caller) return { ok: true, caller: { kind: 'api_key', userId: caller.userId } };
  }

  return {
    ok: false,
    failure: {
      status: 401,
      error: 'UNAUTHORIZED',
      message: deps.auth.acceptApiKey
        ? 'valid Authorization: Bearer <token> or x-api-key required'
        : 'valid Authorization: Bearer <token> required',
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/api/auth.test.ts`
Expected: PASS — both the pre-existing `authenticateApiKey` block and the new `authenticateRequest` block.

- [ ] **Step 5: Commit**

```bash
git add src/api/auth.ts src/api/auth.test.ts
git commit -m "feat(auth): accept a bearer token or an x-api-key through one resolver (#108)"
```

---

### Task 3: Auth configuration and fail-fast

**Files:**
- Modify: `src/config.ts:14-68` (env schema), `src/config.ts:70-84` (the `Config` type), `src/config.ts:86-105` (`loadConfig`)
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: `AuthConfig` from Task 2 (type-only import — no runtime cycle, since `auth.ts` never imports `config.ts`).
- Produces: `Config.auth: AuthConfig`, consumed by Task 4's `main.ts` wiring.

- [ ] **Step 1: Write the failing test**

Append to `src/config.test.ts`:

```ts
describe('loadConfig — auth', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@h:5432/db',
    REDIS_URL: 'redis://h:6379',
    EMBEDDING_BASE_URL: 'http://tei:8080/v1',
    EMBEDDING_MODEL: 'BAAI/bge-m3',
    EMBEDDING_DIM: '1024',
    NETWORK_CONFIG_PATH: './test/fixtures/networks',
  };

  it('defaults to api-key-only when no Keycloak base url is set', () => {
    const cfg = loadConfig(base);
    expect(cfg.auth).toEqual({ acceptApiKey: true });
  });

  it('builds the issuer and jwks uri from the base url and realm', () => {
    const cfg = loadConfig({
      ...base,
      KEYCLOAK_BASE_URL: 'https://auth.example.com/',
      KEYCLOAK_SERVICE_CLIENT_IDS: 'signals-search, voice-dpg',
    });
    expect(cfg.auth.keycloak).toEqual({
      issuer: 'https://auth.example.com/realms/bluedots',
      jwksUri: 'https://auth.example.com/realms/bluedots/protocol/openid-connect/certs',
      audience: 'signals-search',
      serviceClientIds: ['signals-search', 'voice-dpg'],
      jwksCacheMaxAgeMs: 600_000,
      clockToleranceSeconds: 30,
    });
    expect(cfg.auth.acceptApiKey).toBe(true);
  });

  it('fetches the jwks from the internal base url when one is given', () => {
    const cfg = loadConfig({
      ...base,
      KEYCLOAK_BASE_URL: 'https://auth.example.com',
      KEYCLOAK_INTERNAL_BASE_URL: 'http://keycloak:8080',
      KEYCLOAK_SERVICE_CLIENT_IDS: 'signals-search',
    });
    // iss is what the token carries (public); the fetch stays in-cluster.
    expect(cfg.auth.keycloak?.issuer).toBe('https://auth.example.com/realms/bluedots');
    expect(cfg.auth.keycloak?.jwksUri).toBe(
      'http://keycloak:8080/realms/bluedots/protocol/openid-connect/certs',
    );
  });

  it('refuses to boot with Keycloak configured but no client allowlist', () => {
    expect(() =>
      loadConfig({ ...base, KEYCLOAK_BASE_URL: 'https://auth.example.com' }),
    ).toThrow(/KEYCLOAK_SERVICE_CLIENT_IDS/);
  });

  it('refuses to boot with no authentication at all', () => {
    expect(() => loadConfig({ ...base, AUTH_ACCEPT_API_KEY: 'false' })).toThrow(
      /No authentication is configured/,
    );
  });

  it('closes the dual-accept window when AUTH_ACCEPT_API_KEY is false', () => {
    const cfg = loadConfig({
      ...base,
      KEYCLOAK_BASE_URL: 'https://auth.example.com',
      KEYCLOAK_SERVICE_CLIENT_IDS: 'signals-search',
      AUTH_ACCEPT_API_KEY: 'false',
    });
    expect(cfg.auth.acceptApiKey).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/config.test.ts`
Expected: FAIL — `cfg.auth` is undefined.

- [ ] **Step 3: Add the env schema entries**

In `src/config.ts`, add to `EnvSchema` (after `PUBLIC_API_BASE_URL`):

```ts
  // Keycloak service auth (#108). KEYCLOAK_BASE_URL is the switch: unset means
  // bearer tokens are not accepted at all, and this deployment is api-key-only.
  KEYCLOAK_BASE_URL: z.string().url().optional(),
  // Browser-facing base is what `iss` carries; the JWKS fetch should stay
  // in-cluster. Falls back to KEYCLOAK_BASE_URL when they are the same host.
  KEYCLOAK_INTERNAL_BASE_URL: z.string().url().optional(),
  KEYCLOAK_REALM: z.string().min(1).default('bluedots'),
  // This service's own realm client id — every token must name it in `aud`.
  KEYCLOAK_AUDIENCE: z.string().min(1).default('signals-search'),
  // Clients permitted to search. Load-bearing, not a formality: the realm is
  // shared, so a token minted for Signals is signature- and issuer-valid here.
  KEYCLOAK_SERVICE_CLIENT_IDS: z.string().default(''),
  KEYCLOAK_JWKS_CACHE_MAX_AGE_MS: z.coerce.number().int().nonnegative().default(600_000),
  KEYCLOAK_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().nonnegative().default(30),
  // The dual-accept flag: keeps `x-api-key` working while callers migrate.
  // Flip to false to retire that path.
  AUTH_ACCEPT_API_KEY: envBool(true),
```

- [ ] **Step 4: Add the type import, the `Config` field, and the builder**

At the top of `src/config.ts`, next to the zod import:

```ts
import type { AuthConfig } from './api/auth.js';
```

Add to the `Config` type:

```ts
  auth: AuthConfig;
```

Add above `loadConfig`:

```ts
/**
 * Resolve the authentication mode from env, failing fast rather than booting
 * into a state nobody intended. Two refusals matter:
 *
 *  - Keycloak configured with an EMPTY client allowlist would accept any token
 *    the realm signs that names our audience — in a shared realm that is not a
 *    small mistake.
 *  - Neither provider enabled would leave the search routes open.
 */
function buildAuthConfig(e: z.infer<typeof EnvSchema>): AuthConfig {
  const baseUrl = (e.KEYCLOAK_BASE_URL ?? '').replace(/\/$/, '');
  const internalBaseUrl = (e.KEYCLOAK_INTERNAL_BASE_URL ?? e.KEYCLOAK_BASE_URL ?? '').replace(
    /\/$/,
    '',
  );
  const serviceClientIds = e.KEYCLOAK_SERVICE_CLIENT_IDS.split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  if (!baseUrl) {
    if (!e.AUTH_ACCEPT_API_KEY) {
      throw new Error(
        'No authentication is configured: set KEYCLOAK_BASE_URL, or leave AUTH_ACCEPT_API_KEY=true',
      );
    }
    return { acceptApiKey: true };
  }

  if (serviceClientIds.length === 0) {
    throw new Error(
      'KEYCLOAK_SERVICE_CLIENT_IDS must list at least one client id when KEYCLOAK_BASE_URL is set',
    );
  }

  return {
    acceptApiKey: e.AUTH_ACCEPT_API_KEY,
    keycloak: {
      issuer: `${baseUrl}/realms/${e.KEYCLOAK_REALM}`,
      jwksUri: `${internalBaseUrl}/realms/${e.KEYCLOAK_REALM}/protocol/openid-connect/certs`,
      audience: e.KEYCLOAK_AUDIENCE,
      serviceClientIds,
      jwksCacheMaxAgeMs: e.KEYCLOAK_JWKS_CACHE_MAX_AGE_MS,
      clockToleranceSeconds: e.KEYCLOAK_CLOCK_TOLERANCE_SECONDS,
    },
  };
}
```

And inside `loadConfig`'s returned object, alongside `apiReference`:

```ts
    auth: buildAuthConfig(e),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/config.test.ts`
Expected: PASS. Then `pnpm typecheck` — expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): resolve the auth mode from KEYCLOAK_* env, failing fast (#108)"
```

---

### Task 4: Wire the routes

**Files:**
- Modify: `src/api/server.ts:45-54` (`ApiDeps`)
- Modify: `src/api/main.ts:14-17` (deps literal)
- Modify: `src/api/search_route.ts:1-10` (imports), `:146-162` (responses + the gate), `:176-177`, `:203-204`
- Modify: `src/api/relevance_route.ts:1-6` (imports), `:29-44` (responses + the gate)
- Modify: `scripts/dump-openapi.ts:9-31`
- Test: `src/api/search_route.test.ts`, `src/api/relevance_route.test.ts`, and — for the new required dep only — `src/api/search_flat_route.test.ts`, `src/api/search_route_rerank.test.ts`, `src/api/server.test.ts`, `src/api/openapi.test.ts`

**Interfaces:**
- Consumes: `authenticateRequest`, `AuthConfig`, `resetKeycloakJwksCacheForTests` (Task 2); `Config.auth` (Task 3).
- Produces: `ApiDeps.auth: AuthConfig` — required, not optional, so no caller can silently boot unauthenticated. `requireCaller(deps, request, reply)` is file-local to `search_route.ts`; `relevance_route.ts` inlines the same call.

- [ ] **Step 1: Write the failing test**

In `src/api/search_route.test.ts`: import the harness, start it in `beforeAll` **before** `buildServer`, pass `auth` into the deps literal at line 43, and add the bearer cases.

```ts
// add to the import block
import { startJwksServer, type JwksHarness } from '../../test/support/jwks.js';

// add to the module-level lets
let jwks: JwksHarness;

// inside beforeAll, before buildServer:
jwks = await startJwksServer();

// buildServer deps literal gains:
//   auth: {
//     acceptApiKey: true,
//     keycloak: {
//       issuer: jwks.issuer, jwksUri: jwks.jwksUri, audience: 'signals-search',
//       serviceClientIds: ['signals-search'], jwksCacheMaxAgeMs: 600_000,
//       clockToleranceSeconds: 0,
//     },
//   },

// add to afterAll: await jwks?.close();

describe('POST /v1/search — bearer auth (#108)', () => {
  it('serves a request carrying a valid bearer token', async () => {
    const token = await jwks.mint();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message.items[0].item_id).toBe(A);
  });

  it('403s a valid token from a client that may not search', async () => {
    const token = await jwks.mint({ azp: 'aggregator-dpg' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('CLIENT_NOT_PERMITTED');
  });

  it('401s a malformed bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { authorization: 'Bearer not-a-jwt' },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('still accepts x-api-key during the dual-accept window', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'x-api-key': RAW },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  });

  it('503s — not 401s — while the JWKS endpoint is down', async () => {
    const token = await jwks.mint();
    jwks.setFailing(true);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    jwks.setFailing(false);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('AUTH_PROVIDER_UNAVAILABLE');
  });
});
```

Note on the 503 case: it must run after at least one successful verification has warmed jose's key-set cache, or it may pass for the wrong reason. Either keep it last in the file, or call `resetKeycloakJwksCacheForTests()` (imported from `./auth.js`) immediately before flipping `setFailing(true)` so the fetch is guaranteed to be attempted.

In `src/api/relevance_route.test.ts`, add the same `jwks` harness and `auth` dep, then one bearer case reusing the file's existing `seekerRef`/`providerRef` fixtures (see its line 56 for the api-key equivalent):

```ts
  it('scores a pair for a caller carrying a valid bearer token', async () => {
    const token = await jwks.mint();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/relevance',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: seekerRef(SEEKER), target: providerRef(PROV_MATCH) },
    });
    expect(res.statusCode).toBe(200);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/api/search_route.test.ts src/api/relevance_route.test.ts`
Expected: FAIL — a bearer request answers 401 (`requireApiKey` ignores `authorization`), and `auth` is not a known `ApiDeps` property.

- [ ] **Step 3: Add `auth` to `ApiDeps` and wire `main.ts`**

`src/api/server.ts` — import the type and extend `ApiDeps`:

```ts
import type { AuthConfig } from './auth.js';

export type ApiDeps = {
  sql: Sql;
  redis: Redis;
  embedder: Embedder;
  registry: NetworkRegistry;
  rerank: { baseUrl?: string; model: string; defaultOn: boolean; topN: number };
  cacheTtlSeconds: number;
  embeddingDim: number;
  defaultDistanceMeters: number;
  /** Required on purpose: no caller can boot the API unauthenticated by omission. */
  auth: AuthConfig;
};
```

`src/api/main.ts` — add `auth: cfg.auth,` to the deps literal passed to `buildServer`.

- [ ] **Step 4: Replace the gate in `search_route.ts`**

Swap the import at line 5:

```ts
import { authenticateRequest } from './auth.js';
```

Add `FastifyRequest` to the type import at line 1:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
```

Add `503` to the response map (line 146-153) — a Keycloak outage is now a documented outcome:

```ts
const SEARCH_RESPONSES = {
  200: SearchResponseSchema,
  400: ErrorSchema,
  401: ErrorSchema,
  403: ErrorSchema,
  404: ErrorSchema,
  422: ErrorSchema,
  503: ErrorSchema,
} as const;
```

Replace `requireApiKey` (lines 155-162) with:

```ts
/**
 * Authenticate, or answer the failure ourselves and tell the caller to stop.
 * The status comes from the resolver — 401 bad/absent credential, 403 valid
 * token from a client that may not search, 503 Keycloak unreachable.
 */
async function requireCaller(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const result = await authenticateRequest(
    {
      authorization: request.headers.authorization,
      apiKey: request.headers['x-api-key'] as string | undefined,
    },
    { sql: deps.sql, auth: deps.auth },
  );
  if (!result.ok) {
    await reply
      .code(result.failure.status)
      .send({ error: result.failure.error, message: result.failure.message });
    return false;
  }
  return true;
}
```

Update both call sites (lines 177 and 204) to:

```ts
    if (!(await requireCaller(deps, request, reply))) return reply;
```

- [ ] **Step 5: Replace the gate in `relevance_route.ts`**

Swap the import at line 5 to `import { authenticateRequest } from './auth.js';`, add `503: ErrorSchema` to the response map, and replace lines 41-44 with:

```ts
    const auth = await authenticateRequest(
      {
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'] as string | undefined,
      },
      { sql: deps.sql, auth: deps.auth },
    );
    if (!auth.ok) {
      return reply
        .code(auth.failure.status)
        .send({ error: auth.failure.error, message: auth.failure.message });
    }
```

- [ ] **Step 6: Give every other `buildServer` caller the new dep**

`src/api/search_flat_route.test.ts`, `src/api/search_route_rerank.test.ts`, `src/api/server.test.ts`, `src/api/openapi.test.ts` and `scripts/dump-openapi.ts` only need the field to typecheck — they exercise the api-key or the unauthenticated paths. Add to each deps literal:

```ts
  auth: { acceptApiKey: true },
```

- [ ] **Step 7: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. `pnpm typecheck` failing on a missing `auth` property is the signal that a `buildServer` caller was missed.

- [ ] **Step 8: Commit**

```bash
git add src/api/server.ts src/api/main.ts src/api/search_route.ts src/api/relevance_route.ts \
  src/api/search_route.test.ts src/api/relevance_route.test.ts src/api/search_flat_route.test.ts \
  src/api/search_route_rerank.test.ts src/api/server.test.ts src/api/openapi.test.ts scripts/dump-openapi.ts
git commit -m "feat(api): authenticate search and relevance with a bearer token or api key (#108)"
```

---

### Task 5: Document both credentials in the OpenAPI spec

**Files:**
- Modify: `src/api/server.ts:105-132` (info description + `securitySchemes`)
- Modify: `src/api/search_route.ts:172`, `:197`; `src/api/relevance_route.ts:29` (per-route `security`)
- Modify: `openapi.json` (regenerated, never hand-edited)
- Test: `src/api/openapi.test.ts:18-70`

**Interfaces:**
- Consumes: the routes from Task 4.
- Produces: a `bearerAuth` security scheme; every authenticated route declares `security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]` — an OpenAPI array of alternatives, i.e. either credential suffices.

- [ ] **Step 1: Write the failing test**

Update the three security assertions in `src/api/openapi.test.ts` (lines 28, 48, 63) and the scheme assertion (line 32):

```ts
    expect(search.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    expect(spec.components.securitySchemes.apiKeyAuth).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key',
    });
```

Apply the same `security` expectation to the `/v1/search/flat` and `/v1/relevance` cases.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/api/openapi.test.ts`
Expected: FAIL — `security` is `[{ apiKeyAuth: [] }]` and `bearerAuth` is undefined.

- [ ] **Step 3: Add the scheme and update the description**

`src/api/server.ts` — in `components.securitySchemes`:

```ts
        components: {
          securitySchemes: {
            // Either credential is accepted while the dual-accept window is
            // open (AUTH_ACCEPT_API_KEY); bearer is the target state (#108).
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
          },
        },
```

And in `info.description`, replace `'Auth: x-api-key header.'` with:

```ts
            'structured search over the shared Signals database. Auth: a Keycloak ' +
            'client-credentials bearer token (Authorization: Bearer <token>), or the ' +
            'legacy x-api-key header while the dual-accept migration window is open.',
```

- [ ] **Step 4: Declare both alternatives on each route**

In `src/api/search_route.ts` (lines 172 and 197) and `src/api/relevance_route.ts` (line 29), replace:

```ts
      security: [{ apiKeyAuth: [] }],
```

with:

```ts
      // An array of alternatives: EITHER credential authenticates the call.
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
```

- [ ] **Step 5: Run the test to verify it passes, then regenerate the spec**

```bash
pnpm vitest run src/api/openapi.test.ts
pnpm spec:dump
git diff --stat openapi.json
```

Expected: test PASS; `openapi.json` shows the new `bearerAuth` scheme, the three updated `security` arrays, the new `503` responses, and the new description. `openapi.json` is generated — if it looks wrong, fix the source and re-run, never edit it.

- [ ] **Step 6: Commit**

```bash
git add src/api/server.ts src/api/search_route.ts src/api/relevance_route.ts src/api/openapi.test.ts openapi.json
git commit -m "docs(api): document bearer auth alongside x-api-key in the OpenAPI spec (#108)"
```

---

### Task 6: Operator docs and the PR

**Files:**
- Modify: `.env.example` (append an auth block)
- Modify: `README.md:27`, `:66`, `:81`, `:147`, `:163`, `:197`, `:222`
- Modify: `CLAUDE.md:34`, `:36`, `:38`, `:59`

**Interfaces:**
- Consumes: the config names from Task 3 and the behaviour from Tasks 4-5.
- Produces: nothing code-facing.

- [ ] **Step 1: Add the env block**

Append to `.env.example`:

```sh
# --- Service auth (#108) ---
# Keycloak client-credentials bearer validation. KEYCLOAK_BASE_URL is the switch:
# leave it unset and this deployment stays api-key-only.
#
# The realm is SHARED with Signals and the aggregator, so a token minted for
# another service is signature- and issuer-valid here. Two gates keep the
# populations apart, and both must pass:
#   1. the token's `aud` must name KEYCLOAK_AUDIENCE (this service's client id);
#   2. its client id must appear in KEYCLOAK_SERVICE_CLIENT_IDS.
# Setting KEYCLOAK_BASE_URL with an empty allowlist is refused at boot.
# KEYCLOAK_BASE_URL=http://localhost:8081
# Used for the in-cluster JWKS fetch; defaults to KEYCLOAK_BASE_URL. `iss` is
# always compared against the public KEYCLOAK_BASE_URL.
# KEYCLOAK_INTERNAL_BASE_URL=http://keycloak:8080
KEYCLOAK_REALM=bluedots
KEYCLOAK_AUDIENCE=signals-search
# KEYCLOAK_SERVICE_CLIENT_IDS=signals-search,voice-dpg
KEYCLOAK_JWKS_CACHE_MAX_AGE_MS=600000
KEYCLOAK_CLOCK_TOLERANCE_SECONDS=30

# Dual-accept window: keep the legacy x-api-key working while callers migrate.
# Flip to false once Signals-DPG and voice-dpg send bearer tokens; with
# KEYCLOAK_BASE_URL unset, false is refused at boot (that would leave no auth).
AUTH_ACCEPT_API_KEY=true
```

- [ ] **Step 2: Update `README.md`**

- Line 27 (the ASCII flow) — `Voice bot ──x-api-key──▶` becomes `Voice bot ──Bearer token──▶`.
- Line 66 (the mermaid sequence) — `Caller->>API: POST /v1/search (x-api-key)` becomes `Caller->>API: POST /v1/search (Authorization: Bearer <token>)`.
- Line 81 — replace the "Authenticate" bullet with:

```markdown
1. **Authenticate.** `Authorization: Bearer <token>` — a Keycloak
   client-credentials token, validated against the realm JWKS (signature,
   `iss`, `exp`/`nbf`). The realm is shared with Signals and the aggregator, so
   two further gates apply: the token must name `signals-search` in its `aud`,
   and its client must be listed in `KEYCLOAK_SERVICE_CLIENT_IDS`. Neither is a
   formality — a token minted for Signals is otherwise perfectly valid here.
   A `403 CLIENT_NOT_PERMITTED` means the token was good but the client is not
   allowed to search; a `503 AUTH_PROVIDER_UNAVAILABLE` means Keycloak could not
   be reached, and is retryable. While `AUTH_ACCEPT_API_KEY=true`, the legacy
   `x-api-key` (validated against Signals' key store) is still accepted, so
   callers can migrate independently. A request carrying a bearer token is
   judged on that token — it never falls back to the api key.
```

- Lines 147, 163, 197 — replace `x-api-key` with "bearer token (or `x-api-key` during the dual-accept window)".
- Line 222 — no change needed; `authorization` is already in the redact list.

- [ ] **Step 3: Update `CLAUDE.md`**

- Line 34 — `API-key auth (src/api/auth.ts)` becomes `service auth (src/api/auth.ts + src/api/keycloak_token.ts)`.
- Lines 36 and 38 — `Same x-api-key auth` becomes `Same service auth`.
- After line 59, add:

```markdown
- **Service auth (`auth.ts` + `keycloak_token.ts`).** `authenticateRequest` is the single gate for `/v1/search`, `/v1/search/flat` and `/v1/relevance`. A present `Authorization: Bearer` is **decided on, never fallen back from** — falling back to `x-api-key` would hide a broken token rollout behind a stale key. The Keycloak gate is `aud` **AND** client id, deliberately stricter than Signals-DPG's `azp`-or-`aud`: the `bluedots` realm is shared, so `azp`-only would admit any allowlisted service token minted for Signals and `aud`-only would admit any client handed an audience mapper. A JWKS fetch failure is `503 AUTH_PROVIDER_UNAVAILABLE`, never a 401 — Signals-DPG's discover BFF degrades to its native path on a 5xx, whereas a 401 storm reads as every credential breaking at once. `x-api-key` remains accepted while `AUTH_ACCEPT_API_KEY=true` (default) and is the only path that touches Postgres; `config.ts` refuses to boot with both providers off, or with Keycloak on and an empty `KEYCLOAK_SERVICE_CLIENT_IDS`.
```

- [ ] **Step 4: Verify the whole suite and build**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md CLAUDE.md
git commit -m "docs: document Keycloak service auth and the dual-accept window (#108)"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/108-keycloak-bearer-auth
gh pr create --base feature --draft --title "feat(auth): Keycloak bearer validation for signals-search (#108)"
```

The description needs Summary / **Release Notes** / **In Plain Terms** / Checklist (per `CLAUDE.md:72`), plus these flags called out explicitly:

- `Part of #108` — not `Closes`; a merge into `feature` does not auto-close.
- **Deployable before any caller changes.** With `KEYCLOAK_BASE_URL` unset, behaviour is byte-identical to today.
- **Three follow-ups are required before `AUTH_ACCEPT_API_KEY=false`:** the `signals-search` realm client plus the `voice-dpg` audience mapper (in **both** realm exports); the Signals-DPG outbound token mint+cache helper replacing `signals_search_client.ts:267`; voice-dpg's own migration.
- **The realm JSON only applies on first import** (`Signals-DPG/infra/keycloak/render-realm.sh:15`), so existing environments need the client created out-of-band.
- **Open question for the reviewer:** does anyone hold a raw `x-api-key` outside these two services (ops, Postman, a partner)? That is the only thing the dual-accept window is protecting, and the answer sets the date it closes.

---

## Rollout order (for whoever runs the migration)

1. Merge this PR. Deploy with `KEYCLOAK_BASE_URL` unset — a pure no-op, and it de-risks the code path landing separately from the config.
2. Land the realm change (client + mappers, both exports); create the client in the existing environments.
3. Set `KEYCLOAK_BASE_URL`, `KEYCLOAK_SERVICE_CLIENT_IDS=signals-search,voice-dpg` on signals-search, `AUTH_ACCEPT_API_KEY` still `true`. Both credentials now work.
4. Migrate Signals-DPG, then voice-dpg, one at a time. Each is independently revertible.
5. Confirm no `x-api-key` traffic remains (the logs carry `reqId` and the caller's client id on the bearer path).
6. Set `AUTH_ACCEPT_API_KEY=false`. The `apikey` table read — and with it the last better-auth coupling in this service — is now dead code, removable in a follow-up.
