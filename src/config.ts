import { z } from 'zod';
import type { AuthConfig } from './api/auth.js';

// z.coerce.boolean() coerces via Boolean(), so EVERY non-empty string — including
// the literal "false" — becomes true. That silently defeats env flags like
// RUN_MIGRATIONS="false". Parse env booleans by value instead: accept real
// booleans plus the canonical string forms, and reject anything else (fail fast
// rather than guess). Undefined falls back to the supplied default.
const envBool = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .default(defaultValue)
    .transform((v) => v === true || v === 'true' || v === '1');

// An optional URL var where an EMPTY string means "unset". Helm and compose both
// render an unset value as `KEYCLOAK_BASE_URL=`, and a bare `z.string().url()`
// would crash the boot on that — while the switch is documented as "leave it
// unset". Blank and absent must therefore mean the same thing.
const optionalUrl = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  EMBEDDING_BASE_URL: z.string().url(),
  EMBEDDING_MODEL: z.string().min(1),
  EMBEDDING_DIM: z.coerce.number().int().positive().max(2000), // pgvector HNSW limit
  EMBEDDING_API_KEY: z.string().optional(),
  // Serving-stack tag appended to model_version (e.g. 'tei-1.9'). UNSET BY DESIGN:
  // model_version is part of the ingest content hash, so any change to it makes the
  // sweep re-embed the whole corpus. Set this only as part of a deliberate TEI
  // upgrade, where that re-index is the point (#102).
  EMBEDDING_SERVING_VERSION: z.string().optional(),
  INGEST_STREAM: z.string().default('signals:item-events'),
  INGEST_CONSUMER_GROUP: z.string().default('signals-search'),
  INGEST_CONSUMER_NAME: z.string().default('worker-1'),
  // Dead-letter stream for poison messages (schema-invalid events, and events
  // that fail processing more than INGEST_MAX_DELIVERIES times). Defaults to
  // `${INGEST_STREAM}:dlq`. Parked entries are acked on the main group so they
  // stop redelivering; nothing consumes the DLQ automatically (operator triage).
  INGEST_DLQ_STREAM: z.string().optional(),
  INGEST_MAX_DELIVERIES: z.coerce.number().int().positive().default(5),
  // Cap on the DLQ stream length (approximate, `MAXLEN ~`) so poison storms
  // cannot grow the shared Redis unbounded.
  INGEST_DLQ_MAXLEN: z.coerce.number().int().positive().default(10_000),
  // Must be > 0 (and in practice >> one processing cycle): XAUTOCLAIM reclaims
  // from cursor '0-0' each loop, so a near-zero idle would let a worker re-claim
  // its own just-claimed-but-unacked messages and starve fresh reads.
  PEL_MIN_IDLE_MS: z.coerce.number().int().positive().default(60_000),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SWEEP_BATCH_SIZE: z.coerce.number().int().positive().default(200),
  API_PORT: z.coerce.number().int().positive().default(3100),
  // Port for the worker's lightweight health/readiness HTTP surface. The worker
  // is a background consumer with no API, but k8s still needs to probe it —
  // without this a wedged sweep/ingest loop looks healthy forever.
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3101),
  // Worker readiness flips to 503 if the ingest loop hasn't made progress within
  // this window. Must exceed one XREADGROUP block (5s) with headroom so an idle
  // (message-less) loop still counts as healthy; a true wedge exceeds it.
  WORKER_HEARTBEAT_STALE_MS: z.coerce.number().int().positive().default(30_000),
  // Default radius (meters) for a spatial clause that omits distanceMeters.
  SEARCH_DEFAULT_DISTANCE_METERS: z.coerce.number().positive().default(30_000),
  NETWORK_CONFIG_PATH: z.string().min(1),
  RERANK_BASE_URL: z.string().url().optional(),
  RERANK_MODEL: z.string().default('BAAI/bge-reranker-v2-m3'),
  RERANK_DEFAULT: envBool(false),
  RESULT_TOPN: z.coerce.number().int().positive().default(50),
  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(45),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  EMBEDDING_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  RUN_MIGRATIONS: envBool(false),
  NODE_ENV: z.string().default('development'),
  API_REFERENCE_ENABLED: z.enum(['true', 'false']).default('true'),
  API_REFERENCE_FORCE: z.enum(['true', 'false']).default('false'),
  PUBLIC_API_BASE_URL: z.string().url().optional(),
  // Keycloak service auth (#108). KEYCLOAK_BASE_URL is the switch: unset means
  // bearer tokens are not accepted at all, and this deployment is api-key-only.
  KEYCLOAK_BASE_URL: optionalUrl(),
  // Browser-facing base is what `iss` carries; the JWKS fetch should stay
  // in-cluster. Falls back to KEYCLOAK_BASE_URL when they are the same host.
  KEYCLOAK_INTERNAL_BASE_URL: optionalUrl(),
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
});

