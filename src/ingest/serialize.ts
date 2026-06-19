import { createHash } from 'node:crypto';
import type { VectorizeField } from '../config/vectorize_fields.js';

function valueToString(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  if (v === null || v === undefined) return '';
  return String(v);
}

export function serializeItemText(state: Record<string, unknown>, fields: VectorizeField[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const value = valueToString(state[f.path]);
    if (value === '') continue;
    const line = `${f.path}: ${value}`;
    for (let i = 0; i < f.weight; i++) parts.push(line);
  }
  return parts.join('\n');
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
