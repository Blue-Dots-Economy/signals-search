/**
 * Dumps the code-generated OpenAPI spec to ./openapi.json (committed).
 * No DB/Redis needed: ready() + swagger() only exercise route registration.
 * CI re-runs this and fails on drift — regenerate + commit when routes change.
 */
import { writeFile } from 'node:fs/promises';
import { buildServer, type ApiDeps } from '../src/api/server.js';

const deps = {
  sql: {} as ApiDeps['sql'],
  redis: {} as ApiDeps['redis'],
  embedder: { embed: async () => [] },
  registry: {} as ApiDeps['registry'],
  rerank: { model: 'r', defaultOn: false, topN: 50 },
  cacheTtlSeconds: 0,
  embeddingDim: 1024,
  defaultDistanceMeters: 30000,
} as ApiDeps;

// Public URL embedded in the published spec. Generic host by design:
// deployments are per network instance, so the published spec advertises a
// substitute-your-host URL, not one pilot's domain.
//
// Hard-coded on purpose (not env-driven): the committed openapi.json must be
// deterministic across environments — if this read from process.env, CI vs.
// local vs. any future runner could each produce a different committed spec
// depending on what happened to be set. To change the published URL: edit
// this constant, rerun `pnpm spec:dump`, and commit the result.
const publicBaseUrl = 'https://search.example.com';

const app = buildServer({ deps, apiReference: { enabled: true, publicBaseUrl } });
await app.ready();
const spec = app.swagger();
await writeFile(new URL('../openapi.json', import.meta.url), JSON.stringify(spec, null, 2) + '\n');
await app.close();
console.log(`openapi.json written (${Object.keys((spec as { paths: object }).paths).length} paths)`);
process.exit(0); // don't let any stray handle keep the process alive
