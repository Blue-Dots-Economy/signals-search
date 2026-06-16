export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export type EmbedderOptions = { baseUrl: string; model: string; dim: number; apiKey?: string };

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
    const res = await fetch(`${this.opts.baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.opts.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => {
      if (d.embedding.length !== this.opts.dim) {
        throw new Error(`unexpected embedding dimension ${d.embedding.length}, expected ${this.opts.dim}`);
      }
      return l2normalize(d.embedding);
    });
  }
}
