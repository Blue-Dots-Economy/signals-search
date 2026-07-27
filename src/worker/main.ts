import postgres from 'postgres';
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { runMigrations, assertSchemaReady } from '../db/migrate.js';
import { ItemSearchRepo, ITEM_SEARCH_VECTOR_DIM } from '../db/item_search_repo.js';
import { OpenAiCompatibleEmbedder } from '../embedding/provider.js';
import { ensureConsumerGroup, readBatch, ackMessages, reclaimPending, getDeliveryCount, parkToDlq } from '../ingest/stream_consumer.js';
import { processEvent } from './process_event.js';
import { runSweep, sweepOrphans } from '../ingest/sweep.js';
import { loadNetworkRegistry } from '../config/network_registry.js';
import { makeGuarded } from './guarded.js';
import { WorkerHeartbeat, startWorkerHealthServer } from './health.js';

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
  const sweepTimer = setInterval(guardedSweep, cfg.sweep.intervalMs);

  // Health surface + progress heartbeat so a wedged loop is visible to k8s
  // (readiness goes 503) instead of looking healthy forever.
  const heartbeat = new WorkerHeartbeat(cfg.worker.heartbeatStaleMs);
  const healthServer = startWorkerHealthServer(cfg.worker.healthPort, heartbeat);
  heartbeat.markBooted();

  // Graceful shutdown: flip the flag so the loop exits after its current
  // XREADGROUP block (<= 5s), then the cleanup below closes everything.
  let stopping = false;
  const requestStop = (signal: string) => {
    console.log('worker received', signal, '— shutting down');
    stopping = true;
  };
  process.on('SIGTERM', () => requestStop('SIGTERM'));
  process.on('SIGINT', () => requestStop('SIGINT'));

  while (!stopping) {
    heartbeat.mark();
    // Reclaim messages stranded by a dead consumer (idle >= pelMinIdleMs), then
    // read fresh ones; both flow through the same idempotent process+ack path.
    const reclaimed = await reclaimPending(
      redis, cfg.ingest.stream, cfg.ingest.consumerGroup, cfg.ingest.consumerName, cfg.ingest.pelMinIdleMs, 50,
    ).catch((err) => { console.error('reclaimPending failed', err); return []; });
    const fresh = await readBatch(redis, cfg.ingest.stream, cfg.ingest.consumerGroup, cfg.ingest.consumerName, 50, 5000);
    const { stream, consumerGroup: group, dlqStream, dlqMaxLen, maxDeliveries } = cfg.ingest;
    for (const msg of [...reclaimed, ...fresh]) {
      // Schema-invalid event — permanent poison, never processable. Park to the
      // DLQ and ack immediately so it stops redelivering forever.
      if (msg.event === null) {
        console.error('invalid ingestion event; dead-lettering', msg.id, msg.parseError);
        await parkToDlq(redis, dlqStream, dlqMaxLen, msg, `invalid: ${msg.parseError ?? 'unknown'}`);
        await ackMessages(redis, stream, group, [msg.id]);
        continue;
      }
      try {
        await processEvent({ event: msg.event, sql, repo, embedder, fieldsFor, modelVersion });
        await ackMessages(redis, stream, group, [msg.id]);
      } catch (err) {
        // Transient failure: leave unacked to retry, UNLESS it has already been
        // delivered maxDeliveries times — then treat as poison and dead-letter
        // it, so one reliably-failing message can't loop forever burning embeds.
        const deliveries = await getDeliveryCount(redis, stream, group, msg.id).catch(() => 0);
        if (deliveries >= maxDeliveries) {
          console.error('processEvent failed >= maxDeliveries; dead-lettering', msg.id, deliveries, err);
          await parkToDlq(redis, dlqStream, dlqMaxLen, msg, `failed after ${deliveries} deliveries: ${err instanceof Error ? err.message : String(err)}`);
          await ackMessages(redis, stream, group, [msg.id]);
        } else {
          console.error('processEvent failed; leaving unacked for retry', msg.id, deliveries, err);
        }
      }
      heartbeat.mark();
    }
  }

  // Loop exited via graceful stop — tear down in-flight timers, the health
  // server, and the Redis/Postgres connections so the process can exit cleanly.
  clearInterval(sweepTimer);
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  await redis.quit().catch(() => redis.disconnect());
  await sql.end({ timeout: 5 });
  console.log('worker shutdown complete');
}

main().then(() => process.exit(0)).catch((err) => { console.error('worker crashed', err); process.exit(1); });
