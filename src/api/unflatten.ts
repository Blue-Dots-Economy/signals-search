// Rebuilds a nested object from a flat object of dot-delimited paths. A
// non-negative integer segment is an array index. String leaves are JSON-parsed
// to restore their type, falling back to the raw string.
// Design: docs/superpowers/specs/2026-07-14-search-flat-raya-design.md

const INDEX = /^\d+$/;

// Caps array indexes: one key like "filters.1000000000.value" would otherwise
// build a huge sparse array that Zod walks hole by hole (event-loop stall or
// OOM). Exceeding it throws, which the route maps to a 400.
const MAX_ARRAY_INDEX = 10_000;

// Keys containing these segments are dropped: "__proto__.x" reaching
// `node[seg] = ...` would pollute Object.prototype before validation runs.
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function parseLeaf(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function unflatten(flat: Record<string, unknown>): unknown {
  const root: Record<string | number, unknown> = {};
  for (const [key, rawValue] of Object.entries(flat)) {
    const segments = key.split('.');
    if (segments.some((s) => FORBIDDEN_SEGMENTS.has(s))) continue;
    let node: Record<string | number, unknown> = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (INDEX.test(seg) && Number(seg) > MAX_ARRAY_INDEX) {
        throw new Error(`array index ${seg} exceeds maximum ${MAX_ARRAY_INDEX}`);
      }
      const idx: string | number = INDEX.test(seg) ? Number(seg) : seg;
      if (i === segments.length - 1) {
        node[idx] = parseLeaf(rawValue);
      } else {
        if (node[idx] == null) {
          node[idx] = INDEX.test(segments[i + 1]) ? [] : {};
        }
        node = node[idx] as Record<string | number, unknown>;
      }
    }
  }
  return root;
}
