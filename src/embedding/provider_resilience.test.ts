import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OpenAiCompatibleEmbedder } from './provider.js';

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

const ok = (dim: number) => JSON.stringify({ data: [{ embedding: Array.from({ length: dim }, () => 0) }] });

describe('OpenAiCompatibleEmbedder resilience', () => {
  it('aborts a hung request after timeoutMs instead of hanging forever', async () => {
    const base = await listen(() => { /* never responds */ });
    const embedder = new OpenAiCompatibleEmbedder({ baseUrl: base, model: 'm', dim: 4, timeoutMs: 150, maxRetries: 0 });
    await expect(embedder.embed(['hi'])).rejects.toThrow(/timeout|abort/i);
  });

  it('retries a transient failure up to maxRetries, then succeeds', async () => {
    let hits = 0;
    const base = await listen((_req, res) => {
      hits += 1;
      if (hits === 1) { res.statusCode = 503; res.end('try later'); return; }
      res.setHeader('content-type', 'application/json'); res.end(ok(4));
    });
    const embedder = new OpenAiCompatibleEmbedder({ baseUrl: base, model: 'm', dim: 4, timeoutMs: 1000, maxRetries: 2 });
    const out = await embedder.embed(['hi']);
    expect(hits).toBe(2);
    expect(out).toHaveLength(1);
  });
});
