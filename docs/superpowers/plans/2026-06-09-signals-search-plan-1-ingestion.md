# Signals Search — Plan 1: Ingestion Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `signals-search` repo and an ingestion pipeline that turns Signals `items` into rows in an `item_search` table (embedding vector + geography), kept in sync by a backfill/reconciliation sweep and a Redis-stream consumer.

**Architecture:** TypeScript + Drizzle worker. Reads the shared Signals Postgres `items` table; writes `item_search` (pgvector `vector(1024)` + PostGIS `geography(MultiPoint)`). Embeddings come from an OpenAI-compatible HTTP endpoint (HuggingFace TEI serving BGE-M3, default). Change detection is via a Redis stream the Signals write path will publish to (Plan 3), with a `updated_at > indexed_at` sweep as backstop and initial backfill. This plan delivers ingestion only; the query API is Plan 2.

**Tech Stack:** Node ≥24, pnpm, TypeScript (ESM), Drizzle ORM + `postgres` (postgres.js), `ioredis`, Zod (config), Vitest + Testcontainers (Postgres image with pgvector + PostGIS; Redis).

**Phase-0 contracts frozen by this plan:**
- **Ingestion stream:** Redis stream `signals:item-events`; message fields `item_network, item_domain, item_type, item_id, op` (`op` ∈ `upsert|delete`), `occurred_at` (ISO). Consumer group `signals-search`.
- **`item_search` DDL** (authoritative copy lands in Signals-DPG `schema.sql` in Plan 3; this repo carries an identical dev/test migration).
- **Embedding interface:** OpenAI-compatible `POST {EMBEDDING_BASE_URL}/embeddings` `{ model, input: string[] }` → `{ data: [{ embedding: number[] }] }`.
- **Env var names:** see Task 2.

---

### Task 1: Repo scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `.env.example`
- Modify: `.gitignore` (append) — *(repo already has a Node `.gitignore`; only add if missing)*

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "signals-search",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "packageManager": "pnpm@10.0.0",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "worker": "node dist/worker/main.js"
  },
  "dependencies": {
    "drizzle-orm": "^0.36.0",
    "postgres": "^3.4.5",
    "ioredis": "^5.4.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^10.13.0",
    "@types/node": "^24.0.0",
    "testcontainers": "^10.13.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000, // testcontainers cold start
    hookTimeout: 120_000,
  },
});
```

- [ ] **Step 4: Create placeholder `src/index.ts`**

```typescript
export const SERVICE_NAME = 'signals-search';
```

- [ ] **Step 5: Create `.env.example`**

```bash
# Postgres (shared Signals DB)
DATABASE_URL=postgres://dpg:dpg@localhost:5432/dpg
# Redis (shared)
REDIS_URL=redis://localhost:6379
# Embedding (OpenAI-compatible; default = in-cluster TEI serving BGE-M3)
EMBEDDING_BASE_URL=http://tei:8080/v1
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIM=1024
EMBEDDING_API_KEY=
# Ingestion
INGEST_STREAM=signals:item-events
INGEST_CONSUMER_GROUP=signals-search
INGEST_CONSUMER_NAME=worker-1
SWEEP_INTERVAL_MS=60000
SWEEP_BATCH_SIZE=200
```

- [ ] **Step 6: Install and commit**

```bash
pnpm install
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts src/index.ts .env.example
git commit -m "chore: scaffold signals-search (ts/pnpm/vitest)"
```

---

### Task 2: Config loader

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@h:5432/db',
    REDIS_URL: 'redis://h:6379',
    EMBEDDING_BASE_URL: 'http://tei:8080/v1',
    EMBEDDING_MODEL: 'BAAI/bge-m3',
    EMBEDDING_DIM: '1024',
  };

  it('parses a valid environment with defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.databaseUrl).toBe(base.DATABASE_URL);
    expect(cfg.embedding.dim).toBe(1024);
    expect(cfg.ingest.stream).toBe('signals:item-events');
    expect(cfg.ingest.consumerGroup).toBe('signals-search');
  });

  it('rejects an embedding dimension above the HNSW limit', () => {
    expect(() => loadConfig({ ...base, EMBEDDING_DIM: '3000' })).toThrow(/2000/);
  });

  it('throws when a required var is missing', () => {
    const { DATABASE_URL, ...rest } = base;
    expect(() => loadConfig(rest as Record<string, string>)).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/config.ts
import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  EMBEDDING_BASE_URL: z.string().url(),
  EMBEDDING_MODEL: z.string().min(1),
  EMBEDDING_DIM: z.coerce.number().int().positive().max(2000), // pgvector HNSW limit
  EMBEDDING_API_KEY: z.string().optional(),
  INGEST_STREAM: z.string().default('signals:item-events'),
  INGEST_CONSUMER_GROUP: z.string().default('signals-search'),
  INGEST_CONSUMER_NAME: z.string().default('worker-1'),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SWEEP_BATCH_SIZE: z.coerce.number().int().positive().default(200),
});

export type Config = {
  databaseUrl: string;
  redisUrl: string;
  embedding: { baseUrl: string; model: string; dim: number; apiKey?: string };
  ingest: { stream: string; consumerGroup: string; consumerName: string };
  sweep: { intervalMs: number; batchSize: number };
};

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    embedding: { baseUrl: e.EMBEDDING_BASE_URL, model: e.EMBEDDING_MODEL, dim: e.EMBEDDING_DIM, apiKey: e.EMBEDDING_API_KEY },
    ingest: { stream: e.INGEST_STREAM, consumerGroup: e.INGEST_CONSUMER_GROUP, consumerName: e.INGEST_CONSUMER_NAME },
    sweep: { intervalMs: e.SWEEP_INTERVAL_MS, batchSize: e.SWEEP_BATCH_SIZE },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: config loader with zod validation"
```

