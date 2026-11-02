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

// Generic placeholder host, since deployments are per network instance.
// Hard-coded rather than env-driven so the committed spec is deterministic.
const publicBaseUrl = 'https://search.example.com';

const app = buildServer({ deps, apiReference: { enabled: true, publicBaseUrl } });
await app.ready();
const spec = app.swagger();
await writeFile(new URL('../openapi.json', import.meta.url), JSON.stringify(spec, null, 2) + '\n');
await app.close();
console.log(`openapi.json written (${Object.keys((spec as { paths: object }).paths).length} paths)`);
process.exit(0); // don't let any stray handle keep the process alive
