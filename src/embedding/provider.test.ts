import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { OpenAiCompatibleEmbedder } from './provider.js';

let server: Server;
let baseUrl: string;
let lastBody: any;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastBody = JSON.parse(raw);
      const input: string[] = lastBody.input;
      const data = input.map(() => ({ embedding: [3, 0, 4, 0] }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('OpenAiCompatibleEmbedder', () => {
  it('posts model+input and L2-normalizes the returned vectors', async () => {
    const embedder = new OpenAiCompatibleEmbedder({ baseUrl, model: 'BAAI/bge-m3', dim: 4 });
    const [vec] = await embedder.embed(['hello']);
    expect(lastBody.model).toBe('BAAI/bge-m3');
    expect(lastBody.input).toEqual(['hello']);
    expect(vec[0]).toBeCloseTo(0.6, 5);
    expect(vec[2]).toBeCloseTo(0.8, 5);
  });

  it('throws when returned dimension != configured dim', async () => {
    const embedder = new OpenAiCompatibleEmbedder({ baseUrl, model: 'm', dim: 1024 });
    await expect(embedder.embed(['x'])).rejects.toThrow(/dimension/i);
  });
});
