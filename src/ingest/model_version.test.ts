import { describe, expect, it } from 'vitest';
import { composeModelVersion } from './model_version.js';

describe('composeModelVersion', () => {
  // The load-bearing case. model_version feeds the ingest content hash, so if an
  // unset EMBEDDING_SERVING_VERSION produced anything other than the exact legacy
  // string, merging this change would silently re-embed the entire corpus on the
  // next deploy. This test is the guard on that, not a formatting nicety.
  it('is byte-identical to the legacy format when no serving version is set', () => {
    expect(composeModelVersion('BAAI/bge-m3', 1024)).toBe('BAAI/bge-m3@1024');
  });

  it.each([undefined, '', '   '])(
    'treats %o as "not set", so no content hash changes',
    (value) => {
      expect(composeModelVersion('BAAI/bge-m3', 1024, value)).toBe('BAAI/bge-m3@1024');
    },
  );

  it('appends the serving version when one is configured', () => {
    expect(composeModelVersion('BAAI/bge-m3', 1024, 'tei-1.9')).toBe(
      'BAAI/bge-m3@1024@tei-1.9',
    );
  });

  it('trims surrounding whitespace so a stray env space cannot fork the hash', () => {
    expect(composeModelVersion('BAAI/bge-m3', 1024, '  tei-1.9  ')).toBe(
      'BAAI/bge-m3@1024@tei-1.9',
    );
  });

  it('distinguishes serving versions, so /v1/relevance can refuse to compare them', () => {
    const before = composeModelVersion('BAAI/bge-m3', 1024, 'tei-1.7');
    const after = composeModelVersion('BAAI/bge-m3', 1024, 'tei-1.9');

    expect(before).not.toBe(after);
  });

  it('still distinguishes model and dimension changes', () => {
    expect(composeModelVersion('BAAI/bge-m3', 1024)).not.toBe(
      composeModelVersion('BAAI/bge-m3', 512),
    );
    expect(composeModelVersion('BAAI/bge-m3', 1024)).not.toBe(
      composeModelVersion('intfloat/e5-large', 1024),
    );
  });
});
