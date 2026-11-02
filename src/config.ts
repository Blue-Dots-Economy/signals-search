import { z } from 'zod';

// Not z.coerce.boolean(): Boolean("false") is true. Only booleans and
// 'true'/'false'/'1'/'0' are accepted; anything else fails validation.
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
  // Serving-stack tag appended to model_version (e.g. 'tei-1.9'). Leave unset:
  // model_version feeds the content hash, so changing it re-embeds the whole
  // corpus. Set it only as part of a deliberate TEI upgrade.
  EMBEDDING_SERVING_VERSION: z.string().optional(),
  INGEST_STREAM: z.string().default('signals:item-events'),
  INGEST_CONSUMER_GROUP: z.string().default('signals-search'),
  INGEST_CONSUMER_NAME: z.string().default('worker-1'),
  // Dead-letter stream for schema-invalid events and events that reach
  // INGEST_MAX_DELIVERIES. Nothing consumes it automatically (operator triage).
  INGEST_DLQ_STREAM: z.string().optional(),
  INGEST_MAX_DELIVERIES: z.coerce.number().int().positive().default(5),
  // Approximate (`MAXLEN ~`) cap so poison storms cannot grow the shared Redis unbounded.
  INGEST_DLQ_MAXLEN: z.coerce.number().int().positive().default(10_000),
  // Must be well above one processing cycle: XAUTOCLAIM scans from '0-0' each
  // loop, so a near-zero idle re-claims the worker's own unacked messages and
  // starves fresh reads.
  PEL_MIN_IDLE_MS: z.coerce.number().int().positive().default(60_000),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SWEEP_BATCH_SIZE: z.coerce.number().int().positive().default(200),
  API_PORT: z.coerce.number().int().positive().default(3100),
  // Port for the worker's health/readiness server (the worker has no API).
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3101),
  // Worker /ready returns 503 after this long without loop progress. Must exceed
  // one XREADGROUP block (5s) with headroom so an idle loop stays healthy.
  WORKER_HEARTBEAT_STALE_MS: z.coerce.number().int().positive().default(30_000),
  // Default radius in metres for an s_dwithin clause without distanceMeters.
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
};

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
  };
}
