import { describe, expect, it, vi, type Mock } from 'vitest';
import { SignalsGeocoder } from './geocoder.js';
import type { TokenSource } from './token_source.js';

const OK_BODY = {
  label: 'Dharwad, Karnataka',
  point: { lat: 15.45, lng: 75.0 },
  precision: 'city',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function tokens(): TokenSource & { invalidate: Mock<() => void> } {
  return { getToken: vi.fn(async () => 'tok'), invalidate: vi.fn<() => void>() };
}

function make(f: unknown, t: TokenSource) {
  return new SignalsGeocoder({
    baseUrl: 'http://signals/',
    tokens: t,
    timeoutMs: 1000,
    fetchImpl: f as typeof fetch,
  });
}

describe('SignalsGeocoder', () => {
  it('maps a 200 to found and sends bearer + address', async () => {
    const f = vi.fn(async (_u: unknown, _i?: RequestInit) => json(200, OK_BODY));
    const r = await make(f, tokens()).resolve('Dharwad');
    expect(r).toEqual({
      kind: 'found',
      label: 'Dharwad, Karnataka',
      lat: 15.45,
      lng: 75.0,
      precision: 'city',
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://signals/api/v1/geo/resolve');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init!.body))).toEqual({ address: 'Dharwad' });
  });

  it('maps 422 to not_found', async () => {
    const f = vi.fn(async () => json(422, { error: 'LOCATION_NOT_RESOLVED' }));
    expect(await make(f, tokens()).resolve('x')).toEqual({ kind: 'not_found' });
  });

  it.each([503, 403, 500])('maps %i to unavailable', async (status) => {
    const f = vi.fn(async () => json(status, {}));
    expect((await make(f, tokens()).resolve('x')).kind).toBe('unavailable');
  });

  it('retries once after 401 with an invalidated token', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, OK_BODY));
    const t = tokens();
    expect((await make(f, t).resolve('x')).kind).toBe('found');
    expect(t.invalidate).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('returns unavailable after two 401s', async () => {
    const f = vi.fn(async () => json(401, {}));
    expect((await make(f, tokens()).resolve('x')).kind).toBe('unavailable');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('maps a TimeoutError to unavailable', async () => {
    const f = vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect((await make(f, tokens()).resolve('x')).kind).toBe('unavailable');
  });

  it('maps a malformed 200 body to unavailable', async () => {
    const f = vi.fn(async () => json(200, { label: 'x' }));
    expect((await make(f, tokens()).resolve('x')).kind).toBe('unavailable');
  });

  it('maps a throwing token source to unavailable without calling Signals', async () => {
    const f = vi.fn();
    const t: TokenSource = {
      getToken: vi.fn(async () => {
        throw new Error('kc down');
      }),
      invalidate: vi.fn(),
    };
    expect((await make(f, t).resolve('x')).kind).toBe('unavailable');
    expect(f).not.toHaveBeenCalled();
  });

  it('never puts the address in the unavailable reason', async () => {
    const f = vi.fn(async () => json(503, {}));
    const r = await make(f, tokens()).resolve('12 Secret Street');
    expect(JSON.stringify(r)).not.toContain('Secret');
  });
});
