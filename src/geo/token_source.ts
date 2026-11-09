export interface TokenSource {
  /** `signal` bounds only this caller's wait; a shared in-flight fetch is never aborted by it. */
  getToken(signal?: AbortSignal): Promise<string>;
  invalidate(): void;
}

const EXPIRY_MARGIN_MS = 30_000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** Keycloak client-credentials token, cached until 30 s before expiry. */
export class ClientCredentialsTokenSource implements TokenSource {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      timeoutMs: number;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async getToken(signal?: AbortSignal): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt) return this.cached.value;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return signal ? waitOrAbort(this.inflight, signal) : this.inflight;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async fetchToken(): Promise<string> {
    const res = await this.fetchImpl(this.opts.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (res.status !== 200) throw new Error(`token endpoint returned ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new Error('token endpoint response has no access_token');
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0;
    this.cached = {
      value: body.access_token,
      expiresAt: this.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS,
    };
    return body.access_token;
  }
}

/** Resolves with `p`, or rejects when `signal` fires; `p` itself keeps running for other waiters. */
function waitOrAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
