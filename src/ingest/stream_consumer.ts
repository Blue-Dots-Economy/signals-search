import type Redis from 'ioredis';

export type ItemEvent = {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  op: 'upsert' | 'delete';
  occurred_at: string;
};

export type StreamMessage = { id: string; event: ItemEvent };

export async function ensureConsumerGroup(redis: Redis, stream: string, group: string): Promise<void> {
  try {
    await (redis as any).xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }
}

function fieldsToEvent(fields: string[]): ItemEvent {
  const m: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) m[fields[i]] = fields[i + 1];
  return {
    item_network: m.item_network,
    item_domain: m.item_domain,
    item_type: m.item_type,
    item_id: m.item_id,
    op: (m.op as ItemEvent['op']) ?? 'upsert',
    occurred_at: m.occurred_at,
  };
}

export async function readBatch(
  redis: Redis, stream: string, group: string, consumer: string, count: number, blockMs: number,
): Promise<StreamMessage[]> {
  const res = (await (redis as any).xreadgroup(
    'GROUP', group, consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', stream, '>',
  )) as [string, [string, string[]][]][] | null;
  if (!res) return [];
  const [, entries] = res[0];
  return entries.map(([id, fields]) => ({ id, event: fieldsToEvent(fields) }));
}

export async function ackMessages(redis: Redis, stream: string, group: string, ids: string[]): Promise<void> {
  if (ids.length) await (redis as any).xack(stream, group, ...ids);
}
