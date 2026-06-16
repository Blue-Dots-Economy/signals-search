# Signals Search — Plan 2: Query API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the synchronous, Beckn-aligned `POST /v1/search` API for `signals-search` — authenticated, interaction-matrix-scoped, filter-then-rank over `item_search` (vector + geo + structured filters), with an optional cross-encoder rerank and a short-TTL Redis result cache.

**Architecture:** Fastify API process in the same repo as the Plan 1 worker. Reuses Plan 1 building blocks (config, `OpenAiCompatibleEmbedder`, `item_search`, `resolveVectorizeFields`). Adds: a Beckn envelope (`context`/`message`), API-key auth against the shared Signals `apikey` table, a `network.json` loader exposing the **interaction matrix** + per-type vectorize fields, a filter-then-rank query builder (pgvector `<=>` + PostGIS `ST_DWithin`), an optional TEI `/rerank` stage, and Redis result caching. **Depends on Plan 1 being implemented.**

**Tech Stack:** Fastify 5 + `fastify-type-provider-zod`, Zod, Drizzle/`postgres`, `ioredis`, Vitest + Testcontainers.

**Master tracker:** Blue-Dots-Economy/Signals-DPG#171 · **Build:** Blue-Dots-Economy/signals-search#1 · **Spec §D6/§7/§7a:** https://github.com/Blue-Dots-Economy/signals-search/blob/feat/search-engine-v1/docs/2026-06-09-signals-search-engine-design.md

**Contracts (must match the spec):**
- Request: `context{ version, messageId, timestamp, networkId, domain, itemType }` + `message{ intent{ textSearch?, item?{id}, spatial?[], filters?[] }, pagination?{limit,offset} }`.
- Response: same `context` echoed + `message{ items[], meta{total,limit,offset} }`.
- Auth: `x-api-key`, validated against the Signals `apikey` table — hash = **unpadded base64url(sha256(rawKey))** (matches better-auth + the provision SQL).
- Interaction matrix source: `network.json` top-level `actions[*].interactions[*]` `{from_network, from_domain, to_network, to_domain}`.

---

### Task 1: Config additions + Fastify API scaffold

**Files:**
- Modify: `package.json` (add fastify deps)
- Modify: `src/config.ts` (add `api`, `networkConfigPath`, `rerank`, `cache`)
- Create: `src/api/server.ts`
- Create: `src/api/main.ts`
- Test: `src/api/server.test.ts`

- [ ] **Step 1: Add deps** to `package.json` `dependencies` and a script:

```json
    "fastify": "^5.1.0",
    "fastify-type-provider-zod": "^4.0.0"
```
Add to `scripts`: `"api": "node dist/api/main.js"`. Then `pnpm install`.

- [ ] **Step 2: Extend config** — add fields to the `Config` type and `EnvSchema`/return in `src/config.ts`:

```typescript
// add to EnvSchema:
  API_PORT: z.coerce.number().int().positive().default(3100),
  NETWORK_CONFIG_PATH: z.string().min(1), // file or directory of network.json(s)
  RERANK_BASE_URL: z.string().url().optional(),
  RERANK_MODEL: z.string().default('BAAI/bge-reranker-v2-m3'),
  RERANK_DEFAULT: z.coerce.boolean().default(false),
  RESULT_TOPN: z.coerce.number().int().positive().default(50),
  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(45),
```

```typescript
// add to Config type:
  api: { port: number };
  networkConfigPath: string;
  rerank: { baseUrl?: string; model: string; defaultOn: boolean; topN: number };
  cache: { ttlSeconds: number };
```

```typescript
// add to the returned object in loadConfig:
    api: { port: e.API_PORT },
    networkConfigPath: e.NETWORK_CONFIG_PATH,
    rerank: { baseUrl: e.RERANK_BASE_URL, model: e.RERANK_MODEL, defaultOn: e.RERANK_DEFAULT, topN: e.RESULT_TOPN },
    cache: { ttlSeconds: e.CACHE_TTL_SECONDS },
```

Also add to `.env.example`: `API_PORT=3100`, `NETWORK_CONFIG_PATH=./test/fixtures/networks`, `RERANK_BASE_URL=http://signals-search-embeddings:8081`, `RERANK_DEFAULT=false`, `RESULT_TOPN=50`, `CACHE_TTL_SECONDS=45`.

- [ ] **Step 3: Write the failing test** for the server factory + health route:

```typescript
// src/api/server.test.ts
import { describe, it, expect } from 'vitest';
import { buildServer } from './server.js';

describe('buildServer', () => {
  it('serves GET /health', async () => {
    const app = buildServer({ deps: {} as any });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run src/api/server.test.ts`
Expected: FAIL — `Cannot find module './server.js'`.

- [ ] **Step 5: Implement `server.ts`** (deps injected so handlers are testable; the `/v1/search` route is registered in Task 8):

