import postgres from 'postgres';
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { buildServer } from './server.js';
import { OpenAiCompatibleEmbedder } from '../embedding/provider.js';
import { loadNetworkRegistry } from '../config/network_registry.js';

async function main() {
  const cfg = loadConfig();
  const sql = postgres(cfg.databaseUrl, { max: 8 });
  const redis = new Redis(cfg.redisUrl);
  const embedder = new OpenAiCompatibleEmbedder(cfg.embedding);
  const registry = await loadNetworkRegistry(cfg.networkConfigPath);
  const app = buildServer({
    deps: { sql, redis, embedder, registry, rerank: cfg.rerank, cacheTtlSeconds: cfg.cache.ttlSeconds, embeddingDim: cfg.embedding.dim, defaultDistanceMeters: cfg.search.defaultDistanceMeters },
    apiReference: cfg.apiReference,
  });

  // Graceful shutdown: drain the HTTP server, then close the Redis and Postgres
  // connections that were previously leaked on SIGTERM. Re-entrancy guarded so
  // a double signal can't double-close.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('api received', signal, '— shutting down');
    try {
      await app.close();
      await redis.quit().catch(() => redis.disconnect());
      await sql.end({ timeout: 5 });
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: cfg.api.port });
}

main().catch((err) => { console.error('api crashed', err); process.exit(1); });
