export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export type EmbedderOptions = {
  baseUrl: string;
  model: string;
  dim: number;
  apiKey?: string;
  timeoutMs?: number;   // default 5000
  maxRetries?: number;  // default 2 (total attempts = maxRetries + 1)
};

function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

export class OpenAiCompatibleEmbedder implements Embedder {
  constructor(private readonly opts: EmbedderOptions) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers['authorization'] = `Bearer ${this.opts.apiKey}`;
    const timeoutMs = this.opts.timeoutMs ?? 5000;
    const maxRetries = this.opts.maxRetries ?? 2;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`embedding request timeout after ${timeoutMs}ms`)), timeoutMs);
      try {
        const res = await fetch(`${this.opts.baseUrl}/embeddings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: this.opts.model, input: texts }),
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
        const json = (await res.json()) as { data: { embedding: number[] }[] };
        return json.data.map((d) => {
          if (d.embedding.length !== this.opts.dim) {
            throw new Error(`unexpected embedding dimension ${d.embedding.length}, expected ${this.opts.dim}`);
          }
          return l2normalize(d.embedding);
        });
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
