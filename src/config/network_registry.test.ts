import { describe, it, expect, beforeAll } from 'vitest';
import { loadNetworkRegistry, type NetworkRegistry } from './network_registry.js';

let reg: NetworkRegistry;
beforeAll(async () => { reg = await loadNetworkRegistry('test/fixtures/networks'); });

describe('NetworkRegistry', () => {
  it('resolves vectorize fields for a type (public only, weighted)', () => {
    const fields = reg.vectorizeFields('purple_dot', 'provider', 'profile_1.0');
    expect(fields).toEqual([
      { path: 'service_details', weight: 2 },
      { path: 'services_offered', weight: 1 },
    ]);
  });
  it('allows seeker -> provider per the actions matrix', () => {
    expect(reg.isInteractionAllowed('purple_dot', 'seeker', 'provider')).toBe(true);
  });
  it('denies provider -> seeker (no such interaction)', () => {
    expect(reg.isInteractionAllowed('purple_dot', 'provider', 'seeker')).toBe(false);
  });
  it('does not treat a cross-network interaction as a same-network allow', () => {
    // fixture has seeker -> blue_dot/aggregator; querying it as a purple_dot
    // (same-network) interaction must be denied — to_network must equal the network.
    expect(reg.isInteractionAllowed('purple_dot', 'seeker', 'aggregator')).toBe(false);
  });
  it('knows whether a domain is served', () => {
    expect(reg.hasDomain('purple_dot', 'provider')).toBe(true);
    expect(reg.hasDomain('purple_dot', 'ghost')).toBe(false);
  });
});
