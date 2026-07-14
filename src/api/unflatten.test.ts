import { describe, it, expect } from 'vitest';
import { unflatten } from './unflatten.js';

describe('unflatten', () => {
  it('returns an empty object for empty input', () => {
    expect(unflatten({})).toEqual({});
  });

  it('builds nested objects from dot-delimited keys', () => {
    expect(unflatten({ 'context.networkId': 'blue_dot', 'context.domain': 'seeker' })).toEqual({
      context: { networkId: 'blue_dot', domain: 'seeker' },
    });
  });

  it('treats a numeric segment as an array index', () => {
    expect(
      unflatten({
        'message.intent.filters.0.op': 'eq',
        'message.intent.filters.0.target': 'item_state.trade',
      }),
    ).toEqual({ message: { intent: { filters: [{ op: 'eq', target: 'item_state.trade' }] } } });
  });

  it('builds arrays of primitives via indexed keys (coordinates)', () => {
    expect(
      unflatten({
        'message.intent.spatial.0.geometry.coordinates.0': '77.59',
        'message.intent.spatial.0.geometry.coordinates.1': '12.97',
      }),
    ).toEqual({
      message: { intent: { spatial: [{ geometry: { coordinates: [77.59, 12.97] } }] } },
    });
  });

  it('handles nested arrays (filters.0.value.1)', () => {
    expect(
      unflatten({ 'filters.0.value.0': 'a', 'filters.0.value.1': 'b' }),
    ).toEqual({ filters: [{ value: ['a', 'b'] }] });
  });

  it('JSON-parses leaves to restore number, boolean, and array types', () => {
    expect(
      unflatten({
        'message.pagination.limit': '20',
        'message.intent.flag': 'true',
        'message.intent.tags': '["a","b"]',
      }),
    ).toEqual({
      message: { pagination: { limit: 20 }, intent: { flag: true, tags: ['a', 'b'] } },
    });
  });

  it('falls back to the raw string when a leaf is not valid JSON', () => {
    expect(unflatten({ 'message.intent.textSearch': 'plumber' })).toEqual({
      message: { intent: { textSearch: 'plumber' } },
    });
  });

  it('keeps a JSON-quoted string as a string (pincode edge case)', () => {
    // '"560001"' parses back to the string "560001", not the number 560001.
    expect(unflatten({ 'message.intent.filters.0.value': '"560001"' })).toEqual({
      message: { intent: { filters: [{ value: '560001' }] } },
    });
  });

  it('passes non-string leaves through unchanged', () => {
    expect(unflatten({ 'message.pagination.limit': 20 })).toEqual({
      message: { pagination: { limit: 20 } },
    });
  });
});
