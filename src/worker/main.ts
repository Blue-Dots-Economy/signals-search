import postgres from 'postgres';
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { runMigrations, assertSchemaReady } from '../db/migrate.js';
import { ItemSearchRepo, ITEM_SEARCH_VECTOR_DIM } from '../db/item_search_repo.js';
import { OpenAiCompatibleEmbedder } from '../embedding/provider.js';
import { ensureConsumerGroup, readBatch, ackMessages, reclaimPending } from '../ingest/stream_consumer.js';
import { processEvent } from './process_event.js';
import { runSweep, sweepOrphans } from '../ingest/sweep.js';
import { loadNetworkRegistry } from '../config/network_registry.js';
import { makeGuarded } from './guarded.js';

async function main() {
  const cfg = loadConfig();
  if (cfg.embedding.dim !== ITEM_SEARCH_VECTOR_DIM) {
    throw new Error(
      `EMBEDDING_DIM=${cfg.embedding.dim} but item_search.embedding is vector(${ITEM_SEARCH_VECTOR_DIM}); ` +
      `a different embedding dimension requires a new migration.`,
    );
  }
  const sql = postgres(cfg.databaseUrl, { max: 8 });
  const redis = new Redis(cfg.redisUrl);
  const repo = new ItemSearchRepo(sql, cfg.embedding.dim);
  const embedder = new OpenAiCompatibleEmbedder(cfg.embedding);
  const modelVersion = `${cfg.embedding.model}@${cfg.embedding.dim}`;
  const registry = await loadNetworkRegistry(cfg.networkConfigPath);
  const fieldsFor = (n: string, d: string, t: string) => registry.vectorizeFields(n, d, t);

  if (cfg.runMigrations) {
    await runMigrations(cfg.databaseUrl);
  } else {
    await assertSchemaReady(cfg.databaseUrl);
  }
  await ensureConsumerGroup(redis, cfg.ingest.stream, cfg.ingest.consumerGroup);

  const sweep = async () => {
    try {
      await runSweep({ sql, repo, embedder, fieldsFor, modelVersion, batchSize: cfg.sweep.batchSize });
      await sweepOrphans(sql);
    } catch (err) {
      console.error('sweep failed', err);
    }
  };
  await sweep();
  const guardedSweep = makeGuarded(sweep);
  setInterval(guardedSweep, cfg.sweep.intervalMs);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const reclaimed = await reclaimPending(
      redis, cfg.ingest.stream, cfg.ingest.consumerGroup, cfg.ingest.consumerName, cfg.ingest.pelMinIdleMs, 50,
    ).catch((err) => { console.error('reclaimPending failed', err); return []; });
    const fresh = await readBatch(redis, cfg.ingest.stream, cfg.ingest.consumerGroup, cfg.ingest.consumerName, 50, 5000);
    for (const msg of [...reclaimed, ...fresh]) {
      try {
        await processEvent({ event: msg.event, sql, repo, embedder, fieldsFor, modelVersion });
        await ackMessages(redis, cfg.ingest.stream, cfg.ingest.consumerGroup, [msg.id]);
      } catch (err) {
        console.error('processEvent failed; leaving unacked for retry', msg.id, err);
      }
    }
  }
}

main().catch((err) => { console.error('worker crashed', err); process.exit(1); });
