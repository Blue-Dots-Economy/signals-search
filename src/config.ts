import { z } from 'zod';

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

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  EMBEDDING_BASE_URL: z.string().url(),
  EMBEDDING_MODEL: z.string().min(1),
  EMBEDDING_DIM: z.coerce.number().int().positive().max(2000), // pgvector HNSW limit
  EMBEDDING_API_KEY: z.string().optional(),
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
});

export type Config = {
  databaseUrl: string;
  redisUrl: string;
  runMigrations: boolean;
  embedding: { baseUrl: string; model: string; dim: number; apiKey?: string; timeoutMs: number; maxRetries: number };
  ingest: { stream: string; consumerGroup: string; consumerName: string; pelMinIdleMs: number; dlqStream: string; maxDeliveries: number; dlqMaxLen: number };
  sweep: { intervalMs: number; batchSize: number };
  api: { port: number };
  worker: { healthPort: number; heartbeatStaleMs: number };
  networkConfigPath: string;
  rerank: { baseUrl?: string; model: string; defaultOn: boolean; topN: number };
  cache: { ttlSeconds: number };
  search: { defaultDistanceMeters: number };
  apiReference: { enabled: boolean; publicBaseUrl?: string };
};

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    embedding: { baseUrl: e.EMBEDDING_BASE_URL, model: e.EMBEDDING_MODEL, dim: e.EMBEDDING_DIM, apiKey: e.EMBEDDING_API_KEY, timeoutMs: e.EMBEDDING_TIMEOUT_MS, maxRetries: e.EMBEDDING_MAX_RETRIES },
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
  };
}
