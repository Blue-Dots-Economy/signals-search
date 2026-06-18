import { describe, it, expect } from 'vitest';
import { makeGuarded } from './guarded.js';

describe('makeGuarded', () => {
  it('skips overlapping invocations while one is in flight, then runs again once free', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const guarded = makeGuarded(async () => { calls += 1; await gate; });

    const a = guarded(); // starts; calls === 1, awaiting gate
    const b = guarded(); // in flight → skipped
    expect(calls).toBe(1);

    release();
    await Promise.all([a, b]);

    await guarded(); // free now → runs again
    expect(calls).toBe(2);
  });

  it('clears the in-flight flag even when fn throws', async () => {
    let calls = 0;
    const guarded = makeGuarded(async () => { calls += 1; throw new Error('boom'); });
    await expect(guarded()).rejects.toThrow('boom');
    await expect(guarded()).rejects.toThrow('boom'); // not stuck "in flight"
    expect(calls).toBe(2);
  });
});
