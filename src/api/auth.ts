import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  extractBearerToken,
  verifyKeycloakToken,
  type KeycloakAuthConfig,
} from './keycloak_token.js';

/** Test seam, re-exported so route/auth tests need not import the token module. */
export { resetKeycloakJwksCache as resetKeycloakJwksCacheForTests } from './keycloak_token.js';

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
 * (KEYCLOAK_BASE_URL unset), and an `Authorization: Bearer` header is then
 * ignored rather than refused (see `authenticateRequest`); `acceptApiKey` false =
 * the dual-accept window has been closed. `config.ts` refuses to boot with both
 * off.
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

/**
 * The one entry point every authenticated route uses.
 *
 * **When Keycloak is configured**, a present bearer token is decided on — never
 * fallen back from. If a caller sends both credentials during the dual-accept
 * window and the token is bad, answering on the api key instead would hide a
 * broken token rollout behind a stale key.
 *
 * **When it is not** (KEYCLOAK_BASE_URL unset — the shipped default), a bearer
 * header is ignored and the api-key path runs. There is no token rollout to
 * mask, so refusing would buy nothing and break a real shape: a BFF that
 * forwards its end user's `Authorization` header alongside its own service
 * credential — which Signals-DPG's discover BFF is. It also keeps the first
 * deploy of this change a true no-op for such callers.
 *
 * The api-key path is the only one that touches Postgres; the bearer path is
 * purely cryptographic.
 */
export async function authenticateRequest(
  headers: { authorization?: string | string[]; apiKey?: string },
  deps: { sql: Sql; auth: AuthConfig },
): Promise<AuthResult> {
  const bearer = extractBearerToken(headers.authorization);

  // No Keycloak configured → the header is not a credential here at all, so it
  // is neither decided on nor refused; fall through to the api key.
  if (bearer && deps.auth.keycloak) {
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

  // Advertise only the credentials this deployment actually accepts — naming a
  // bearer token to an api-key-only deployment sends the caller in a circle.
  // Never empty: `config.ts` refuses to boot with both providers off.
  const accepted = [
    ...(deps.auth.keycloak ? ['Authorization: Bearer <token>'] : []),
    ...(deps.auth.acceptApiKey ? ['x-api-key'] : []),
  ];
  return {
    ok: false,
    failure: {
      status: 401,
      error: 'UNAUTHORIZED',
      message: `valid ${accepted.join(' or ')} required`,
    },
  };
}
