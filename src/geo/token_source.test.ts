import { describe, expect, it, vi } from 'vitest';
import { ClientCredentialsTokenSource } from './token_source.js';

function tokenResponse(token: string, expiresIn = 300, status = 200): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status });
}

function make(fetchImpl: typeof fetch, now: () => number) {
  return new ClientCredentialsTokenSource({
    tokenUrl: 'http://kc/token',
    clientId: 'cid',
    clientSecret: 'sec',
    timeoutMs: 1000,
    fetchImpl,
    now,
  });
}

describe('ClientCredentialsTokenSource', () => {
  it('fetches once and caches until expires_in minus 30s', async () => {
    let t = 0;
    const f = vi.fn(async () => tokenResponse('tok', 300));
    const src = make(f as unknown as typeof fetch, () => t);
    expect(await src.getToken()).toBe('tok');
    t = 269_000;
    await src.getToken();
    expect(f).toHaveBeenCalledTimes(1);
    t = 270_000;
    await src.getToken();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('posts a client_credentials form', async () => {
    const f = vi.fn(async (_u: unknown, _i?: RequestInit) => tokenResponse('tok'));
    await make(f as unknown as typeof fetch, () => 0).getToken();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://kc/token');
    const body = new URLSearchParams(String(init!.body));
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('sec');
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    const f = vi.fn(async () => tokenResponse('tok'));
    const src = make(f as unknown as typeof fetch, () => 0);
    const [a, b] = await Promise.all([src.getToken(), src.getToken()]);
    expect(a).toBe('tok');
    expect(b).toBe('tok');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('refetches after invalidate', async () => {
    const f = vi.fn(async () => tokenResponse('tok'));
    const src = make(f as unknown as typeof fetch, () => 0);
    await src.getToken();
    src.invalidate();
    await src.getToken();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('rejects on a non-200 and does not cache the failure', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 400 }))
      .mockResolvedValueOnce(tokenResponse('tok'));
    const src = make(f as unknown as typeof fetch, () => 0);
    await expect(src.getToken()).rejects.toThrow();
    expect(await src.getToken()).toBe('tok');
  });

  it('rejects when access_token is missing', async () => {
    const f = vi.fn(async () => new Response('{"expires_in":5}', { status: 200 }));
    await expect(make(f as unknown as typeof fetch, () => 0).getToken()).rejects.toThrow();
  });

  it('one caller aborting does not fail a concurrent caller sharing the fetch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async () => {
      await gate;
      return tokenResponse('tok');
    });
    const src = make(f as unknown as typeof fetch, () => 0);
    const ctl = new AbortController();
    const aborted = src.getToken(ctl.signal);
    const other = src.getToken(AbortSignal.timeout(5000));
    ctl.abort(new Error('deadline'));
    await expect(aborted).rejects.toThrow('deadline');
    release();
    expect(await other).toBe('tok');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted caller leaves no unhandled rejection when the fetch then fails', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      let fail!: () => void;
      const gate = new Promise<void>((r) => (fail = r));
      const f = vi.fn(async () => {
        await gate;
        return tokenResponse('x', 300, 500);
      });
      const src = make(f as unknown as typeof fetch, () => 0);
      const ctl = new AbortController();
      ctl.abort(new Error('deadline'));
      await expect(src.getToken(ctl.signal)).rejects.toThrow('deadline');
      fail();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