```typescript
// src/api/server.ts
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import type { Embedder } from '../embedding/provider.js';
import type { NetworkRegistry } from '../config/network_registry.js';

export type ApiDeps = {
  sql: Sql;
  redis: Redis;
  embedder: Embedder;
  registry: NetworkRegistry;
  rerank: { baseUrl?: string; model: string; defaultOn: boolean; topN: number };
  cacheTtlSeconds: number;
  embeddingDim: number;
};

export function buildServer(opts: { deps: ApiDeps }): FastifyInstance {
  const app = Fastify({ logger: true });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.get('/health', async () => ({ status: 'ok' }));
  // registerSearchRoute(app, opts.deps)  // added in Task 8
  return app;
}
```

- [ ] **Step 6: Implement `api/main.ts`** (wiring; no unit test):

```typescript
// src/api/main.ts
import postgres from 'postgres';
import Redis from 'ioredis';
import { loadConfig } from '../config.js';
import { buildServer } from './server.js';
import { OpenAiCompatibleEmbedder } from '../embedding/provider.js';
import { loadNetworkRegistry } from '../config/network_registry.js';

async function main() {
  const cfg = loadConfig();
  const sql = postgres(cfg.databaseUrl, { max: 8 });
  const redis = new Redis(cfg.redisUrl);
  const embedder = new OpenAiCompatibleEmbedder(cfg.embedding);
  const registry = await loadNetworkRegistry(cfg.networkConfigPath);
  const app = buildServer({
    deps: { sql, redis, embedder, registry, rerank: cfg.rerank, cacheTtlSeconds: cfg.cache.ttlSeconds, embeddingDim: cfg.embedding.dim },
  });
  await app.listen({ host: '0.0.0.0', port: cfg.api.port });
}

main().catch((err) => { console.error('api crashed', err); process.exit(1); });
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run src/api/server.test.ts`
Expected: PASS. *(Will need the `network_registry` module from Task 3 to typecheck `main.ts`; if running before Task 3, the unit test for `server.ts` still passes — `main.ts` is only built later. Run `pnpm typecheck` after Task 3.)*

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml src/config.ts src/api/server.ts src/api/main.ts src/api/server.test.ts .env.example
git commit -m "feat: api scaffold (fastify) + config for query api"
```

---

### Task 2: Beckn envelope schemas

**Files:**
- Create: `src/api/schemas.ts`
- Test: `src/api/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/schemas.test.ts
import { describe, it, expect } from 'vitest';
import { SearchRequestSchema } from './schemas.js';

const valid = {
  context: { version: '1.0.0', messageId: 'm1', timestamp: '2026-06-09T12:00:00Z', networkId: 'purple_dot', domain: 'provider', itemType: 'profile_1.0' },
  message: {
    intent: {
      textSearch: 'speech therapy',
      spatial: [{ op: 's_dwithin', geometry: { type: 'Point', coordinates: [77.61, 12.91] }, distanceMeters: 5000 }],
      filters: [{ op: 'eq', target: 'item_state.provider_category', value: 'NGO / Trust' }],
    },
    pagination: { limit: 20, offset: 0 },
  },
};

describe('SearchRequestSchema', () => {
  it('accepts a full valid request', () => {
    expect(() => SearchRequestSchema.parse(valid)).not.toThrow();
  });
  it('defaults pagination to limit 20 / offset 0', () => {
    const p = SearchRequestSchema.parse({ context: valid.context, message: { intent: { textSearch: 'x' } } });
    expect(p.message.pagination).toEqual({ limit: 20, offset: 0 });
  });
  it('rejects missing networkId', () => {
    const bad = { ...valid, context: { ...valid.context, networkId: undefined } };
    expect(() => SearchRequestSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/api/schemas.test.ts`
Expected: FAIL — `Cannot find module './schemas.js'`.

- [ ] **Step 3: Implement schemas**

```typescript
// src/api/schemas.ts
import { z } from 'zod';

export const ContextSchema = z.object({
  version: z.string().default('1.0.0'),
  messageId: z.string().min(1),
  timestamp: z.string().optional(),
  networkId: z.string().min(1),
  domain: z.string().min(1),
  itemType: z.string().min(1),
});

const SpatialClauseSchema = z.object({
  op: z.literal('s_dwithin'),
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) }),
  distanceMeters: z.number().positive(),
});

const FilterClauseSchema = z.object({
  op: z.enum(['eq', 'neq', 'in', 'contains', 'gt', 'gte', 'lt', 'lte']),
  target: z.string().regex(/^item_state\.[A-Za-z0-9_]+$/, 'target must be item_state.<field>'),
  value: z.unknown(),
});

export const IntentSchema = z.object({
  textSearch: z.string().min(1).optional(),
  item: z.object({ id: z.string().uuid() }).optional(),
  spatial: z.array(SpatialClauseSchema).optional(),
  filters: z.array(FilterClauseSchema).optional(),
});

export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
}).default({ limit: 20, offset: 0 });

