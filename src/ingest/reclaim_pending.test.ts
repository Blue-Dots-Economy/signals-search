import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { ensureConsumerGroup, reclaimPending } from './stream_consumer.js';

let c: StartedTestContainer; let redis: Redis;
const STREAM = 'signals:item-events'; const GROUP = 'signals-search';

beforeAll(async () => {
  c = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redis = new Redis(c.getMappedPort(6379), c.getHost());
  await ensureConsumerGroup(redis, STREAM, GROUP);
});
afterAll(async () => { redis?.disconnect(); await c?.stop(); });

describe('reclaimPending', () => {
  it('claims a message left pending by a dead consumer and parses it', async () => {
    await redis.xadd(STREAM, '*', 'item_network', 'purple_dot', 'item_domain', 'provider',
      'item_type', 'profile_1.0', 'item_id', 'abc', 'op', 'upsert', 'occurred_at', 't0');
    await redis.xreadgroup('GROUP', GROUP, 'dead-worker', 'COUNT', 10, 'STREAMS', STREAM, '>');

    const claimed = await reclaimPending(redis, STREAM, GROUP, 'live-worker', 0, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].event).toMatchObject({ item_id: 'abc', op: 'upsert', item_network: 'purple_dot' });
  });

  it('returns empty when nothing is pending', async () => {
    await redis.xack(STREAM, GROUP, ...(await redis.xrange(STREAM, '-', '+')).map(([id]) => id));
    expect(await reclaimPending(redis, STREAM, GROUP, 'live-worker', 0, 10)).toEqual([]);
  });
});
