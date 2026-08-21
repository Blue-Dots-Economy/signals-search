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
  /**
   * Malformed, wrong signature, wrong issuer, or no subject. Also covers a
   * not-yet-valid (`nbf` in the future) token — jose raises that as a generic
   * `JWTClaimValidationFailed`, not as its own error class, so it lands here
   * rather than under `TOKEN_EXPIRED`.
   */
  | 'TOKEN_INVALID'
  /** Well-formed and correctly signed, but past `exp`. */
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
 * `createRemoteJWKSet` fetches over the global `fetch`, not `node:http` —
 * so a connection-level failure (refused, reset, unreachable, DNS, timeout)
 * does NOT surface its errno on the error itself. `fetch` wraps it as a
 * `TypeError: fetch failed` and buries the real code one level down at
 * `err.cause.code`. Checking only `err.code` here would silently miss every
 * one of those and misreport a real outage as `TOKEN_INVALID` — i.e. a 401
 * instead of the 503 the caller is supposed to see. Do not "simplify" this
 * back to a single `err.code` check.
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
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
    return true;
  }
  const causeCode = (err as { cause?: NodeJS.ErrnoException } | null)?.cause?.code;
  return typeof causeCode === 'string' && NETWORK_ERROR_CODES.has(causeCode);
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
