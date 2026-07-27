import http from 'node:http';

/**
 * Liveness/readiness state for the ingest worker.
 *
 * The worker is a background consumer with no request surface, so k8s has
 * nothing to probe — a wedged sweep or a stuck ingest loop would otherwise look
 * healthy forever. `mark()` is called on every unit of loop progress (each
 * iteration and each handled message); readiness goes stale once no progress
 * has happened within `staleMs`, turning a wedge into a visible `/ready` 503.
 */
export class WorkerHeartbeat {
  private lastProgressAt: number;
  private booted = false;

  constructor(
    private readonly staleMs: number,
    now: number = Date.now(),
  ) {
    this.lastProgressAt = now;
  }

  /** Marks the worker as past startup (consumer group ensured, loop entered). */
  markBooted(): void {
    this.booted = true;
  }

  /** Records loop progress. Called each iteration and after each message. */
  mark(now: number = Date.now()): void {
    this.lastProgressAt = now;
  }

  /** Ready = booted and the loop made progress within the staleness window. */
  isReady(now: number = Date.now()): boolean {
    return this.booted && now - this.lastProgressAt < this.staleMs;
  }
}

/**
 * Starts a minimal HTTP health surface for the worker.
 *
 * @param port - Port to bind (0.0.0.0).
 * @param heartbeat - Progress tracker backing the readiness decision.
 * @returns The listening server, so the caller can close it on shutdown.
 */
export function startWorkerHealthServer(port: number, heartbeat: WorkerHeartbeat): http.Server {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // Liveness: the process is up and the HTTP handler responds.
    if (req.url === '/health') return send(200, { status: 'ok' });
    // Readiness: the ingest loop is actually making progress.
    if (req.url === '/ready') {
      return heartbeat.isReady()
        ? send(200, { status: 'ready' })
        : send(503, { status: 'not_ready' });
    }
    send(404, { error: 'not_found' });
  });
  server.listen(port, '0.0.0.0');
  return server;
}