---

### Task 3: Test Postgres image (pgvector + PostGIS) and Testcontainers helper

**Files:**
- Create: `test/docker/Dockerfile.postgres`
- Create: `test/support/pg.ts`

- [ ] **Step 1: Create the test Postgres image**

```dockerfile
# test/docker/Dockerfile.postgres
# Postgres 16 with BOTH PostGIS and pgvector (Debian has both packages).
FROM postgis/postgis:16-3.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector \
 && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Create the Testcontainers helper**

```typescript
// test/support/pg.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import postgres from 'postgres';

const IMAGE_TAG = 'signals-search-testpg:16-3.5-pgvector';
let built = false;

async function ensureImage() {
  if (built) return;
  await GenericContainer.fromDockerfile('test/docker', 'Dockerfile.postgres').build(IMAGE_TAG);
  built = true;
}

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  await ensureImage();
  return new PostgreSqlContainer(IMAGE_TAG)
    .withDatabase('dpg')
    .withUsername('dpg')
    .withPassword('dpg')
    .start();
}

export function sqlClient(url: string) {
  return postgres(url, { max: 4 });
}
```

- [ ] **Step 3: Sanity test that the image has both extensions**

```typescript
// test/support/pg.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { startPostgres, sqlClient } from './pg.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let pg: StartedPostgreSqlContainer;

afterAll(async () => { await pg?.stop(); });

