import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { ensureConsumerGroup, readBatch, ackMessages } from './stream_consumer.js';

let redisC: StartedTestContainer;
let redis: Redis;
const STREAM = 'signals:item-events';
const GROUP = 'signals-search';

beforeAll(async () => {
  redisC = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redis = new Redis(redisC.getMappedPort(6379), redisC.getHost());
});
afterAll(async () => { redis?.disconnect(); await redisC?.stop(); });

describe('stream consumer', () => {
  it('creates the group, reads a published event, and acks it', async () => {
    await ensureConsumerGroup(redis, STREAM, GROUP);
    await redis.xadd(STREAM, '*',
      'item_network', 'purple_dot', 'item_domain', 'provider',
      'item_type', 'profile_1.0', 'item_id', '5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf',
      'op', 'upsert', 'occurred_at', '2026-06-09T12:00:00Z');

    const batch = await readBatch(redis, STREAM, GROUP, 'c1', 10, 100);
    expect(batch).toHaveLength(1);
    expect(batch[0].event.item_id).toBe('5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf');
    expect(batch[0].event.op).toBe('upsert');

    await ackMessages(redis, STREAM, GROUP, batch.map((b) => b.id));
    const pending = await redis.xpending(STREAM, GROUP);
    expect((pending as any[])[0]).toBe(0); // 0 pending after ack
  });
});
