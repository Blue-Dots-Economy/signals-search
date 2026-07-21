// Rebuilds a nested object/array structure from a flat object whose keys are
// dot-delimited canonical paths. A path segment that is a non-negative integer
// denotes an array index; any other segment is an object key. Each leaf value,
// if a string, is JSON-parsed to restore its real type (number/boolean/array),
// falling back to the raw string when it is not valid JSON. Non-string leaves
// pass through unchanged.
//
// This lets a caller that can only emit a flat object of strings (e.g. a Raya
// LLM tool) reconstruct the canonical, correctly-typed nested search request.
// See docs/superpowers/specs/2026-07-14-search-flat-raya-design.md.

const INDEX = /^\d+$/;

// Upper bound on a numeric path segment (array index). Without it, a single
// tiny key like "message.intent.filters.1000000000.value" would inflate into a
// ~10⁹-length sparse array; Zod validation then walks the whole `length` and
// allocates an issue per hole → event-loop stall / OOM from one small request.
// Real requests need only a handful of array elements (one spatial clause, a
// couple of coordinates, a few filters), so a few thousand is ample headroom
// while keeping any allocation trivially cheap. Exceeding it throws, and the
// route maps the throw to a 400 (see registerSearchRoute).
const MAX_ARRAY_INDEX = 10_000;

// Segments that could walk into or mutate an object's prototype. The body is
// authenticated-but-externally-shaped, so a key like "__proto__.x" must never
// reach `node[seg] = ...` — that would pollute Object.prototype process-wide,
// before validation runs. Any key containing one of these segments is dropped
// (they are never valid canonical paths anyway).
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
