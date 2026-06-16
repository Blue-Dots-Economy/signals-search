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
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SWEEP_BATCH_SIZE: z.coerce.number().int().positive().default(200),
});

export type Config = {
  databaseUrl: string;
  redisUrl: string;
  embedding: { baseUrl: string; model: string; dim: number; apiKey?: string };
  ingest: { stream: string; consumerGroup: string; consumerName: string };
  sweep: { intervalMs: number; batchSize: number };
};

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    embedding: { baseUrl: e.EMBEDDING_BASE_URL, model: e.EMBEDDING_MODEL, dim: e.EMBEDDING_DIM, apiKey: e.EMBEDDING_API_KEY },
    ingest: { stream: e.INGEST_STREAM, consumerGroup: e.INGEST_CONSUMER_GROUP, consumerName: e.INGEST_CONSUMER_NAME },
    sweep: { intervalMs: e.SWEEP_INTERVAL_MS, batchSize: e.SWEEP_BATCH_SIZE },
  };
}
