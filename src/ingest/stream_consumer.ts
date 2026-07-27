import type { Redis } from 'ioredis';
import { z } from 'zod';

/** Ingestion event schema. `op` defaults to `upsert` only when the field is
 *  absent (legacy producers); a present-but-unknown `op` is rejected so a future
 *  op type is surfaced as poison rather than silently mis-processed as an upsert. */
const ItemEventSchema = z.object({
  item_network: z.string().min(1),
  item_domain: z.string().min(1),
  item_type: z.string().min(1),
  item_id: z.string().min(1),
  op: z.enum(['upsert', 'delete']).default('upsert'),
  occurred_at: z.string().min(1),
});

export type ItemEvent = z.infer<typeof ItemEventSchema>;

/** A raw stream entry plus its parse outcome. `event` is null when the fields
 *  failed schema validation (`parseError` explains why) — such messages are
 *  poison and must be dead-lettered, never processed. `fields` is retained so a
 *  poison message can be re-published verbatim to the DLQ for triage. */
export type StreamMessage = { id: string; fields: string[]; event: ItemEvent | null; parseError?: string };

export async function ensureConsumerGroup(redis: Redis, stream: string, group: string): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }
}

function fieldsToMap(fields: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) m[fields[i]] = fields[i + 1];
  return m;
}

/** Validate a raw stream entry against {@link ItemEventSchema}. Returns the
 *  typed event, or `event: null` + a `parseError` string when invalid. */
export function parseEvent(fields: string[]): { event: ItemEvent | null; parseError?: string } {
  const parsed = ItemEventSchema.safeParse(fieldsToMap(fields));
  if (!parsed.success) {
    return { event: null, parseError: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { event: parsed.data };
}

function toMessage(id: string, fields: string[]): StreamMessage {
  const { event, parseError } = parseEvent(fields);
  return { id, fields, event, parseError };
}

export async function readBatch(
  redis: Redis, stream: string, group: string, consumer: string, count: number, blockMs: number,
): Promise<StreamMessage[]> {
  const res = (await redis.xreadgroup(
    'GROUP', group, consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', stream, '>',
  )) as [string, [string, string[]][]][] | null;
  if (!res) return [];
  const [, entries] = res[0];
  return entries.map(([id, fields]) => toMessage(id, fields));
}

export async function ackMessages(redis: Redis, stream: string, group: string, ids: string[]): Promise<void> {
  if (ids.length) await redis.xack(stream, group, ...ids);
}

export async function reclaimPending(
  redis: Redis, stream: string, group: string, consumer: string, minIdleMs: number, count: number,
): Promise<StreamMessage[]> {
  // XAUTOCLAIM <key> <group> <consumer> <min-idle-time> <start> COUNT <count>
  // Returns [nextCursor, entries, deletedIds]; entries is [[id, fields[] | null], ...].
  const res = (await redis.xautoclaim(
    stream, group, consumer, minIdleMs, '0-0', 'COUNT', count,
  )) as [string, [string, string[] | null][], string[]];
  const entries = res?.[1] ?? [];
  const out: StreamMessage[] = [];
  for (const [id, fields] of entries) {
    if (!fields) continue; // tombstoned (deleted from the stream) — skip
    out.push(toMessage(id, fields));
  }
  return out;
}

/** Delivery count for a single pending entry (how many times it has been handed
 *  to a consumer). Returns 0 when the id is no longer pending. Used to decide
 *  when a repeatedly-failing message has become poison. */
export async function getDeliveryCount(redis: Redis, stream: string, group: string, id: string): Promise<number> {
  // XPENDING <key> <group> <start> <end> <count> → [[id, consumer, idleMs, deliveryCount], ...]
  const res = (await redis.xpending(stream, group, id, id, 1)) as [string, string, number, string][];
  if (!res || res.length === 0) return 0;
  return Number(res[0][3]);
}

/** Re-publish a poison message verbatim to the dead-letter stream (bounded by
 *  `MAXLEN ~ maxLen`), tagged with the reason and source id for triage. The
 *  caller must still ack the original on its group so it stops redelivering. */
export async function parkToDlq(
  redis: Redis, dlqStream: string, maxLen: number, msg: StreamMessage, reason: string,
): Promise<void> {
  await redis.xadd(
    dlqStream, 'MAXLEN', '~', maxLen, '*',
    ...msg.fields,
    '_dlq_reason', reason.slice(0, 500),
    '_dlq_source_id', msg.id,
    '_dlq_at', new Date().toISOString(),
  );
}
