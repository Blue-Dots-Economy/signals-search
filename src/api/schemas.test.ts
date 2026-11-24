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

describe('IntentSchema — bbox spatial clause (#644 "search this area")', () => {
  const ctx = { version: '1.0.0', messageId: 'm1', networkId: 'n', domain: 'd', itemType: 't' };
  const parse = (intent: unknown) =>
    SearchRequestSchema.safeParse({ context: ctx, message: { intent, pagination: { limit: 20, offset: 0 } } });
  const BOX = { op: 'bbox', minLat: 12.9, minLng: 77.5, maxLat: 13.1, maxLng: 77.7 };
  const RADIUS = { op: 's_dwithin', geometry: { type: 'Point', coordinates: [77.59, 12.97] }, distanceMeters: 5000 };

  it('accepts a well-formed bbox clause with no anchor', () => {
    expect(parse({ spatial: [BOX] }).success).toBe(true);
  });

  it('REJECTS a bbox and a radius together — mutually exclusive, never one silently winning', () => {
    const r = parse({ spatial: [BOX, RADIUS] });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(/mutually exclusive/);
  });

  it('requires all four bounds — a partial box is rejected, not defaulted', () => {
    for (const missing of ['minLat', 'minLng', 'maxLat', 'maxLng'] as const) {
      const partial: Record<string, unknown> = { ...BOX };
      delete partial[missing];
      expect(parse({ spatial: [partial] }).success).toBe(false);
    }
  });

  it('rejects transposed latitude bounds rather than swapping them', () => {
    expect(parse({ spatial: [{ ...BOX, minLat: 13.1, maxLat: 12.9 }] }).success).toBe(false);
  });

  it('rejects a bbox crossing the antimeridian rather than returning an empty set', () => {
    const r = parse({ spatial: [{ ...BOX, minLng: 179.9, maxLng: -179.9 }] });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(/antimeridian/);
  });

  it('rejects out-of-range coordinates', () => {
    expect(parse({ spatial: [{ ...BOX, maxLat: 91 }] }).success).toBe(false);
    expect(parse({ spatial: [{ ...BOX, minLng: -181 }] }).success).toBe(false);
  });

  it('does NOT require an anchor, unlike a geometry-less s_dwithin', () => {
    // A bbox carries its own bounds, so the anchorless-spatial refine must not
    // fire for it. The radius case still requires an anchor.
    expect(parse({ spatial: [BOX] }).success).toBe(true);
    expect(parse({ spatial: [{ op: 's_dwithin', distanceMeters: 5000 }] }).success).toBe(false);
  });

  it('rejects an unknown spatial op', () => {
    expect(parse({ spatial: [{ op: 'polygon', coordinates: [] }] }).success).toBe(false);
  });

  it('leaves the existing s_dwithin clause working unchanged', () => {
    expect(parse({ spatial: [RADIUS] }).success).toBe(true);
  });
});

describe('IntentSchema — s_dwithin address clause', () => {
  const ctx = { version: '1.0.0', messageId: 'm1', networkId: 'n', domain: 'd', itemType: 't' };
  const parse = (intent: unknown) =>
    SearchRequestSchema.safeParse({ context: ctx, message: { intent, pagination: { limit: 20, offset: 0 } } });
  const messages = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map((i) => i.message));
  const POINT = { type: 'Point', coordinates: [77.59, 12.97] };

  it('accepts an address clause with no anchor', () => {
    expect(parse({ spatial: [{ op: 's_dwithin', address: 'Dharwad' }] }).success).toBe(true);
  });
  it('accepts an address clause with distanceMeters', () => {
    expect(parse({ spatial: [{ op: 's_dwithin', address: 'Dharwad', distanceMeters: 5000 }] }).success).toBe(true);
  });
  it('accepts a numeric address as its string form (flat-route pincode)', () => {
    const r = parse({ spatial: [{ op: 's_dwithin', address: 580001 }] });
    expect(r.success && r.data.message.intent.spatial?.[0]).toMatchObject({ address: '580001' });
  });
  it('rejects a blank address', () => {
    expect(parse({ spatial: [{ op: 's_dwithin', address: '  ' }] }).success).toBe(false);
  });
  it('rejects an address longer than 200 characters', () => {
    expect(parse({ spatial: [{ op: 's_dwithin', address: 'a'.repeat(201) }] }).success).toBe(false);
  });
  it('rejects address together with geometry', () => {
    const r = parse({ spatial: [{ op: 's_dwithin', address: 'Dharwad', geometry: POINT }] });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain('address and geometry are mutually exclusive');
  });
  it('rejects address together with intent.item.id', () => {
    const r = parse({ item: { id: '11111111-1111-1111-1111-111111111111' }, spatial: [{ op: 's_dwithin', address: 'Dharwad' }] });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain('address cannot be combined with intent.item.id');
  });
  it('still requires item.id for a clause with neither geometry nor address', () => {
    const r = parse({ spatial: [{ op: 's_dwithin', distanceMeters: 5000 }] });
    expect(r.success).toBe(false);
    expect(messages(r).join(' ')).toContain('requires intent.item.id');
  });
});

