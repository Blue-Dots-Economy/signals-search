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

// Public URL embedded in the published spec. Override for other deployments.
const publicBaseUrl = process.env.PUBLIC_API_BASE_URL ?? 'http://localhost:3100';

const app = buildServer({ deps, apiReference: { enabled: true, publicBaseUrl } });
await app.ready();
const spec = app.swagger();
await writeFile(new URL('../openapi.json', import.meta.url), JSON.stringify(spec, null, 2) + '\n');
await app.close();
console.log(`openapi.json written (${Object.keys((spec as { paths: object }).paths).length} paths)`);
process.exit(0); // don't let any stray handle keep the process alive
