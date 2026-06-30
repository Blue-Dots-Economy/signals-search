import { describe, it, expect } from 'vitest';
import { SearchRequestSchema } from './schemas.js';

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
