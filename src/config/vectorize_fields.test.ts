import { describe, it, expect } from 'vitest';
import { resolveVectorizeFields } from './vectorize_fields.js';

const itemSchema = {
  properties: {
    service_details: { type: 'string', vectorize: true, vector_weight: 2 },
    services_offered: { type: 'array', vectorize: true },
    provider_category: { type: 'string' }, // not vectorized
    contact_phone: { type: 'string', private: true, vectorize: true }, // illegal
  },
};

describe('resolveVectorizeFields', () => {
  it('returns vectorized public fields with weights (default 1)', () => {
    const { fields } = resolveVectorizeFields({
      properties: {
        service_details: { type: 'string', vectorize: true, vector_weight: 2 },
        services_offered: { type: 'array', vectorize: true },
        provider_category: { type: 'string' },
      },
    });
    expect(fields).toEqual([
      { path: 'service_details', weight: 2 },
      { path: 'services_offered', weight: 1 },
    ]);
  });

  it('rejects vectorize on a private property', () => {
    expect(() => resolveVectorizeFields(itemSchema)).toThrow(/private/i);
  });
});
