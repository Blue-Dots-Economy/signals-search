import { describe, it, expect } from 'vitest';
import { resolveSort } from './search_route.js';

const base = { hasAnchor: false, hasText: false, hasCenter: false, hasSpatialFilter: false };

describe('resolveSort — explicit requests', () => {
  it('honours relevance when an anchor is present', () => {
    expect(resolveSort({ ...base, requested: 'relevance', hasAnchor: true })).toBe('relevance');
  });

  it('honours relevance when only text is present', () => {
    expect(resolveSort({ ...base, requested: 'relevance', hasText: true })).toBe('relevance');
  });

  it('falls back to newest for relevance with neither anchor nor text', () => {
    expect(resolveSort({ ...base, requested: 'relevance' })).toBe('newest');
  });

  it('honours nearest when a centre resolves', () => {
    expect(resolveSort({ ...base, requested: 'nearest', hasCenter: true })).toBe('nearest');
  });

  it('falls back to newest for nearest with no centre', () => {
    expect(resolveSort({ ...base, requested: 'nearest' })).toBe('newest');
  });

  it('always honours newest', () => {
    expect(resolveSort({ ...base, requested: 'newest' })).toBe('newest');
  });
});

describe('resolveSort — inferred (no sort requested), preserving today’s behaviour', () => {
  it('infers relevance from an anchor', () => {
    expect(resolveSort({ ...base, hasAnchor: true })).toBe('relevance');
  });

  it('infers relevance from text', () => {
    expect(resolveSort({ ...base, hasText: true })).toBe('relevance');
  });

  it('infers nearest from a spatial filter when there is no query vector', () => {
    expect(resolveSort({ ...base, hasSpatialFilter: true, hasCenter: true })).toBe('nearest');
  });

  it('prefers the query vector over a spatial filter, as today', () => {
    expect(resolveSort({ ...base, hasAnchor: true, hasSpatialFilter: true, hasCenter: true })).toBe('relevance');
  });

  it('infers newest with no signals at all', () => {
    expect(resolveSort(base)).toBe('newest');
  });
});
