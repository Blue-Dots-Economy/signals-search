/**
 * Composes the `model_version` stamped on every `item_search` row:
 * `<model>@<dim>`, plus `@<servingVersion>` when that is non-empty.
 *
 * The value feeds the ingest content hash (`src/ingest/index_item.ts`), so
 * changing it makes the sweep re-embed the whole corpus on the next deploy.
 * `POST /v1/relevance` also refuses to compare rows whose `model_version`
 * differs (`409 RELEVANCE_NOT_COMPARABLE`).
 *
 * The serving tag exists because a TEI upgrade can change the vectors it
 * returns (TEI 1.8.0 switched GeLU from erf to tanh) without changing model or
 * dim. Leave `EMBEDDING_SERVING_VERSION` unset to keep existing hashes; set it
 * (e.g. `tei-1.9`) only as part of a deliberate TEI upgrade, which needs that
 * re-index anyway.
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
