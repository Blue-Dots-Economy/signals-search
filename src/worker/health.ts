import http from 'node:http';

/**
 * Readiness state for the ingest worker, which has no request surface of its
 * own. `mark()` records loop progress; with none within `staleMs`, `/ready`
 * returns 503 so a stuck ingest loop becomes visible.
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

  mark(now: number = Date.now()): void {
    this.lastProgressAt = now;
  }

  isReady(now: number = Date.now()): boolean {
    return this.booted && now - this.lastProgressAt < this.staleMs;
  }
}

/** Starts the worker's health server on 0.0.0.0; the caller closes it on shutdown. */
export function startWorkerHealthServer(port: number, heartbeat: WorkerHeartbeat): http.Server {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/health') return send(200, { status: 'ok' });
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
