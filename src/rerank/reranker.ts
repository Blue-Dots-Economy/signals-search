export type RerankerOptions = { baseUrl: string; model: string; apiKey?: string };

export class TeiReranker {
  constructor(private readonly opts: RerankerOptions) {}

  /** Returns document indices ordered best-first. */
  async rerank(query: string, texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers['authorization'] = `Bearer ${this.opts.apiKey}`;
    const res = await fetch(`${this.opts.baseUrl}/rerank`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, texts, model: this.opts.model }),
    });
    if (!res.ok) throw new Error(`rerank failed: ${res.status} ${await res.text()}`);
    const scored = (await res.json()) as { index: number; score: number }[];
    return [...scored].sort((a, b) => b.score - a.score).map((s) => s.index);
  }
}