export const SearchRequestSchema = z.object({
  context: ContextSchema,
  message: z.object({ intent: IntentSchema, pagination: PaginationSchema }),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const ItemResultSchema = z.object({
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  item_id: z.string(),
  item_state: z.record(z.string(), z.unknown()),
  item_locations: z.array(z.object({ lat: z.number(), lng: z.number(), label: z.string().optional() })),
  score: z.number().optional(),
  distanceMeters: z.number().optional(),
});

export const SearchResponseSchema = z.object({
  context: ContextSchema,
  message: z.object({
    items: z.array(ItemResultSchema),
    meta: z.object({ total: z.number(), limit: z.number(), offset: z.number() }),
  }),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/api/schemas.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/schemas.ts src/api/schemas.test.ts
git commit -m "feat: beckn-aligned search request/response schemas"
```

---

### Task 3: Network registry (item schema + vectorize fields + interaction matrix)

**Files:**
- Create: `test/fixtures/networks/purple_dot.json` (minimal real-shape fixture)
- Create: `src/config/network_registry.ts`
- Test: `src/config/network_registry.test.ts`

- [ ] **Step 1: Create the fixture** (mirrors the real `network.json` shape: `domains[].item_schemas` + top-level `actions[].interactions[]`)

```json
// test/fixtures/networks/purple_dot.json
{
  "id": "purple_dot",
  "display_name": "Purple Dot",
  "domains": [
    {
      "id": "seeker",
      "item_schemas": { "profile_1.0": { "properties": { "needs": { "type": "string", "vectorize": true } } } }
    },
    {
      "id": "provider",
      "item_schemas": {
        "profile_1.0": {
          "properties": {
            "service_details": { "type": "string", "vectorize": true, "vector_weight": 2 },
            "services_offered": { "type": "array", "vectorize": true },
            "provider_category": { "type": "string" },
            "contact_phone": { "type": "string", "private": true }
          }
        }
      }
    }
  ],
  "actions": {
    "apply": {
      "interactions": [
        { "from_network": "purple_dot", "from_domain": "seeker", "to_network": "purple_dot", "to_domain": "provider" }
      ]
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/config/network_registry.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { loadNetworkRegistry, type NetworkRegistry } from './network_registry.js';

let reg: NetworkRegistry;
beforeAll(async () => { reg = await loadNetworkRegistry('test/fixtures/networks'); });

describe('NetworkRegistry', () => {
  it('resolves vectorize fields for a type (public only, weighted)', () => {
    const fields = reg.vectorizeFields('purple_dot', 'provider', 'profile_1.0');
    expect(fields).toEqual([
      { path: 'service_details', weight: 2 },
      { path: 'services_offered', weight: 1 },
    ]);
  });

  it('allows seeker -> provider per the actions matrix', () => {
    expect(reg.isInteractionAllowed('purple_dot', 'seeker', 'provider')).toBe(true);
  });

  it('denies provider -> seeker (no such interaction)', () => {
    expect(reg.isInteractionAllowed('purple_dot', 'provider', 'seeker')).toBe(false);
  });

  it('knows whether a domain is served', () => {
    expect(reg.hasDomain('purple_dot', 'provider')).toBe(true);
    expect(reg.hasDomain('purple_dot', 'ghost')).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/config/network_registry.test.ts`
Expected: FAIL — `Cannot find module './network_registry.js'`.

- [ ] **Step 4: Implement the registry** (reuses Plan 1's `resolveVectorizeFields`)

```typescript
// src/config/network_registry.ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveVectorizeFields, type VectorizeField, type ItemSchema } from './vectorize_fields.js';

type Interaction = { from_network: string; from_domain: string; to_network: string; to_domain: string };
type Domain = { id: string; item_schemas?: Record<string, ItemSchema> };
type NetworkConfig = { id: string; domains?: Domain[]; actions?: Record<string, { interactions?: Interaction[] }> };

export type NetworkRegistry = {
  hasDomain(network: string, domain: string): boolean;
  itemSchema(network: string, domain: string, type: string): ItemSchema | undefined;
  vectorizeFields(network: string, domain: string, type: string): VectorizeField[];
  isInteractionAllowed(network: string, fromDomain: string, toDomain: string): boolean;
};

async function readConfigs(path: string): Promise<NetworkConfig[]> {
  const s = await stat(path);
  const files = s.isDirectory()
    ? (await readdir(path)).filter((f) => f.endsWith('.json')).map((f) => join(path, f))
    : [path];
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(f, 'utf8')) as NetworkConfig));
}

export async function loadNetworkRegistry(path: string): Promise<NetworkRegistry> {
  const configs = await readConfigs(path);
  const byId = new Map<string, NetworkConfig>(configs.map((c) => [c.id, c]));

  const domain = (n: string, d: string): Domain | undefined =>
    byId.get(n)?.domains?.find((x) => x.id === d);

  return {
    hasDomain: (n, d) => Boolean(domain(n, d)),
    itemSchema: (n, d, t) => domain(n, d)?.item_schemas?.[t],
    vectorizeFields(n, d, t) {
      const schema = domain(n, d)?.item_schemas?.[t];
      return schema ? resolveVectorizeFields(schema).fields : [];
    },
    isInteractionAllowed(n, from, to) {
      const actions = byId.get(n)?.actions ?? {};
      for (const a of Object.values(actions)) {
        for (const it of a.interactions ?? []) {
          if (it.from_network === n && it.to_network === n && it.from_domain === from && it.to_domain === to) return true;
        }
      }
      return false;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/config/network_registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/networks/purple_dot.json src/config/network_registry.ts src/config/network_registry.test.ts
git commit -m "feat: network registry (vectorize fields + interaction matrix)"
```

---

### Task 4: API-key authentication

**Files:**
- Create: `src/api/auth.ts`
- Test: `src/api/auth.test.ts`

- [ ] **Step 1: Write the failing test** (seeds a `user`/`apikey` row in a testcontainer)

```typescript
// src/api/auth.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { authenticateApiKey } from './auth.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
const RAW = 'sk_signals_test_key_abcdefghijklmnopqrstuvwxyz';
const hash = createHash('sha256').update(RAW).digest('base64url');

beforeAll(async () => {
  pg = await startPostgres();
  sql = sqlClient(pg.getConnectionUri());
  // Minimal better-auth apikey table (subset used by auth).
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, user_id text, enabled boolean NOT NULL DEFAULT true)`;
  await sql`INSERT INTO "apikey" (id, key, user_id, enabled) VALUES ('k1', ${hash}, 'usr_1', true)`;
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('authenticateApiKey', () => {
  it('returns the caller for a valid enabled key', async () => {
    const caller = await authenticateApiKey(sql, RAW);
    expect(caller).toEqual({ userId: 'usr_1' });
  });
  it('returns null for an unknown key', async () => {
    expect(await authenticateApiKey(sql, 'nope')).toBeNull();
  });
  it('returns null for a disabled key', async () => {
    await sql`UPDATE "apikey" SET enabled = false WHERE id = 'k1'`;
    expect(await authenticateApiKey(sql, RAW)).toBeNull();
    await sql`UPDATE "apikey" SET enabled = true WHERE id = 'k1'`;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/api/auth.test.ts`
Expected: FAIL — `Cannot find module './auth.js'`.

- [ ] **Step 3: Implement auth** (hash matches better-auth/provision SQL: unpadded base64url(sha256))

```typescript
// src/api/auth.ts
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';

export type Caller = { userId: string };

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('base64url');
}

export async function authenticateApiKey(sql: Sql, rawKey: string | undefined): Promise<Caller | null> {
  if (!rawKey) return null;
  const hashed = hashApiKey(rawKey);
  const rows = await sql<{ user_id: string | null }[]>`
    SELECT user_id FROM "apikey" WHERE key = ${hashed} AND enabled = true LIMIT 1`;
  if (rows.length === 0 || !rows[0].user_id) return null;
  return { userId: rows[0].user_id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/api/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/auth.ts src/api/auth.test.ts
git commit -m "feat: api-key auth against signals apikey table"
```

---

### Task 5: Search query builder (filter-then-rank)

**Files:**
- Create: `src/db/search_query.ts`
- Test: `src/db/search_query.test.ts`

- [ ] **Step 1: Write the failing test** (seed `items` + `item_search`; assert vector ordering, geo filter, structured filter)

```typescript
// src/db/search_query.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from './migrate.js';
import { ItemSearchRepo } from './item_search_repo.js';
import { searchItems } from './search_query.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
const N = 1024;
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0' };
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
function vec(first: number) { const v = Array.from({ length: N }, () => 0); v[0] = first; v[1] = 1 - first; return v; }

beforeAll(async () => {
  pg = await startPostgres();
  const url = pg.getConnectionUri();
  await runMigrations(url);
  sql = sqlClient(url);
  await sql`CREATE TABLE items (
    item_network text, item_domain text, item_type text, item_id uuid,
    item_state jsonb NOT NULL DEFAULT '{}', item_locations jsonb NOT NULL DEFAULT '[]',
    lifecycle_status text NOT NULL DEFAULT 'live',
    PRIMARY KEY (item_network, item_domain, item_type, item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations,lifecycle_status) VALUES
    (${base.item_network},${base.item_domain},${base.item_type},${A},'{"provider_category":"NGO / Trust"}','[{"lat":12.93,"lng":77.62}]','live'),
    (${base.item_network},${base.item_domain},${base.item_type},${B},'{"provider_category":"Private"}','[{"lat":19.07,"lng":72.87}]','live')`;
  const repo = new ItemSearchRepo(sql, N);
  await repo.upsert({ ...base, item_id: A, embedding: vec(1), locations: [{ lat: 12.93, lng: 77.62 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'a' });
  await repo.upsert({ ...base, item_id: B, embedding: vec(0), locations: [{ lat: 19.07, lng: 72.87 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'b' });
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('searchItems', () => {
  it('ranks by cosine similarity to the query vector', async () => {
    const { rows } = await searchItems(sql, { ...base, queryVector: vec(1), filters: [], limit: 10, offset: 0 });
    expect(rows[0].item_id).toBe(A);
    expect(rows[0].score).toBeGreaterThan(rows[1].score!);
  });

  it('applies a structured eq filter on item_state', async () => {
    const { rows, total } = await searchItems(sql, {
      ...base, queryVector: vec(1), limit: 10, offset: 0,
      filters: [{ op: 'eq', target: 'item_state.provider_category', value: 'NGO / Trust' }],
    });
    expect(total).toBe(1);
    expect(rows.map((r) => r.item_id)).toEqual([A]);
  });

  it('applies a geo s_dwithin filter (only nearby item)', async () => {
    const { rows } = await searchItems(sql, {
      ...base, queryVector: vec(1), filters: [], limit: 10, offset: 0,
      spatial: { lat: 12.93, lng: 77.62, distanceMeters: 5000 },
    });
    expect(rows.map((r) => r.item_id)).toEqual([A]);
    expect(rows[0].distanceMeters).toBeLessThan(5000);
  });

  it('ranks by distance when no query vector', async () => {
    const { rows } = await searchItems(sql, { ...base, filters: [], limit: 10, offset: 0, spatial: { lat: 12.93, lng: 77.62, distanceMeters: 5_000_000 } });
    expect(rows[0].item_id).toBe(A);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/db/search_query.test.ts`
Expected: FAIL — `Cannot find module './search_query.js'`.

- [ ] **Step 3: Implement the query builder** (parameterized; field key bound to `->>`, never interpolated)

```typescript
// src/db/search_query.ts
import type { Sql, PendingQuery, Row } from 'postgres';

export type FilterClause = { op: 'eq' | 'neq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'; target: string; value: unknown };
export type SearchParams = {
  item_network: string;
  item_domain: string;
  item_type: string;
  queryVector?: number[];
  spatial?: { lat: number; lng: number; distanceMeters: number };
  filters: FilterClause[];
  limit: number;
  offset: number;
};
export type SearchRow = {
  item_network: string; item_domain: string; item_type: string; item_id: string;
  item_state: Record<string, unknown>; item_locations: { lat: number; lng: number; label?: string }[];
  score?: number; distanceMeters?: number;
};

function fieldKey(target: string): string {
  return target.slice('item_state.'.length); // schema-validated as item_state.<field>
}

function filterFragment(sql: Sql, f: FilterClause): PendingQuery<Row[]> {
  const key = fieldKey(f.target);
  switch (f.op) {
    case 'eq':  return sql`(i.item_state->>${key}) = ${String(f.value)}`;
    case 'neq': return sql`(i.item_state->>${key}) IS DISTINCT FROM ${String(f.value)}`;
    case 'in':  return sql`(i.item_state->>${key}) = ANY(${(f.value as unknown[]).map(String)})`;
    case 'gt':  return sql`(i.item_state->>${key})::numeric >  ${Number(f.value)}`;
    case 'gte': return sql`(i.item_state->>${key})::numeric >= ${Number(f.value)}`;
    case 'lt':  return sql`(i.item_state->>${key})::numeric <  ${Number(f.value)}`;
    case 'lte': return sql`(i.item_state->>${key})::numeric <= ${Number(f.value)}`;
    case 'contains': {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      return sql`(i.item_state->${key}) @> ${JSON.stringify(arr)}::jsonb`;
    }
  }
}

export async function searchItems(sql: Sql, p: SearchParams): Promise<{ rows: SearchRow[]; total: number }> {
  const vecLiteral = p.queryVector ? `[${p.queryVector.join(',')}]` : null;
  const conds: PendingQuery<Row[]>[] = [
    sql`i.lifecycle_status = 'live'`,
    sql`s.item_network = ${p.item_network} AND s.item_domain = ${p.item_domain} AND s.item_type = ${p.item_type}`,
  ];
  for (const f of p.filters) conds.push(filterFragment(sql, f));
  if (p.spatial) {
    conds.push(sql`ST_DWithin(s.geo, ST_SetSRID(ST_MakePoint(${p.spatial.lng}, ${p.spatial.lat}), 4326)::geography, ${p.spatial.distanceMeters})`);
  }
  const where = conds.reduce((acc, c, i) => (i === 0 ? sql`${c}` : sql`${acc} AND ${c}`));

  const distanceSel = p.spatial
    ? sql`ST_Distance(s.geo, ST_SetSRID(ST_MakePoint(${p.spatial.lng}, ${p.spatial.lat}), 4326)::geography)::float8`
    : sql`NULL::float8`;
  const scoreSel = vecLiteral ? sql`(1 - (s.embedding <=> ${vecLiteral}::vector))::float8` : sql`NULL::float8`;
  const orderBy = vecLiteral ? sql`s.embedding <=> ${vecLiteral}::vector ASC` : (p.spatial ? sql`distance_meters ASC NULLS LAST` : sql`s.indexed_at DESC`);

  const rows = await sql<SearchRow[]>`
    SELECT s.item_network, s.item_domain, s.item_type, s.item_id,
           i.item_state, i.item_locations,
           ${scoreSel} AS score,
           ${distanceSel} AS "distanceMeters"
    FROM item_search s
    JOIN items i USING (item_network, item_domain, item_type, item_id)
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${p.limit} OFFSET ${p.offset}`;

  const [{ total }] = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total
    FROM item_search s JOIN items i USING (item_network, item_domain, item_type, item_id)
    WHERE ${where}`;

  return { rows, total };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/db/search_query.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/search_query.ts src/db/search_query.test.ts
git commit -m "feat: filter-then-rank search query (vector + geo + structured)"
```

---

### Task 6: Cross-encoder rerank client

**Files:**
- Create: `src/rerank/reranker.ts`
- Test: `src/rerank/reranker.test.ts`

- [ ] **Step 1: Write the failing test** (stub TEI `/rerank` returning scores by index)

```typescript
// src/rerank/reranker.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { TeiReranker } from './reranker.js';

let server: Server; let baseUrl: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      // TEI /rerank returns [{index, score}] — score the LAST text highest.
      const out = body.texts.map((_: string, i: number) => ({ index: i, score: i }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('TeiReranker', () => {
  it('reorders documents by reranker score (desc)', async () => {
    const rr = new TeiReranker({ baseUrl, model: 'BAAI/bge-reranker-v2-m3' });
    const order = await rr.rerank('query', ['doc0', 'doc1', 'doc2']);
    expect(order).toEqual([2, 1, 0]); // index 2 scored highest
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/rerank/reranker.test.ts`
Expected: FAIL — `Cannot find module './reranker.js'`.

- [ ] **Step 3: Implement the reranker**

```typescript
// src/rerank/reranker.ts
export type RerankerOptions = { baseUrl: string; model: string; apiKey?: string };

export interface Reranker {
  /** Returns document indices ordered best-first. */
  rerank(query: string, texts: string[]): Promise<number[]>;
}

export class TeiReranker implements Reranker {
  constructor(private readonly opts: RerankerOptions) {}

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/rerank/reranker.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/rerank/reranker.ts src/rerank/reranker.test.ts
git commit -m "feat: TEI cross-encoder reranker client"
```

---

### Task 7: Redis result cache

**Files:**
- Create: `src/api/result_cache.ts`
- Test: `src/api/result_cache.test.ts`

- [ ] **Step 1: Write the failing test** (Redis testcontainer)

```typescript
// src/api/result_cache.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { cacheKey, getCached, setCached } from './result_cache.js';

let c: StartedTestContainer; let redis: Redis;
beforeAll(async () => { c = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(); redis = new Redis(c.getMappedPort(6379), c.getHost()); });
afterAll(async () => { redis?.disconnect(); await c?.stop(); });

describe('result cache', () => {
  it('is deterministic regardless of key ordering in the request', () => {
    const k1 = cacheKey({ a: 1, b: 2 });
    const k2 = cacheKey({ b: 2, a: 1 });
    expect(k1).toBe(k2);
  });
  it('round-trips a value with TTL', async () => {
    const key = cacheKey({ q: 'x' });
    await setCached(redis, key, { items: [1] }, 60);
    expect(await getCached<{ items: number[] }>(redis, key)).toEqual({ items: [1] });
    expect(await redis.ttl(`search:${key}`)).toBeGreaterThan(0);
  });
  it('returns null on miss', async () => {
    expect(await getCached(redis, cacheKey({ q: 'absent' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/api/result_cache.test.ts`
Expected: FAIL — `Cannot find module './result_cache.js'`.

- [ ] **Step 3: Implement the cache**

```typescript
// src/api/result_cache.ts
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function cacheKey(normalizedRequest: unknown): string {
  return createHash('sha256').update(stableStringify(normalizedRequest)).digest('hex');
}

export async function getCached<T>(redis: Redis, key: string): Promise<T | null> {
  const raw = await redis.get(`search:${key}`);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function setCached(redis: Redis, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  await redis.set(`search:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/api/result_cache.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/result_cache.ts src/api/result_cache.test.ts
git commit -m "feat: redis result cache with stable request key"
```

---

### Task 8: `/v1/search` route handler (compose)

**Files:**
- Create: `src/api/search_route.ts`
- Modify: `src/api/server.ts` (register the route)
- Test: `src/api/search_route.test.ts`

- [ ] **Step 1: Write the failing test** (full app via `inject`; seeded PG; fake embedder; auth seeded)

```typescript
// src/api/search_route.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { loadNetworkRegistry } from '../config/network_registry.js';
import { buildServer } from './server.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';
import type { FastifyInstance } from 'fastify';

let pg: StartedPostgreSqlContainer; let sql: Sql; let app: FastifyInstance;
const N = 1024;
const RAW = 'sk_signals_route_test_key_abcdefghijklmnop';
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0' };
const A = '11111111-1111-1111-1111-111111111111';
const fakeEmbedder = { embed: async (t: string[]) => t.map(() => { const v = Array.from({ length: N }, () => 0); v[0] = 1; return v; }) };
const noRedis = { get: async () => null, set: async () => 'OK' } as any;

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri(); await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE items (item_network text,item_domain text,item_type text,item_id uuid,item_state jsonb NOT NULL DEFAULT '{}',item_locations jsonb NOT NULL DEFAULT '[]',lifecycle_status text NOT NULL DEFAULT 'live',PRIMARY KEY (item_network,item_domain,item_type,item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations) VALUES (${base.item_network},${base.item_domain},${base.item_type},${A},'{"provider_category":"NGO / Trust","service_details":"speech therapy"}','[{"lat":12.93,"lng":77.62}]')`;
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, user_id text, enabled boolean NOT NULL DEFAULT true)`;
  await sql`INSERT INTO "apikey" (id,key,user_id,enabled) VALUES ('k1', ${createHash('sha256').update(RAW).digest('base64url')}, 'usr_1', true)`;
  const repo = new ItemSearchRepo(sql, N);
  const v = Array.from({ length: N }, () => 0); v[0] = 1;
  await repo.upsert({ ...base, item_id: A, embedding: v, locations: [{ lat: 12.93, lng: 77.62 }], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'a' });
  const registry = await loadNetworkRegistry('test/fixtures/networks');
  app = buildServer({ deps: { sql, redis: noRedis, embedder: fakeEmbedder, registry, rerank: { model: 'r', defaultOn: false, topN: 50 }, cacheTtlSeconds: 0, embeddingDim: N } });
});
afterAll(async () => { await app?.close(); await sql?.end(); await pg?.stop(); });

const body = {
  context: { version: '1.0.0', messageId: 'm1', networkId: 'purple_dot', domain: 'provider', itemType: 'profile_1.0' },
  message: { intent: { textSearch: 'speech therapy' } },
};

describe('POST /v1/search', () => {
  it('401 without an api key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', payload: body });
    expect(res.statusCode).toBe(401);
  });
  it('returns ranked items + echoed context with a valid key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-api-key': RAW }, payload: body });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.context.networkId).toBe('purple_dot');
    expect(j.message.items[0].item_id).toBe(A);
    expect(j.message.items[0].item_state.provider_category).toBe('NGO / Trust');
    expect(j.message.meta.total).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/api/search_route.test.ts`
Expected: FAIL — `Cannot find module './search_route.js'`.

- [ ] **Step 3: Implement the route**

```typescript
// src/api/search_route.ts
import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './server.js';
import { SearchRequestSchema } from './schemas.js';
import { authenticateApiKey } from './auth.js';
import { searchItems, type FilterClause } from '../db/search_query.js';
import { serializeItemText } from '../ingest/serialize.js';
import { cacheKey, getCached, setCached } from './result_cache.js';
import { TeiReranker } from '../rerank/reranker.js';

export function registerSearchRoute(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/v1/search', async (request, reply) => {
    const caller = await authenticateApiKey(deps.sql, request.headers['x-api-key'] as string | undefined);
    if (!caller) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'valid x-api-key required' });

    const parsed = SearchRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: parsed.error.message });
    const { context, message } = parsed.data;
    const { networkId, domain, itemType } = context;

    if (!deps.registry.hasDomain(networkId, domain)) {
      return reply.code(404).send({ error: 'UNSERVED_DOMAIN', message: `${networkId}/${domain} not served` });
    }

    // Interaction-matrix scope: if anchored by an item, the anchor's domain is the source.
    let queryVector: number[] | undefined;
    if (message.intent.item?.id) {
      const rows = await deps.sql<{ item_domain: string; embedding: string | null }[]>`
        SELECT item_domain, embedding::text AS embedding FROM item_search WHERE item_id = ${message.intent.item.id} LIMIT 1`;
      if (rows.length === 0 || !rows[0].embedding) {
        return reply.code(404).send({ error: 'ANCHOR_NOT_FOUND', message: 'anchor item not indexed' });
      }
      if (!deps.registry.isInteractionAllowed(networkId, rows[0].item_domain, domain)) {
        return reply.code(403).send({ error: 'INTERACTION_NOT_ALLOWED', message: `${rows[0].item_domain} → ${domain} not permitted` });
      }
      queryVector = JSON.parse(rows[0].embedding) as number[];
    } else if (message.intent.textSearch) {
      [queryVector] = await deps.embedder.embed([message.intent.textSearch]);
    }

    const spatial = message.intent.spatial?.[0];
    const normalized = { networkId, domain, itemType, intent: message.intent, pagination: message.pagination };
    const key = cacheKey(normalized);
    const cached = await getCached<unknown>(deps.redis, key);
    if (cached) return reply.code(200).send(cached);

    const topN = Math.max(message.pagination.limit, deps.rerank.topN);
    const { rows, total } = await searchItems(deps.sql, {
      item_network: networkId, item_domain: domain, item_type: itemType,
      queryVector,
      spatial: spatial ? { lat: spatial.geometry.coordinates[1], lng: spatial.geometry.coordinates[0], distanceMeters: spatial.distanceMeters } : undefined,
      filters: (message.intent.filters ?? []) as FilterClause[],
      limit: queryVector && (deps.rerank.defaultOn) ? topN : message.pagination.limit,
      offset: queryVector && (deps.rerank.defaultOn) ? 0 : message.pagination.offset,
    });

    let ordered = rows;
    if (deps.rerank.defaultOn && deps.rerank.baseUrl && message.intent.textSearch && rows.length > 1) {
      const fields = deps.registry.vectorizeFields(networkId, domain, itemType);
      const texts = rows.map((r) => serializeItemText(r.item_state, fields));
      const order = await new TeiReranker({ baseUrl: deps.rerank.baseUrl, model: deps.rerank.model })
        .rerank(message.intent.textSearch, texts);
      ordered = order.map((i) => rows[i]).slice(message.pagination.offset, message.pagination.offset + message.pagination.limit);
    }

    const response = {
      context,
      message: {
        items: ordered.map((r) => ({
          item_network: r.item_network, item_domain: r.item_domain, item_type: r.item_type, item_id: r.item_id,
          item_state: r.item_state, item_locations: r.item_locations,
          ...(r.score != null ? { score: Number(r.score.toFixed(4)) } : {}),
          ...(r.distanceMeters != null ? { distanceMeters: Math.round(r.distanceMeters) } : {}),
        })),
        meta: { total, limit: message.pagination.limit, offset: message.pagination.offset },
      },
    };
    await setCached(deps.redis, key, response, deps.cacheTtlSeconds);
    return reply.code(200).send(response);
  });
}
```

- [ ] **Step 4: Register the route** — in `src/api/server.ts`, import and call it (replace the commented line):

```typescript
import { registerSearchRoute } from './search_route.js';
// ...inside buildServer, before `return app;`:
  registerSearchRoute(app, opts.deps);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/api/search_route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/api/search_route.ts src/api/server.ts src/api/search_route.test.ts
git commit -m "feat: POST /v1/search (auth, interaction scope, filter-then-rank, rerank, cache)"
```

---

### Task 9: Wire the network registry into the worker (remove the Plan 1 stub)

**Files:**
- Modify: `src/worker/main.ts` (replace `makeFieldsFor` stub with the real registry)

- [ ] **Step 1: Replace the stub** — in `src/worker/main.ts`, delete the placeholder `makeFieldsFor()` and load the registry instead:

```typescript
import { loadNetworkRegistry } from '../config/network_registry.js';
// ...inside main(), after cfg is loaded:
  const registry = await loadNetworkRegistry(cfg.networkConfigPath);
  const fieldsFor = (n: string, d: string, t: string) => registry.vectorizeFields(n, d, t);
```

(Remove the old `makeFieldsFor` function and the `resolveVectorizeFields` import if now unused.)

- [ ] **Step 2: Typecheck + full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: typecheck clean; all Plan 1 + Plan 2 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/worker/main.ts
git commit -m "feat: worker uses real network registry for vectorize fields"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage (Plan 2 portion):** Beckn `context`/`message` envelope ✓ (Task 2); API-key auth vs Signals `apikey` hash ✓ (Task 4); interaction-matrix scope from `actions[*].interactions[*]` + served-domain check ✓ (Tasks 3, 8); `item.id` stored-vector fast path + `textSearch` runtime embed ✓ (Task 8); filter-then-rank (live-only, structured filters, `ST_DWithin`, cosine `<=>`) ✓ (Task 5); optional cross-encoder rerank via TEI ✓ (Tasks 6, 8); short-TTL Redis result cache ✓ (Tasks 7, 8); masked `item_state` returned via the `items` join ✓ (Task 5/8); response echoes `context` + `items` + `meta` ✓ (Task 8). Resolves the Plan 1 `makeFieldsFor` seam ✓ (Task 9).
- **Type consistency:** `Embedder`, `ItemSearchRepo`, `serializeItemText`, `resolveVectorizeFields`/`VectorizeField` are reused from Plan 1 unchanged; new types `SearchParams`/`SearchRow`/`FilterClause`, `NetworkRegistry`, `Caller`, `Reranker` are used consistently across Tasks 3–8.
- **Security:** SQL filter field keys are bound to the `->>`/`->` operators as parameters (never string-interpolated), and `target` is schema-restricted to `item_state.<field>`; only live items are returned; `item_state` is the masked public state from `items`; no anonymous access (401).
- **Interaction-matrix rule (made explicit):** when `intent.item.id` is present, the anchor item's domain is the source and `source → target` must be an allowed interaction (403 otherwise); for `textSearch`/geo-only requests with no anchor, the check is the served-domain existence (404 otherwise). This is faithful to the spec without inventing a new `context.sourceDomain` field; if product wants strict cross-domain scoping for free-text too, add an explicit source to the envelope and update the spec.
- **Rerank wiring:** off by default (`RERANK_DEFAULT=false`); when on and `RERANK_BASE_URL` set and a `textSearch` is present, stage-1 fetches `max(limit, topN)` candidates, reranks, then paginates. The `item.id`-only path skips rerank.
- **Known adjust-on-the-ground:** Task 8 reads the stored anchor vector via `embedding::text` then `JSON.parse` (pgvector renders `[..]`, JSON-parseable); confirm the postgres.js return shape during implementation. The `noRedis` stub in the route test exercises the cache-miss path; the real Redis path is covered in Task 7.
