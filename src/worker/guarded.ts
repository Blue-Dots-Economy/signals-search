/** Wrap an async fn so overlapping invocations are skipped while one is in
 *  flight. Used to keep interval-driven sweeps from stacking. The wrapper
 *  re-throws fn's error (and clears the in-flight flag) so failures surface. */
export function makeGuarded(fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}
