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
    let node: Record<string | number, unknown> = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
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