describe('test postgres image', () => {
  it('can create vector and postgis extensions', async () => {
    pg = await startPostgres();
    const sql = sqlClient(pg.getConnectionUri());
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
    const rows = await sql<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname IN ('vector','postgis')`;
    expect(rows.map((r) => r.extname).sort()).toEqual(['postgis', 'vector']);
    await sql.end();
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/support/pg.test.ts`
Expected: PASS (Docker must be running; first run builds the image).

- [ ] **Step 5: Commit**

```bash
git add test/docker/Dockerfile.postgres test/support/pg.ts test/support/pg.test.ts
git commit -m "test: postgres testcontainer image with pgvector + postgis"
```

---

### Task 4: `item_search` migration + read-model

**Files:**
- Create: `src/db/migrations/0001_item_search.sql`
- Create: `src/db/migrate.ts`
- Test: `src/db/migrate.test.ts`

- [ ] **Step 1: Write the migration SQL**

```sql
-- src/db/migrations/0001_item_search.sql
-- NOTE: authoritative copy lives in Signals-DPG schema.sql (Plan 3); this is the dev/test mirror.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS item_search (
  item_network    text NOT NULL,
  item_domain     text NOT NULL,
  item_type       text NOT NULL,
  item_id         uuid NOT NULL,
  embedding       vector(1024),
  geo             geography(MultiPoint, 4326),
  lifecycle_status text NOT NULL DEFAULT 'draft',
  model_version   text,
  content_hash    text,
  indexed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_network, item_domain, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS item_search_embedding_hnsw
  ON item_search USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS item_search_geo_gist
  ON item_search USING gist (geo);
CREATE INDEX IF NOT EXISTS item_search_live
  ON item_search (item_network, item_domain, item_type) WHERE lifecycle_status = 'live';
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/db/migrate.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from './migrate.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let pg: StartedPostgreSqlContainer;
afterAll(async () => { await pg?.stop(); });

describe('runMigrations', () => {
  it('creates item_search with vector + geography columns', async () => {
    pg = await startPostgres();
    const url = pg.getConnectionUri();
    await runMigrations(url);
    const sql = sqlClient(url);
    const cols = await sql<{ column_name: string; udt_name: string }[]>`
      SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_name = 'item_search'`;
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.udt_name]));
    expect(byName['embedding']).toBe('vector');
    expect(byName['geo']).toBe('geography');
    await sql.end();
  });

  it('is idempotent (safe to run twice)', async () => {
    await expect(runMigrations(pg.getConnectionUri())).resolves.not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/db/migrate.test.ts`
Expected: FAIL — `Cannot find module './migrate.js'`.

- [ ] **Step 4: Write minimal implementation**

```typescript
// src/db/migrate.ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = ['0001_item_search.sql'];

export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    for (const file of MIGRATIONS) {
      const ddl = await readFile(join(here, 'migrations', file), 'utf8');
      await sql.unsafe(ddl);
    }
  } finally {
    await sql.end();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/db/migrate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/0001_item_search.sql src/db/migrate.ts src/db/migrate.test.ts
git commit -m "feat: item_search migration (pgvector + postgis) and runner"
```

---

### Task 5: Embedding provider adapter (OpenAI-compatible / TEI)

**Files:**
- Create: `src/embedding/provider.ts`
- Test: `src/embedding/provider.test.ts`

- [ ] **Step 1: Write the failing test** (uses a local stub HTTP server, no network)

```typescript
// src/embedding/provider.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { OpenAiCompatibleEmbedder } from './provider.js';

let server: Server;
let baseUrl: string;
let lastBody: any;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastBody = JSON.parse(raw);
      const input: string[] = lastBody.input;
      // Return a fixed 4-dim vector per input (un-normalized) to test normalization.
      const data = input.map(() => ({ embedding: [3, 0, 4, 0] }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('OpenAiCompatibleEmbedder', () => {
  it('posts model+input and L2-normalizes the returned vectors', async () => {
    const embedder = new OpenAiCompatibleEmbedder({ baseUrl, model: 'BAAI/bge-m3', dim: 4 });
    const [vec] = await embedder.embed(['hello']);
    expect(lastBody.model).toBe('BAAI/bge-m3');
    expect(lastBody.input).toEqual(['hello']);
    // [3,0,4,0] has L2 norm 5 → normalized [0.6,0,0.8,0]
    expect(vec[0]).toBeCloseTo(0.6, 5);
    expect(vec[2]).toBeCloseTo(0.8, 5);
  });

  it('throws when returned dimension != configured dim', async () => {
    const embedder = new OpenAiCompatibleEmbedder({ baseUrl, model: 'm', dim: 1024 });
    await expect(embedder.embed(['x'])).rejects.toThrow(/dimension/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/embedding/provider.test.ts`
Expected: FAIL — `Cannot find module './provider.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/embedding/provider.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/embedding/provider.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/embedding/provider.ts src/embedding/provider.test.ts
git commit -m "feat: OpenAI-compatible embedding adapter with L2 normalization"
```

---

### Task 6: Vectorize-config parser

**Files:**
- Create: `src/config/vectorize_fields.ts`
- Test: `src/config/vectorize_fields.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/config/vectorize_fields.test.ts
import { describe, it, expect } from 'vitest';
import { resolveVectorizeFields } from './vectorize_fields.js';

const itemSchema = {
  properties: {
    service_details: { type: 'string', vectorize: true, vector_weight: 2 },
    services_offered: { type: 'array', vectorize: true },
    provider_category: { type: 'string' }, // not vectorized
    contact_phone: { type: 'string', private: true, vectorize: true }, // illegal
  },
};

describe('resolveVectorizeFields', () => {
  it('returns vectorized public fields with weights (default 1)', () => {
    const { fields } = resolveVectorizeFields({
      properties: {
        service_details: { type: 'string', vectorize: true, vector_weight: 2 },
        services_offered: { type: 'array', vectorize: true },
        provider_category: { type: 'string' },
      },
    });
    expect(fields).toEqual([
      { path: 'service_details', weight: 2 },
      { path: 'services_offered', weight: 1 },
    ]);
  });

  it('rejects vectorize on a private property', () => {
    expect(() => resolveVectorizeFields(itemSchema)).toThrow(/private/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/config/vectorize_fields.test.ts`
Expected: FAIL — `Cannot find module './vectorize_fields.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/config/vectorize_fields.ts
export type VectorizeField = { path: string; weight: number };
export type ItemSchema = { properties?: Record<string, Record<string, unknown>> };

export function resolveVectorizeFields(schema: ItemSchema): { fields: VectorizeField[] } {
  const props = schema.properties ?? {};
  const fields: VectorizeField[] = [];
  for (const [name, prop] of Object.entries(props)) {
    if (prop.vectorize !== true) continue;
    if (prop.private === true) {
      throw new Error(`property "${name}" is marked private and cannot be vectorized (item_state holds only a mask)`);
    }
    const weight = typeof prop.vector_weight === 'number' && prop.vector_weight > 0 ? prop.vector_weight : 1;
    fields.push({ path: name, weight });
  }
  return { fields };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/config/vectorize_fields.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/vectorize_fields.ts src/config/vectorize_fields.test.ts
git commit -m "feat: vectorize-field resolver (public-only, weighted)"
```

---

### Task 7: Text serializer + content hash

**Files:**
- Create: `src/ingest/serialize.ts`
- Test: `src/ingest/serialize.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/ingest/serialize.test.ts
import { describe, it, expect } from 'vitest';
import { serializeItemText, contentHash } from './serialize.js';

const fields = [
  { path: 'service_details', weight: 2 },
  { path: 'services_offered', weight: 1 },
];

describe('serializeItemText', () => {
  it('concatenates fields, repeating by weight, arrays joined', () => {
    const text = serializeItemText(
      { service_details: 'speech therapy', services_offered: ['Assistive Devices', 'Rehab'], provider_category: 'NGO' },
      fields,
    );
    // weight 2 → "service_details: speech therapy" twice, then services_offered once
    expect(text).toBe(
      'service_details: speech therapy\nservice_details: speech therapy\nservices_offered: Assistive Devices, Rehab',
    );
  });

  it('is stable regardless of input key order', () => {
    const a = serializeItemText({ service_details: 'x', services_offered: ['y'] }, fields);
    const b = serializeItemText({ services_offered: ['y'], service_details: 'x' }, fields);
    expect(a).toBe(b);
  });
});

describe('contentHash', () => {
  it('changes when text changes and is stable otherwise', () => {
    expect(contentHash('a')).toBe(contentHash('a'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ingest/serialize.test.ts`
Expected: FAIL — `Cannot find module './serialize.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ingest/serialize.ts
import { createHash } from 'node:crypto';
import type { VectorizeField } from '../config/vectorize_fields.js';

function valueToString(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  if (v === null || v === undefined) return '';
  return String(v);
}

export function serializeItemText(state: Record<string, unknown>, fields: VectorizeField[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const value = valueToString(state[f.path]);
    if (value === '') continue;
    const line = `${f.path}: ${value}`;
    for (let i = 0; i < f.weight; i++) parts.push(line);
  }
  return parts.join('\n');
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/ingest/serialize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ingest/serialize.ts src/ingest/serialize.test.ts
git commit -m "feat: deterministic item text serializer + content hash"
```

---

### Task 8: `item_search` upsert repository

**Files:**
- Create: `src/db/item_search_repo.ts`
- Test: `src/db/item_search_repo.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/db/item_search_repo.test.ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from './migrate.js';
import { ItemSearchRepo } from './item_search_repo.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
let repo: ItemSearchRepo;

const key = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: '5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf' };

beforeAll(async () => {
  pg = await startPostgres();
  await runMigrations(pg.getConnectionUri());
  sql = sqlClient(pg.getConnectionUri());
  repo = new ItemSearchRepo(sql, 1024);
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('ItemSearchRepo.upsert', () => {
  it('writes embedding + multipoint geography and is queryable by ANN + ST_DWithin', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    await repo.upsert({
      ...key,
      embedding,
      locations: [{ lat: 12.9352, lng: 77.6245, label: 'Bengaluru' }],
      lifecycleStatus: 'live',
      modelVersion: 'BAAI/bge-m3@1024',
      contentHash: 'abc',
    });

    const ann = await sql<{ item_id: string }[]>`
      SELECT item_id FROM item_search
      ORDER BY embedding <=> ${'[' + embedding.join(',') + ']'}::vector LIMIT 1`;
    expect(ann[0].item_id).toBe(key.item_id);

    const near = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM item_search
      WHERE ST_DWithin(geo, ST_SetSRID(ST_MakePoint(77.6245, 12.9352), 4326)::geography, 1000)`;
    expect(near[0].n).toBe(1);
  });

  it('upsert updates in place (no duplicate PK)', async () => {
    const embedding = Array.from({ length: 1024 }, () => 0);
    embedding[1] = 1;
    await repo.upsert({ ...key, embedding, locations: [], lifecycleStatus: 'paused', modelVersion: 'm', contentHash: 'def' });
    const rows = await sql<{ content_hash: string }[]>`SELECT content_hash FROM item_search WHERE item_id = ${key.item_id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe('def');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/db/item_search_repo.test.ts`
Expected: FAIL — `Cannot find module './item_search_repo.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/db/item_search_repo.ts
import type { Sql } from 'postgres';

export type ItemLocation = { lat: number; lng: number; label?: string };

export type UpsertInput = {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  embedding: number[];
  locations: ItemLocation[];
  lifecycleStatus: string;
  modelVersion: string;
  contentHash: string;
};

function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

// Build a MULTIPOINT geography literal from locations (lng lat order for WKT).
function toMultipointWkt(locs: ItemLocation[]): string | null {
  if (locs.length === 0) return null;
  const pts = locs.map((l) => `${l.lng} ${l.lat}`).join(',');
  return `MULTIPOINT(${pts})`;
}

export class ItemSearchRepo {
  constructor(private readonly sql: Sql, private readonly dim: number) {}

  async upsert(input: UpsertInput): Promise<void> {
    if (input.embedding.length !== this.dim) {
      throw new Error(`embedding dim ${input.embedding.length} != ${this.dim}`);
    }
    const vec = toVectorLiteral(input.embedding);
    const wkt = toMultipointWkt(input.locations);
    await this.sql`
      INSERT INTO item_search
        (item_network, item_domain, item_type, item_id, embedding, geo, lifecycle_status, model_version, content_hash, indexed_at)
      VALUES (
        ${input.item_network}, ${input.item_domain}, ${input.item_type}, ${input.item_id},
        ${vec}::vector,
        ${wkt ? this.sql`ST_SetSRID(ST_GeomFromText(${wkt}), 4326)::geography` : this.sql`NULL`},
        ${input.lifecycleStatus}, ${input.modelVersion}, ${input.contentHash}, now()
      )
      ON CONFLICT (item_network, item_domain, item_type, item_id) DO UPDATE SET
        embedding = EXCLUDED.embedding,
        geo = EXCLUDED.geo,
        lifecycle_status = EXCLUDED.lifecycle_status,
        model_version = EXCLUDED.model_version,
        content_hash = EXCLUDED.content_hash,
        indexed_at = now()`;
  }

  async getContentHash(item_id: string): Promise<string | null> {
    const rows = await this.sql<{ content_hash: string | null }[]>`
      SELECT content_hash FROM item_search WHERE item_id = ${item_id} LIMIT 1`;
    return rows[0]?.content_hash ?? null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/db/item_search_repo.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/item_search_repo.ts src/db/item_search_repo.test.ts
git commit -m "feat: item_search upsert repository (vector + multipoint geography)"
```

---

### Task 9: Index one item (compose load → serialize → embed → upsert)

**Files:**
- Create: `src/ingest/index_item.ts`
- Test: `src/ingest/index_item.test.ts`

- [ ] **Step 1: Write the failing test** (testcontainer PG; in-memory fake embedder + fake item reader)

```typescript
// src/ingest/index_item.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { indexItem } from './index_item.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
let repo: ItemSearchRepo;

const key = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: '5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf' };
const fields = [{ path: 'service_details', weight: 1 }];
const fakeEmbedder = { embed: async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.03125)) };

beforeAll(async () => {
  pg = await startPostgres();
  await runMigrations(pg.getConnectionUri());
  sql = sqlClient(pg.getConnectionUri());
  repo = new ItemSearchRepo(sql, 1024);
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

const item = {
  ...key,
  item_state: { service_details: 'speech therapy' },
  item_locations: [{ lat: 12.93, lng: 77.62 }],
  lifecycle_status: 'live',
};

describe('indexItem', () => {
  it('embeds + upserts when content changed', async () => {
    const res = await indexItem({ item, fields, embedder: fakeEmbedder, repo, modelVersion: 'm@1024' });
    expect(res.action).toBe('indexed');
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM item_search WHERE item_id = ${key.item_id}`;
    expect(rows[0].n).toBe(1);
  });

  it('skips re-embedding when content hash unchanged', async () => {
    let calls = 0;
    const countingEmbedder = { embed: async (t: string[]) => { calls++; return t.map(() => Array.from({ length: 1024 }, () => 0.03125)); } };
    const res = await indexItem({ item, fields, embedder: countingEmbedder, repo, modelVersion: 'm@1024' });
    expect(res.action).toBe('skipped');
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ingest/index_item.test.ts`
Expected: FAIL — `Cannot find module './index_item.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ingest/index_item.ts
import type { Embedder } from '../embedding/provider.js';
import type { VectorizeField } from '../config/vectorize_fields.js';
import type { ItemSearchRepo, ItemLocation } from '../db/item_search_repo.js';
import { serializeItemText, contentHash } from './serialize.js';

export type SourceItem = {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  item_state: Record<string, unknown>;
  item_locations: ItemLocation[];
  lifecycle_status: string;
};

export type IndexResult = { action: 'indexed' | 'skipped' };

export async function indexItem(args: {
  item: SourceItem;
  fields: VectorizeField[];
  embedder: Embedder;
  repo: ItemSearchRepo;
  modelVersion: string;
}): Promise<IndexResult> {
  const { item, fields, embedder, repo, modelVersion } = args;
  const text = serializeItemText(item.item_state, fields);
  const hash = contentHash(`${modelVersion}\n${text}`);
  if ((await repo.getContentHash(item.item_id)) === hash) {
    return { action: 'skipped' };
  }
  const [embedding] = await embedder.embed([text]);
  await repo.upsert({
    item_network: item.item_network,
    item_domain: item.item_domain,
    item_type: item.item_type,
    item_id: item.item_id,
    embedding,
    locations: item.item_locations ?? [],
    lifecycleStatus: item.lifecycle_status,
    modelVersion,
    contentHash: hash,
  });
  return { action: 'indexed' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/ingest/index_item.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ingest/index_item.ts src/ingest/index_item.test.ts
git commit -m "feat: index one item (serialize → embed → upsert) with hash skip"
```

---

### Task 10: Reconciliation / backfill sweep

**Files:**
- Create: `src/ingest/sweep.ts`
- Test: `src/ingest/sweep.test.ts`

- [ ] **Step 1: Write the failing test** (seed a real `items`-like table to read from)

```typescript
// src/ingest/sweep.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { runSweep } from './sweep.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;

const fields = [{ path: 'service_details', weight: 1 }];
const fakeEmbedder = { embed: async (t: string[]) => t.map(() => Array.from({ length: 1024 }, () => 0.03125)) };

beforeAll(async () => {
  pg = await startPostgres();
  const url = pg.getConnectionUri();
  await runMigrations(url);
  sql = sqlClient(url);
  // Minimal stand-in for the Signals items table.
  await sql`CREATE TABLE items (
    item_network text, item_domain text, item_type text, item_id uuid,
    item_state jsonb NOT NULL DEFAULT '{}', item_locations jsonb NOT NULL DEFAULT '[]',
    lifecycle_status text NOT NULL DEFAULT 'live', updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (item_network, item_domain, item_type, item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state,item_locations) VALUES
    ('purple_dot','provider','profile_1.0','5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf',
     '{"service_details":"speech therapy"}','[{"lat":12.93,"lng":77.62}]')`;
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('runSweep', () => {
  it('indexes items missing from item_search', async () => {
    const repo = new ItemSearchRepo(sql, 1024);
    const n = await runSweep({ sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024', batchSize: 50 });
    expect(n).toBe(1);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM item_search`;
    expect(rows[0].n).toBe(1);
  });

  it('re-indexes items whose updated_at is newer than indexed_at', async () => {
    await sql`UPDATE items SET item_state = '{"service_details":"physiotherapy"}', updated_at = now() + interval '1 hour'`;
    const repo = new ItemSearchRepo(sql, 1024);
    const n = await runSweep({ sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024', batchSize: 50 });
    expect(n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ingest/sweep.test.ts`
Expected: FAIL — `Cannot find module './sweep.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ingest/sweep.ts
import type { Sql } from 'postgres';
import type { Embedder } from '../embedding/provider.js';
import type { ItemSearchRepo } from '../db/item_search_repo.js';
import type { VectorizeField } from '../config/vectorize_fields.js';
import { indexItem, type SourceItem } from './index_item.js';

export async function runSweep(args: {
  sql: Sql;
  repo: ItemSearchRepo;
  embedder: Embedder;
  fieldsFor: (item_network: string, item_domain: string, item_type: string) => VectorizeField[];
  modelVersion: string;
  batchSize: number;
}): Promise<number> {
  const { sql, repo, embedder, fieldsFor, modelVersion, batchSize } = args;
  // Items missing from item_search OR changed since last index.
  const rows = await sql<SourceItem[]>`
    SELECT i.item_network, i.item_domain, i.item_type, i.item_id,
           i.item_state, i.item_locations, i.lifecycle_status
    FROM items i
    LEFT JOIN item_search s USING (item_network, item_domain, item_type, item_id)
    WHERE s.item_id IS NULL OR i.updated_at > s.indexed_at
    ORDER BY i.updated_at ASC
    LIMIT ${batchSize}`;

  let count = 0;
  for (const item of rows) {
    const fields = fieldsFor(item.item_network, item.item_domain, item.item_type);
    await indexItem({ item, fields, embedder, repo, modelVersion });
    count++;
  }
  return count;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/ingest/sweep.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ingest/sweep.ts src/ingest/sweep.test.ts
git commit -m "feat: reconciliation/backfill sweep (missing or stale items)"
```

---

### Task 11: Redis stream consumer

**Files:**
- Create: `src/ingest/stream_consumer.ts`
- Test: `src/ingest/stream_consumer.test.ts`

- [ ] **Step 1: Write the failing test** (Redis testcontainer)

```typescript
// src/ingest/stream_consumer.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { ensureConsumerGroup, readBatch, ackMessages } from './stream_consumer.js';

let redisC: StartedTestContainer;
let redis: Redis;
const STREAM = 'signals:item-events';
const GROUP = 'signals-search';

beforeAll(async () => {
  redisC = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redis = new Redis(redisC.getMappedPort(6379), redisC.getHost());
});
afterAll(async () => { redis?.disconnect(); await redisC?.stop(); });

describe('stream consumer', () => {
  it('creates the group, reads a published event, and acks it', async () => {
    await ensureConsumerGroup(redis, STREAM, GROUP);
    await redis.xadd(STREAM, '*',
      'item_network', 'purple_dot', 'item_domain', 'provider',
      'item_type', 'profile_1.0', 'item_id', '5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf',
      'op', 'upsert', 'occurred_at', '2026-06-09T12:00:00Z');

    const batch = await readBatch(redis, STREAM, GROUP, 'c1', 10, 100);
    expect(batch).toHaveLength(1);
    expect(batch[0].event.item_id).toBe('5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf');
    expect(batch[0].event.op).toBe('upsert');

    await ackMessages(redis, STREAM, GROUP, batch.map((b) => b.id));
    const pending = await redis.xpending(STREAM, GROUP);
    expect((pending as any[])[0]).toBe(0); // 0 pending after ack
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ingest/stream_consumer.test.ts`
Expected: FAIL — `Cannot find module './stream_consumer.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ingest/stream_consumer.ts
import type Redis from 'ioredis';

export type ItemEvent = {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  op: 'upsert' | 'delete';
  occurred_at: string;
};

export type StreamMessage = { id: string; event: ItemEvent };

export async function ensureConsumerGroup(redis: Redis, stream: string, group: string): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }
}

function fieldsToEvent(fields: string[]): ItemEvent {
  const m: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) m[fields[i]] = fields[i + 1];
  return {
    item_network: m.item_network,
    item_domain: m.item_domain,
    item_type: m.item_type,
    item_id: m.item_id,
    op: (m.op as ItemEvent['op']) ?? 'upsert',
    occurred_at: m.occurred_at,
  };
}

export async function readBatch(
  redis: Redis, stream: string, group: string, consumer: string, count: number, blockMs: number,
): Promise<StreamMessage[]> {
  const res = (await redis.xreadgroup(
    'GROUP', group, consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', stream, '>',
  )) as [string, [string, string[]][]][] | null;
  if (!res) return [];
  const [, entries] = res[0];
  return entries.map(([id, fields]) => ({ id, event: fieldsToEvent(fields) }));
}

export async function ackMessages(redis: Redis, stream: string, group: string, ids: string[]): Promise<void> {
  if (ids.length) await redis.xack(stream, group, ...ids);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/ingest/stream_consumer.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/ingest/stream_consumer.ts src/ingest/stream_consumer.test.ts
git commit -m "feat: redis stream consumer (group, read batch, ack)"
```

---

### Task 12: Worker entrypoint (sweep on boot + consume loop)

**Files:**
- Create: `src/worker/process_event.ts`
- Create: `src/worker/main.ts`
- Test: `src/worker/process_event.test.ts`

- [ ] **Step 1: Write the failing test for `processEvent`** (testcontainer PG; fake embedder)

```typescript
// src/worker/process_event.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { processEvent } from './process_event.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
const id = '5d2bcec7-3d5c-4182-a3fc-4d4c2f10addf';
const fields = [{ path: 'service_details', weight: 1 }];
const fakeEmbedder = { embed: async (t: string[]) => t.map(() => Array.from({ length: 1024 }, () => 0.03125)) };

beforeAll(async () => {
  pg = await startPostgres();
  const url = pg.getConnectionUri();
  await runMigrations(url);
  sql = sqlClient(url);
  await sql`CREATE TABLE items (
    item_network text, item_domain text, item_type text, item_id uuid,
    item_state jsonb NOT NULL DEFAULT '{}', item_locations jsonb NOT NULL DEFAULT '[]',
    lifecycle_status text NOT NULL DEFAULT 'live', updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (item_network, item_domain, item_type, item_id))`;
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,item_state) VALUES
    ('purple_dot','provider','profile_1.0',${id},'{"service_details":"speech therapy"}')`;
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('processEvent', () => {
  it('upsert event indexes the item', async () => {
    const repo = new ItemSearchRepo(sql, 1024);
    await processEvent({
      event: { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: id, op: 'upsert', occurred_at: 'x' },
      sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024',
    });
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM item_search WHERE item_id = ${id}`;
    expect(rows[0].n).toBe(1);
  });

  it('delete event removes the item_search row', async () => {
    const repo = new ItemSearchRepo(sql, 1024);
    await processEvent({
      event: { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: id, op: 'delete', occurred_at: 'x' },
      sql, repo, embedder: fakeEmbedder, fieldsFor: () => fields, modelVersion: 'm@1024',
    });
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM item_search WHERE item_id = ${id}`;
    expect(rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/worker/process_event.test.ts`
Expected: FAIL — `Cannot find module './process_event.js'`.

- [ ] **Step 3: Write `processEvent` and a `delete` on the repo**

First add a delete method to the repo (modify `src/db/item_search_repo.ts`, add inside the class):

```typescript
  async delete(item_id: string): Promise<void> {
    await this.sql`DELETE FROM item_search WHERE item_id = ${item_id}`;
  }
```

Then create `src/worker/process_event.ts`:

```typescript
// src/worker/process_event.ts
import type { Sql } from 'postgres';
import type { Embedder } from '../embedding/provider.js';
import type { ItemSearchRepo } from '../db/item_search_repo.js';
import type { VectorizeField } from '../config/vectorize_fields.js';
import type { ItemEvent } from '../ingest/stream_consumer.js';
import { indexItem, type SourceItem } from '../ingest/index_item.js';

export async function processEvent(args: {
  event: ItemEvent;
  sql: Sql;
  repo: ItemSearchRepo;
  embedder: Embedder;
  fieldsFor: (n: string, d: string, t: string) => VectorizeField[];
  modelVersion: string;
}): Promise<void> {
  const { event, sql, repo, embedder, fieldsFor, modelVersion } = args;
  if (event.op === 'delete') {
    await repo.delete(event.item_id);
    return;
  }
  const rows = await sql<SourceItem[]>`
    SELECT item_network, item_domain, item_type, item_id, item_state, item_locations, lifecycle_status
    FROM items
    WHERE item_network = ${event.item_network} AND item_domain = ${event.item_domain}
      AND item_type = ${event.item_type} AND item_id = ${event.item_id}
    LIMIT 1`;
  if (rows.length === 0) return; // item gone; a delete event will/has handled removal
  const item = rows[0];
  const fields = fieldsFor(item.item_network, item.item_domain, item.item_type);
  await indexItem({ item, fields, embedder, repo, modelVersion });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/worker/process_event.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the worker entrypoint (no unit test; wiring only)**

```typescript
// src/worker/main.ts
import postgres from 'postgres';
import Redis from 'ioredis';
import { loadConfig } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { OpenAiCompatibleEmbedder } from '../embedding/provider.js';
import { ensureConsumerGroup, readBatch, ackMessages } from '../ingest/stream_consumer.js';
import { processEvent } from './process_event.js';
import { runSweep } from '../ingest/sweep.js';
import { resolveVectorizeFields, type VectorizeField } from '../config/vectorize_fields.js';

// NOTE: vectorize-field resolution per (network,domain,type) is wired to the network-config
// loader in Plan 2/3; for now this reads a single schema injected via env or a stub. Keep the
// fieldsFor signature stable so the loader can drop in without touching callers.
function makeFieldsFor(): (n: string, d: string, t: string) => VectorizeField[] {
  // Placeholder resolver replaced in Plan 2 by the network.json loader.
  return () => resolveVectorizeFields({ properties: {} }).fields;
}

async function main() {
  const cfg = loadConfig();
  const sql = postgres(cfg.databaseUrl, { max: 8 });
  const redis = new Redis(cfg.redisUrl);
  const repo = new ItemSearchRepo(sql, cfg.embedding.dim);
  const embedder = new OpenAiCompatibleEmbedder(cfg.embedding);
  const modelVersion = `${cfg.embedding.model}@${cfg.embedding.dim}`;
  const fieldsFor = makeFieldsFor();

  await runMigrations(cfg.databaseUrl); // dev/test convenience; prod DDL via Signals (Plan 3)
  await ensureConsumerGroup(redis, cfg.ingest.stream, cfg.ingest.consumerGroup);

  // Backfill / reconcile on boot, then on an interval as a backstop.
  const sweep = () => runSweep({ sql, repo, embedder, fieldsFor, modelVersion, batchSize: cfg.sweep.batchSize })
    .catch((err) => console.error('sweep failed', err));
  await sweep();
  setInterval(sweep, cfg.sweep.intervalMs);

  // Consume the event stream.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await readBatch(redis, cfg.ingest.stream, cfg.ingest.consumerGroup, cfg.ingest.consumerName, 50, 5000);
    for (const msg of batch) {
      try {
        await processEvent({ event: msg.event, sql, repo, embedder, fieldsFor, modelVersion });
        await ackMessages(redis, cfg.ingest.stream, cfg.ingest.consumerGroup, [msg.id]);
      } catch (err) {
        console.error('processEvent failed; leaving unacked for retry', msg.id, err);
      }
    }
  }
}

main().catch((err) => { console.error('worker crashed', err); process.exit(1); });
```

- [ ] **Step 6: Verify build + full test suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/worker/process_event.ts src/worker/process_event.test.ts src/worker/main.ts src/db/item_search_repo.ts
git commit -m "feat: worker entrypoint (boot backfill + stream consume loop)"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage (Plan 1 portion):** scaffold ✓ (Task 1), config/env ✓ (Task 2), pgvector+postgis dev DDL ✓ (Tasks 3–4), embedding adapter/OpenAI-compatible/L2-norm ✓ (Task 5), public-only vectorize markers ✓ (Task 6), serializer + content-hash skip ✓ (Tasks 7, 9), `item_search` upsert with multipoint geo + ANN ✓ (Task 8), backfill/reconciliation sweep ✓ (Task 10), Redis stream contract + consumer ✓ (Task 11), delete handling + worker wiring ✓ (Task 12). **Deferred to later plans:** query API, auth, interaction-matrix validation, rerank, Redis result cache (Plan 2); authoritative `schema.sql` + enqueue (Plan 3); deploy/TEI (Plan 4).
- **Known follow-up seam:** `makeFieldsFor()` in `src/worker/main.ts` is a stub that returns no fields; Plan 2/3 replaces it with the `network.json` loader (`resolveVectorizeFields` per network/domain/type). The `fieldsFor` signature is fixed so the loader drops in without changing callers. This is the single intentional placeholder and is called out, not hidden.
- **Type consistency:** `Embedder.embed`, `ItemSearchRepo.{upsert,getContentHash,delete}`, `SourceItem`, `ItemEvent`, `VectorizeField` are used consistently across Tasks 5–12.
- **Dim default 1024** (BGE-M3) is enforced in config (≤2000) and asserted in the embedder + repo.
