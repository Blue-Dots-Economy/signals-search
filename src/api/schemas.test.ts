import { describe, it, expect } from 'vitest';
import { SearchRequestSchema, SearchResponseSchema } from './schemas.js';

const valid = {
  context: { version: '1.0.0', messageId: 'm1', timestamp: '2026-06-09T12:00:00Z', networkId: 'purple_dot', domain: 'provider', itemType: 'profile_1.0' },
  message: {
    intent: {
      textSearch: 'speech therapy',
      spatial: [{ op: 's_dwithin', geometry: { type: 'Point', coordinates: [77.61, 12.91] }, distanceMeters: 5000 }],
      filters: [{ op: 'eq', target: 'item_state.provider_category', value: 'NGO / Trust' }],
    },
    pagination: { limit: 20, offset: 0 },
  },
};

describe('SearchRequestSchema', () => {
  it('accepts a full valid request', () => {
    expect(() => SearchRequestSchema.parse(valid)).not.toThrow();
  });
  it('defaults pagination to limit 20 / offset 0', () => {
    const p = SearchRequestSchema.parse({ context: valid.context, message: { intent: { textSearch: 'x' } } });
    expect(p.message.pagination).toEqual({ limit: 20, offset: 0 });
  });
  it('rejects missing networkId', () => {
    const bad = { ...valid, context: { ...valid.context, networkId: undefined } };
    expect(() => SearchRequestSchema.parse(bad)).toThrow();
  });
  it('rejects a numeric comparator filter whose value is not a finite number', () => {
    const bad = { context: valid.context, message: { intent: { filters: [{ op: 'gt', target: 'item_state.age', value: 'abc' }] } } };
    expect(() => SearchRequestSchema.parse(bad)).toThrow();
  });
  it("rejects an 'in' filter whose value is not an array", () => {
    const bad = { context: valid.context, message: { intent: { filters: [{ op: 'in', target: 'item_state.tag', value: 'x' }] } } };
    expect(() => SearchRequestSchema.parse(bad)).toThrow();
  });
  it('accepts a valid numeric gt filter', () => {
    const ok = { context: valid.context, message: { intent: { filters: [{ op: 'gt', target: 'item_state.age', value: 18 }] } } };
    expect(() => SearchRequestSchema.parse(ok)).not.toThrow();
  });
  it('accepts a coordinate-less spatial clause when an anchor item.id is present', () => {
    const ok = { context: valid.context, message: { intent: { item: { id: '11111111-1111-1111-1111-111111111111' }, spatial: [{ op: 's_dwithin', distanceMeters: 5000 }] } } };
    expect(() => SearchRequestSchema.parse(ok)).not.toThrow();
  });
  it('accepts a coordinate-less spatial clause without distanceMeters (default applied at runtime)', () => {
    const ok = { context: valid.context, message: { intent: { item: { id: '11111111-1111-1111-1111-111111111111' }, spatial: [{ op: 's_dwithin' }] } } };
    expect(() => SearchRequestSchema.parse(ok)).not.toThrow();
  });
  it('rejects a coordinate-less spatial clause without an anchor item.id', () => {
    const bad = { context: valid.context, message: { intent: { textSearch: 'x', spatial: [{ op: 's_dwithin', distanceMeters: 5000 }] } } };
    expect(() => SearchRequestSchema.parse(bad)).toThrow();
  });
  it('rejects more than one spatial clause (only one is supported)', () => {
    const bad = { context: valid.context, message: { intent: { spatial: [
      { op: 's_dwithin', geometry: { type: 'Point', coordinates: [77.6, 12.9] }, distanceMeters: 5000 },
      { op: 's_dwithin', geometry: { type: 'Point', coordinates: [72.8, 19.0] }, distanceMeters: 5000 },
    ] } } };
    expect(() => SearchRequestSchema.parse(bad)).toThrow();
  });
});

describe('IntentSchema — sort (contract §1)', () => {
  const ctx = { version: '1.0.0', messageId: 'm1', networkId: 'n', domain: 'd', itemType: 't' };
  const parse = (intent: unknown) =>
    SearchRequestSchema.safeParse({ context: ctx, message: { intent, pagination: { limit: 20, offset: 0 } } });

  it('accepts each sort value', () => {
    for (const sort of ['relevance', 'newest', 'nearest'] as const) {
      expect(parse({ sort }).success).toBe(true);
    }
  });

  it('rejects an unknown sort value', () => {
    expect(parse({ sort: 'cheapest' }).success).toBe(false);
  });

  it('treats sort as optional (backward compatible)', () => {
    expect(parse({}).success).toBe(true);
  });

  it('accepts orderingCenter as a GeoJSON Point', () => {
    const r = parse({ sort: 'nearest', orderingCenter: { type: 'Point', coordinates: [77.59, 12.97] } });
    expect(r.success).toBe(true);
  });

  it('rejects orderingCenter with a wrong coordinate arity', () => {
    expect(parse({ orderingCenter: { type: 'Point', coordinates: [77.59] } }).success).toBe(false);
  });

  it('does NOT require an anchor for orderingCenter (unlike anchorless spatial)', () => {
    expect(parse({ orderingCenter: { type: 'Point', coordinates: [77.59, 12.97] } }).success).toBe(true);
  });

  it('keeps sort and orderingCenter INSIDE intent, so the cache key covers them', () => {
    // Placement guard: cacheKey hashes {networkId, domain, itemType, intent,
    // pagination}. If these fields ever move to `message`, two different sorts
    // share a cache entry. Asserting the parsed shape locks the placement.
    const r = parse({ sort: 'nearest', orderingCenter: { type: 'Point', coordinates: [1, 2] } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.message.intent.sort).toBe('nearest');
      expect(r.data.message.intent.orderingCenter).toEqual({ type: 'Point', coordinates: [1, 2] });
    }
  });
});

describe('SearchResponseSchema — sort_applied (contract §2)', () => {
  it('requires sort_applied on meta', () => {
    const ctx = { version: '1.0.0', messageId: 'm1', networkId: 'n', domain: 'd', itemType: 't' };
    const without = { context: ctx, message: { items: [], meta: { total: 0, limit: 20, offset: 0 } } };
    expect(SearchResponseSchema.safeParse(without).success).toBe(false);

    const withIt = { context: ctx, message: { items: [], meta: { total: 0, limit: 20, offset: 0, sort_applied: 'newest' } } };
    expect(SearchResponseSchema.safeParse(withIt).success).toBe(true);
  });
});