describe('SearchResponseSchema — resolvedLocation', () => {
  const ctx = { version: '1.0.0', messageId: 'm1', networkId: 'n', domain: 'd', itemType: 't' };
  const meta = { total: 0, limit: 20, offset: 0, sort_applied: 'newest' };
  const resolvedLocation = {
    input: 'Dharwad', label: 'Dharwad, Karnataka',
    point: { type: 'Point', coordinates: [75.0, 15.46] },
    precision: 'city', radiusMeters: 15000,
  };
  it('accepts a response without resolvedLocation', () => {
    expect(SearchResponseSchema.safeParse({ context: ctx, message: { items: [], meta } }).success).toBe(true);
  });
  it('accepts a response with resolvedLocation', () => {
    expect(SearchResponseSchema.safeParse({ context: ctx, message: { items: [], meta, resolvedLocation } }).success).toBe(true);
  });
  it('rejects an unknown precision', () => {
    const bad = { ...resolvedLocation, precision: 'street' };
    expect(SearchResponseSchema.safeParse({ context: ctx, message: { items: [], meta, resolvedLocation: bad } }).success).toBe(false);
  });
});

describe('IntentSchema — include_action', () => {
  const ANCHOR = '11111111-1111-1111-1111-111111111111';
  const req = (intent: Record<string, unknown>) => ({ context: valid.context, message: { intent } });

  it('accepts include_action with an anchor', () => {
    expect(SearchRequestSchema.safeParse(req({ item: { id: ANCHOR }, include_action: true })).success).toBe(true);
  });
  it('rejects include_action without an anchor', () => {
    const r = SearchRequestSchema.safeParse(req({ textSearch: 'x', include_action: true }));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toContain('include_action requires intent.item.id');
  });
  it('accepts include_action: false without an anchor', () => {
    expect(SearchRequestSchema.safeParse(req({ textSearch: 'x', include_action: false })).success).toBe(true);
  });
  it('rejects a non-boolean include_action', () => {
    expect(SearchRequestSchema.safeParse(req({ item: { id: ANCHOR }, include_action: 'yes' })).success).toBe(false);
  });
});

describe('IntentSchema — action filter clauses', () => {
  const ANCHOR = '11111111-1111-1111-1111-111111111111';
  const req = (filter: Record<string, unknown>, anchored = true) => ({
    context: valid.context,
    message: { intent: anchored ? { item: { id: ANCHOR }, filters: [filter] } : { textSearch: 'x', filters: [filter] } },
  });
  const parse = (filter: Record<string, unknown>, anchored = true) => SearchRequestSchema.safeParse(req(filter, anchored));
  const action = (op: string, target: string, value: unknown) => ({ objType: 'action', op, target, value });

  it.each([
    action('neq', 'status_group', 'create'),
    action('not_in', 'status_group', ['create', 'reject']),
    action('eq', 'status_group', 'accept'),
    action('in', 'status_group', ['cancel']),
    action('eq', 'type', 'apply'),
    action('in', 'status', ['submitted', 'rejected']),
    action('gte', 'created_at', 1788220800),
    action('lte', 'status_updated_at', 0),
  ])('accepts %o', (f) => {
    expect(parse(f).success).toBe(true);
  });

  it('requires an anchor', () => {
    const r = parse(action('neq', 'status_group', 'create'), false);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toContain('an action filter requires intent.item.id');
  });

  it.each([
    [action('eq', 'status_group', 'open'), 'unknown status_group open'],
    [action('eq', 'lifecycle', 'live'), 'action target must be one of'],
    [action('gt', 'status', 'x'), "op 'gt' is not allowed"],
    [action('eq', 'created_at', 1788220800), "op 'eq' is not allowed on action target 'created_at'"],
    [action('gte', 'created_at', 1788220800000), 'whole epoch seconds'],
    [action('gte', 'created_at', '2026-09-01'), 'whole epoch seconds'],
    [action('in', 'status', 'submitted'), 'non-empty array of strings'],
    [action('not_in', 'status_group', []), 'non-empty array of strings'],
    [action('eq', 'type', ['apply']), 'requires a string value'],
    [action('eq', 'type', ''), 'requires a string value'],
  ])('rejects %o', (f, message) => {
    const r = parse(f);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message).join('|')).toContain(message);
  });

  it('rejects an objType other than action', () => {
    expect(parse({ objType: 'item', op: 'eq', target: 'item_state.x', value: 'y' }).success).toBe(false);
  });

  it('keeps item clauses as before: not_in is rejected and the target must be item_state.<field>', () => {
    expect(parse({ op: 'eq', target: 'item_state.job_type', value: 'full_time' }).success).toBe(true);
    expect(parse({ op: 'not_in', target: 'item_state.job_type', value: ['a'] }).error?.issues[0].message)
      .toContain("op 'not_in' is only allowed on action clauses");
    expect(parse({ op: 'eq', target: 'status', value: 'x' }).error?.issues[0].message).toContain('target must be item_state.<field>');
  });
});

