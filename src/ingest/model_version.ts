/**
 * Composes the `model_version` stamped on every `item_search` row.
 *
 * Why this is its own module: the string is load-bearing in two places that are
 * easy to overlook.
 *
 * 1. It is part of the ingest **content hash** (`src/ingest/index_item.ts`), so
 *    changing its value invalidates every stored hash and the reconciliation
 *    sweep re-embeds the entire corpus. That is real TEI compute, and it happens
 *    on the next deploy — not at a time of anyone's choosing.
 * 2. `POST /v1/relevance` refuses to compare two rows whose `model_version`
 *    differs (`409 RELEVANCE_NOT_COMPARABLE`, `src/db/relevance_query.ts`),
 *    because cosine similarity across embedding generations is meaningless.
 *
 * Until now the string was only `<model>@<dim>`, which left the **serving stack**
 * invisible (#102). Upgrading TEI changes the numbers it returns — 1.8.0 switched
 * the default GeLU from erf to tanh, and bge-m3 is `hidden_act: gelu` — yet the
 * hash would not change, so nothing re-embedded, old and new vectors coexisted
 * under one `model_version`, and the comparability guard could not see it.
 *
 * `servingVersion` closes that hole without forcing a re-index today: leave
 * `EMBEDDING_SERVING_VERSION` unset and the output is byte-identical to the old
 * format, so every existing hash still matches and nothing is re-embedded. Set it
 * (e.g. `tei-1.9`) as part of a deliberate TEI upgrade, and the hash change is
 * exactly the re-index that upgrade requires.
 *
 * @param model - The embedding model id, e.g. `BAAI/bge-m3`.
 * @param dim - The embedding dimension, which the `item_search` column fixes at 1024.
 * @param servingVersion - Optional serving-stack tag. Omit or leave empty for the
 *   legacy format; anything else appends `@<servingVersion>`.
 * @returns The `model_version` value to stamp on indexed rows.
 */
export function composeModelVersion(
  model: string,
  dim: number,
  servingVersion?: string,
): string {
  const base = `${model}@${dim}`;
  const tag = servingVersion?.trim();
  return tag ? `${base}@${tag}` : base;
}
