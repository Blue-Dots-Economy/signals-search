import { describe, it, expect } from 'vitest';
import { WorkerHeartbeat } from './health.js';

describe('WorkerHeartbeat', () => {
  it('is not ready before booting, even with fresh progress', () => {
    const hb = new WorkerHeartbeat(30_000, 1_000);
    expect(hb.isReady(1_000)).toBe(false);
  });

  it('is ready once booted and progress is within the staleness window', () => {
    const hb = new WorkerHeartbeat(30_000, 1_000);
    hb.markBooted();
    expect(hb.isReady(1_000)).toBe(true);
    // 29s later — still fresh.
    expect(hb.isReady(30_000)).toBe(true);
  });

  it('goes not-ready when the loop makes no progress past the window (wedged)', () => {
    const hb = new WorkerHeartbeat(30_000, 1_000);
    hb.markBooted();
    // 31s with no mark() — a wedged loop.
    expect(hb.isReady(32_000)).toBe(false);
  });

  it('mark() refreshes the window so an active loop stays ready', () => {
    const hb = new WorkerHeartbeat(30_000, 1_000);
    hb.markBooted();
    hb.mark(40_000);
    expect(hb.isReady(50_000)).toBe(true);
    expect(hb.isReady(71_000)).toBe(false);
  });
});
