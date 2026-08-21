/**
 * The route-level half of service auth (#108): one gate, shared by every
 * authenticated route.
 *
 * It lives in its own module rather than in `auth.ts` so that `auth.ts` stays
 * framework-agnostic (no Fastify import, unit-testable with plain objects), and
 * so nothing has to import `server.ts` from inside `auth.ts` — `server.ts`
 * already imports `auth.ts` for the `AuthConfig` type, and the `ApiDeps` import
 * below would close that loop. Here the only edge to `server.ts` is a type-only
 * one, erased at runtime.
 *
 * There must be exactly ONE copy of this. It was previously file-local to
 * `search_route.ts` with `relevance_route.ts` re-implementing it inline, and the
 * two copies were not covered alike — a mistyped status or a dropped 503 branch
 * in the second would have shipped green.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ApiDeps } from './server.js';
import { authenticateRequest, type Caller } from './auth.js';

/**
 * Authenticate, or answer the failure ourselves and return null so the route
 * stops. The status comes from the resolver — 401 bad/absent credential, 403
 * valid token from a client that may not search, 503 Keycloak unreachable.
 *
 * The success line is the migration's only instrument: the rollout gate for
 * flipping `AUTH_ACCEPT_API_KEY=false` is "no `x-api-key` traffic remains", and
 * that can only be read off these logs. It goes through `request.log` so the
 * `reqId` correlation comes with it. On the api-key path we log the KIND only —
 * never the `userId`, which is exactly what the logger's redact list exists to
 * keep out of the logs.
 */
export async function requireCaller(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Caller | null> {
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
    return null;
  }
  const caller = result.caller;
  request.log.info(
    caller.kind === 'service'
      ? { credential: 'bearer', clientId: caller.clientId }
      : { credential: 'api_key' },
    'authenticated request',
  );
  return caller;
}
