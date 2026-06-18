import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { TeiReranker } from './reranker.js';

let server: Server; let baseUrl: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const out = body.texts.map((_: string, i: number) => ({ index: i, score: i }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('TeiReranker', () => {
  it('reorders documents by reranker score (desc)', async () => {
    const rr = new TeiReranker({ baseUrl, model: 'BAAI/bge-reranker-v2-m3' });
    const order = await rr.rerank('query', ['doc0', 'doc1', 'doc2']);
    expect(order).toEqual([2, 1, 0]);
  });
});