describe('IntentSchema — created_at / updated_at ranges (epoch seconds)', () => {
  const req = (intent: Record<string, unknown>) => ({ context: valid.context, message: { intent: { textSearch: 'x', ...intent } } });

  it('accepts both bounds, one bound, or either field alone, without an anchor', () => {
    expect(SearchRequestSchema.safeParse(req({ created_at: { gte: 1793491200, lte: 1795219199 } })).success).toBe(true);
    expect(SearchRequestSchema.safeParse(req({ updated_at: { gte: 1794700800 } })).success).toBe(true);
    expect(SearchRequestSchema.safeParse(req({ updated_at: { lte: 0 } })).success).toBe(true);
  });
  it('accepts equal bounds', () => {
    expect(SearchRequestSchema.safeParse(req({ created_at: { gte: 1793491200, lte: 1793491200 } })).success).toBe(true);
  });
  it('rejects an ISO 8601 string', () => {
    expect(SearchRequestSchema.safeParse(req({ created_at: { gte: '2026-11-01T00:00:00Z' } })).success).toBe(false);
  });
  it('rejects a fractional or negative value', () => {
    expect(SearchRequestSchema.safeParse(req({ created_at: { gte: 1793491200.5 } })).success).toBe(false);
    expect(SearchRequestSchema.safeParse(req({ created_at: { gte: -1 } })).success).toBe(false);
  });
  it('rejects a millisecond epoch', () => {
    expect(SearchRequestSchema.safeParse(req({ created_at: { gte: 1793491200000 } })).success).toBe(false);
  });
  it('rejects gte later than lte', () => {
    const r = SearchRequestSchema.safeParse(req({ updated_at: { gte: 1795219199, lte: 1793491200 } }));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toContain('gte must not be later than lte');
  });
});

describe('SearchResponseSchema — action', () => {
  const ctx = valid.context;
  const meta = { total: 1, limit: 20, offset: 0, sort_applied: 'relevance' };
  const item = {
    item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: 'j4',
    item_state: {}, item_locations: [], item_instance_url: null, item_schema_url: null,
    created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', created_by: null, lifecycle_status: 'live',
  };
  const action = { type: 'apply', status: 'rejected', created_at: '2026-11-10T09:12:00.000Z', status_updated_at: '2026-11-12T15:40:00.000Z' };

  it('accepts a result without an action', () => {
    expect(SearchResponseSchema.safeParse({ context: ctx, message: { items: [item], meta } }).success).toBe(true);
  });
  it('accepts a result with an action', () => {
    expect(SearchResponseSchema.safeParse({ context: ctx, message: { items: [{ ...item, action }], meta } }).success).toBe(true);
  });
  it('rejects an action missing a field', () => {
    const { status_updated_at: _, ...partial } = action;
    expect(SearchResponseSchema.safeParse({ context: ctx, message: { items: [{ ...item, action: partial }], meta } }).success).toBe(false);
  });
});
