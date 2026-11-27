/** Skips invocations while one is in flight, so interval sweeps never stack.
 *  fn's errors propagate and the in-flight flag is always cleared. */
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
