import { z } from 'zod';
import { PlacePrecisionSchema, type PlacePrecision } from '../api/schemas.js';
import type { TokenSource } from './token_source.js';

export type GeocodeResult =
  | { kind: 'found'; label: string; lat: number; lng: number; precision: PlacePrecision }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: string };

export interface Geocoder {
  resolve(address: string): Promise<GeocodeResult>;
}

const ResolveBodySchema = z.object({
  label: z.string(),
  point: z.object({ lat: z.number(), lng: z.number() }),
  precision: PlacePrecisionSchema,
});

/** Resolves a text address through Signals-DPG `POST /api/v1/geo/resolve`. */
export class SignalsGeocoder implements Geocoder {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      baseUrl: string;
      tokens: TokenSource;
      timeoutMs: number;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async resolve(address: string): Promise<GeocodeResult> {
    // One deadline covers the token fetch, the call and the 401 retry.
    const signal = AbortSignal.timeout(this.opts.timeoutMs);
    try {
      let res = await this.call(address, signal);
      if (res.status === 401) {
        this.opts.tokens.invalidate();
        res = await this.call(address, signal);
      }
      return await this.toResult(res);
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown';
      return { kind: 'unavailable', reason: `geocoder call failed (${name})` };
    }
  }

  private async call(address: string, signal: AbortSignal): Promise<Response> {
    const token = await this.opts.tokens.getToken(signal);
    return this.fetchImpl(`${this.baseUrl}/api/v1/geo/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ address }),
      signal,
    });
  }

  private async toResult(res: Response): Promise<GeocodeResult> {
    if (res.status === 422) return { kind: 'not_found' };
    if (res.status !== 200) {
      return { kind: 'unavailable', reason: `geocoder returned status ${res.status}` };
    }
    const parsed = ResolveBodySchema.safeParse(await res.json());
    if (!parsed.success) return { kind: 'unavailable', reason: 'geocoder returned a malformed body' };
    const { label, point, precision } = parsed.data;
    return { kind: 'found', label, lat: point.lat, lng: point.lng, precision };
  }
}