export type Config = {
  databaseUrl: string;
  redisUrl: string;
  runMigrations: boolean;
  embedding: { baseUrl: string; model: string; dim: number; apiKey?: string; servingVersion?: string; timeoutMs: number; maxRetries: number };
  ingest: { stream: string; consumerGroup: string; consumerName: string; pelMinIdleMs: number; dlqStream: string; maxDeliveries: number; dlqMaxLen: number };
  sweep: { intervalMs: number; batchSize: number };
  api: { port: number };
  worker: { healthPort: number; heartbeatStaleMs: number };
  networkConfigPath: string;
  rerank: { baseUrl?: string; model: string; defaultOn: boolean; topN: number };
  cache: { ttlSeconds: number };
  search: { defaultDistanceMeters: number };
  apiReference: { enabled: boolean; publicBaseUrl?: string };
  auth: AuthConfig;
};

/**
 * Strip EVERY trailing slash, not just one: `https://a.example//` would
 * otherwise become the issuer `https://a.example//realms/bluedots`, which no
 * token's `iss` can ever match — an all-401 deployment from a stray keystroke.
 * One helper for both URLs so it stays fixed in one place.
 */
const stripTrailingSlashes = (url: string) => url.replace(/\/+$/, '');

/**
 * Resolve the authentication mode from env, failing fast rather than booting
 * into a state nobody intended. Three refusals matter:
 *
 *  - Keycloak configured with an EMPTY client allowlist would accept any token
 *    the realm signs that names our audience — in a shared realm that is not a
 *    small mistake.
 *  - Neither provider enabled would leave the search routes open.
 *  - Only the INTERNAL base url set would silently leave bearer auth off (`iss`
 *    is always compared against the public base), i.e. an api-key-only
 *    deployment that looks configured.
 */
function buildAuthConfig(e: z.infer<typeof EnvSchema>): AuthConfig {
  const baseUrl = stripTrailingSlashes(e.KEYCLOAK_BASE_URL ?? '');
  const internalBaseUrl = stripTrailingSlashes(
    e.KEYCLOAK_INTERNAL_BASE_URL ?? e.KEYCLOAK_BASE_URL ?? '',
  );
  const serviceClientIds = e.KEYCLOAK_SERVICE_CLIENT_IDS.split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  if (!baseUrl) {
    if (internalBaseUrl) {
      throw new Error(
        'KEYCLOAK_INTERNAL_BASE_URL is set without KEYCLOAK_BASE_URL, which would leave bearer auth off: set KEYCLOAK_BASE_URL to the public realm base url that tokens carry in `iss`',
      );
    }
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

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    embedding: { baseUrl: e.EMBEDDING_BASE_URL, model: e.EMBEDDING_MODEL, dim: e.EMBEDDING_DIM, apiKey: e.EMBEDDING_API_KEY, servingVersion: e.EMBEDDING_SERVING_VERSION, timeoutMs: e.EMBEDDING_TIMEOUT_MS, maxRetries: e.EMBEDDING_MAX_RETRIES },
    ingest: { stream: e.INGEST_STREAM, consumerGroup: e.INGEST_CONSUMER_GROUP, consumerName: e.INGEST_CONSUMER_NAME, pelMinIdleMs: e.PEL_MIN_IDLE_MS, dlqStream: e.INGEST_DLQ_STREAM ?? `${e.INGEST_STREAM}:dlq`, maxDeliveries: e.INGEST_MAX_DELIVERIES, dlqMaxLen: e.INGEST_DLQ_MAXLEN },
    sweep: { intervalMs: e.SWEEP_INTERVAL_MS, batchSize: e.SWEEP_BATCH_SIZE },
    api: { port: e.API_PORT },
    worker: { healthPort: e.WORKER_HEALTH_PORT, heartbeatStaleMs: e.WORKER_HEARTBEAT_STALE_MS },
    networkConfigPath: e.NETWORK_CONFIG_PATH,
    rerank: { baseUrl: e.RERANK_BASE_URL, model: e.RERANK_MODEL, defaultOn: e.RERANK_DEFAULT, topN: e.RESULT_TOPN },
    cache: { ttlSeconds: e.CACHE_TTL_SECONDS },
    search: { defaultDistanceMeters: e.SEARCH_DEFAULT_DISTANCE_METERS },
    runMigrations: e.RUN_MIGRATIONS,
    apiReference: {
      enabled:
        e.API_REFERENCE_ENABLED === 'true' &&
        (e.NODE_ENV !== 'production' || e.API_REFERENCE_FORCE === 'true'),
      publicBaseUrl: e.PUBLIC_API_BASE_URL,
    },
    auth: buildAuthConfig(e),
  };
}
