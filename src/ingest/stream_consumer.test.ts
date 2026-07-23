import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { ensureConsumerGroup, readBatch, ackMessages, parseEvent, getDeliveryCount, parkToDlq } from './stream_consumer.js';

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
    expect(batch[0].event).not.toBeNull();
    expect(batch[0].event?.item_id).toBe('5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf');
    expect(batch[0].event?.op).toBe('upsert');

    await ackMessages(redis, STREAM, GROUP, batch.map((b) => b.id));
    const pending = await redis.xpending(STREAM, GROUP);
    expect((pending as any[])[0]).toBe(0); // 0 pending after ack
  });

  it('tracks delivery count and parks a poison message to the DLQ', async () => {
    const S = 'signals:dlq-test';
    const G = 'g-dlq';
    const DLQ = `${S}:dlq`;
    await ensureConsumerGroup(redis, S, G);
    const id = (await redis.xadd(S, '*',
      'item_network', 'purple_dot', 'item_domain', 'provider',
      'item_type', 'profile_1.0', 'item_id', 'poison-1',
      'op', 'upsert', 'occurred_at', '2026-06-09T12:00:00Z')) as string;

    // A '>' read hands the message to the consumer → delivery count is 1.
    await readBatch(redis, S, G, 'c1', 10, 100);
    expect(await getDeliveryCount(redis, S, G, id)).toBe(1);
    // A re-claim (XAUTOCLAIM, idle 0) counts as another delivery → 2.
    await redis.xautoclaim(S, G, 'c2', 0, '0-0', 'COUNT', 10);
    expect(await getDeliveryCount(redis, S, G, id)).toBe(2);

    // Park it to the DLQ and ack the original: DLQ carries the fields + metadata.
    const msg = { id, fields: ['item_id', 'poison-1'], event: null, parseError: 'boom' };
    await parkToDlq(redis, DLQ, 100, msg, 'failed after 2 deliveries: boom');
    await ackMessages(redis, S, G, [id]);
    expect((await redis.xpending(S, G) as any[])[0]).toBe(0);

    const dlq = await redis.xrange(DLQ, '-', '+');
    expect(dlq).toHaveLength(1);
    const dlqFields = dlq[0][1];
    expect(dlqFields).toContain('_dlq_source_id');
    expect(dlqFields).toContain(id);
    expect(dlqFields).toContain('_dlq_reason');
  });
});

describe('parseEvent', () => {
  const base = [
    'item_network', 'purple_dot', 'item_domain', 'provider',
    'item_type', 'profile_1.0', 'item_id', 'abc', 'occurred_at', '2026-06-09T12:00:00Z',
  ];

  it('parses a valid event', () => {
    const { event, parseError } = parseEvent([...base, 'op', 'delete']);
    expect(parseError).toBeUndefined();
    expect(event).toMatchObject({ item_id: 'abc', op: 'delete' });
  });

  it('defaults a missing op to upsert (legacy producers)', () => {
    const { event } = parseEvent(base);
    expect(event?.op).toBe('upsert');
  });

  it('rejects a present-but-unknown op (does not silently upsert)', () => {
    const { event, parseError } = parseEvent([...base, 'op', 'archive']);
    expect(event).toBeNull();
    expect(parseError).toContain('op');
  });

  it('rejects a missing required field', () => {
    const { event, parseError } = parseEvent(['item_network', 'purple_dot', 'op', 'upsert']);
    expect(event).toBeNull();
    expect(parseError).toBeTruthy();
  });
});
