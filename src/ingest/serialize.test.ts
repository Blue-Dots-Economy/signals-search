import { describe, it, expect } from 'vitest';
import { serializeItemText, contentHash } from './serialize.js';

const fields = [
  { path: 'service_details', weight: 2 },
  { path: 'services_offered', weight: 1 },
];

describe('serializeItemText', () => {
  it('concatenates fields, repeating by weight, arrays joined', () => {
    const text = serializeItemText(
      { service_details: 'speech therapy', services_offered: ['Assistive Devices', 'Rehab'], provider_category: 'NGO' },
      fields,
    );
    expect(text).toBe(
      'service_details: speech therapy\nservice_details: speech therapy\nservices_offered: Assistive Devices, Rehab',
    );
  });

  it('is stable regardless of input key order', () => {
    const a = serializeItemText({ service_details: 'x', services_offered: ['y'] }, fields);
    const b = serializeItemText({ services_offered: ['y'], service_details: 'x' }, fields);
    expect(a).toBe(b);
  });
});

describe('contentHash', () => {
  it('changes when text changes and is stable otherwise', () => {
    expect(contentHash('a')).toBe(contentHash('a'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});
