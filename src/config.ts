import { z } from 'zod';

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
  // Must be > 0 (and in practice >> one processing cycle): XAUTOCLAIM reclaims
  // from cursor '0-0' each loop, so a near-zero idle would let a worker re-claim
  // its own just-claimed-but-unacked messages and starve fresh reads.
  PEL_MIN_IDLE_MS: z.coerce.number().int().positive().default(60_000),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SWEEP_BATCH_SIZE: z.coerce.number().int().positive().default(200),
  API_PORT: z.coerce.number().int().positive().default(3100),
  NETWORK_CONFIG_PATH: z.string().min(1),
  RERANK_BASE_URL: z.string().url().optional(),
  RERANK_MODEL: z.string().default('BAAI/bge-reranker-v2-m3'),
  RERANK_DEFAULT: z.coerce.boolean().default(false),
  RESULT_TOPN: z.coerce.number().int().positive().default(50),
  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(45),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  EMBEDDING_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  RUN_MIGRATIONS: z.coerce.boolean().default(false),
});

export type Config = {
  databaseUrl: string;
  redisUrl: string;
  runMigrations: boolean;
  embedding: { baseUrl: string; model: string; dim: number; apiKey?: string; timeoutMs: number; maxRetries: number };
  ingest: { stream: string; consumerGroup: string; consumerName: string; pelMinIdleMs: number };
  sweep: { intervalMs: number; batchSize: number };
  api: { port: number };
  networkConfigPath: string;
  rerank: { baseUrl?: string; model: string; defaultOn: boolean; topN: number };
  cache: { ttlSeconds: number };
};

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    embedding: { baseUrl: e.EMBEDDING_BASE_URL, model: e.EMBEDDING_MODEL, dim: e.EMBEDDING_DIM, apiKey: e.EMBEDDING_API_KEY, timeoutMs: e.EMBEDDING_TIMEOUT_MS, maxRetries: e.EMBEDDING_MAX_RETRIES },
    ingest: { stream: e.INGEST_STREAM, consumerGroup: e.INGEST_CONSUMER_GROUP, consumerName: e.INGEST_CONSUMER_NAME, pelMinIdleMs: e.PEL_MIN_IDLE_MS },
    sweep: { intervalMs: e.SWEEP_INTERVAL_MS, batchSize: e.SWEEP_BATCH_SIZE },
    api: { port: e.API_PORT },
    networkConfigPath: e.NETWORK_CONFIG_PATH,
    rerank: { baseUrl: e.RERANK_BASE_URL, model: e.RERANK_MODEL, defaultOn: e.RERANK_DEFAULT, topN: e.RESULT_TOPN },
    cache: { ttlSeconds: e.CACHE_TTL_SECONDS },
    runMigrations: e.RUN_MIGRATIONS,
  };
}
