# Signals Search — Plan 5: Worker Hardening for Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ingestion worker safe to deploy against the shared Signals DB — gate DDL ownership, back-stop missed deletes, recover stranded stream messages, and prevent overlapping sweeps.

**Architecture:** Four independent hardening changes to the existing worker (`src/worker/main.ts` + ingestion helpers). DDL gating adds a fail-fast schema check; an orphan sweep deletes `item_search` rows whose `items` row is gone; a PEL reclaim (`XAUTOCLAIM`) re-delivers messages stranded by a dead consumer; a re-entrancy guard stops `setInterval` sweeps from stacking. Each lands as its own commit with a test.

**Tech Stack:** TypeScript ESM (NodeNext), `postgres` (postgres.js), `ioredis`, Vitest + Testcontainers (pgvector+postgis image, `redis:7-alpine`).

**Tracking:** Implements Blue-Dots-Economy/signals-search#6 (split from #2 items 5 & 6). Master: Signals-DPG#171 P5 (cutover).

## Global Constraints

- TypeScript ESM, `moduleResolution: NodeNext` — **every relative import uses the `.js` extension**.
- `ioredis`: import the constructor as `import { Redis } from 'ioredis'` (named) and the type as `import type { Redis } from 'ioredis'`. The default import does not typecheck under NodeNext.
- TDD: write the failing test first, watch it fail, implement, watch it pass, commit.
- Tests use Testcontainers (Docker must be running). Reuse `test/support/pg.ts` (`startPostgres()`, `sqlClient(uri)`); reuse the `redis:7-alpine` GenericContainer pattern from `src/api/result_cache.test.ts`.
- Work on branch `feat/search-worker-hardening` (off `feature`). Do not switch branches.
- `pnpm typecheck` must stay clean and the full `pnpm vitest run` green after each task.

---

### Task 1: Gate `runMigrations` behind `RUN_MIGRATIONS` (default off) + fail-fast schema check

The worker currently runs the local `0001_item_search.sql` mirror unconditionally at boot. In prod, Signals-DPG owns the authoritative DDL (`schema.sql`, Plan 3) — the worker must NOT create/own that table. Gate migrations behind `RUN_MIGRATIONS` (default `false`, i.e. prod-safe); when off, verify the table exists and crash with a clear message if not.

**Files:**
- Modify: `src/config.ts` (add `RUN_MIGRATIONS` env + `runMigrations` config field)
- Modify: `src/db/migrate.ts` (add `assertSchemaReady`)
- Modify: `src/worker/main.ts` (branch on `cfg.runMigrations`)
- Test: `src/db/assert_schema_ready.test.ts`
- Modify (dev convenience): `.env.example` (`RUN_MIGRATIONS=true`)

**Interfaces:**
- Consumes: `runMigrations(databaseUrl: string): Promise<void>` (existing, `src/db/migrate.ts`); `loadConfig()` → `Config`.
- Produces: `assertSchemaReady(databaseUrl: string): Promise<void>` — resolves if `item_search` exists, rejects (throws `Error`) otherwise. `Config.runMigrations: boolean`.

- [ ] **Step 1: Write the failing test** `src/db/assert_schema_ready.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres } from '../../test/support/pg.js';
import { runMigrations, assertSchemaReady } from './migrate.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let pg: StartedPostgreSqlContainer;
let url: string;

beforeAll(async () => { pg = await startPostgres(); url = pg.getConnectionUri(); });
afterAll(async () => { await pg?.stop(); });

describe('assertSchemaReady', () => {
  it('rejects with a clear message when item_search is missing', async () => {
    await expect(assertSchemaReady(url)).rejects.toThrow(/item_search/i);
  });
  it('resolves once the schema has been migrated', async () => {
    await runMigrations(url);
    await expect(assertSchemaReady(url)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/db/assert_schema_ready.test.ts`
Expected: FAIL — `assertSchemaReady` is not exported from `./migrate.js`.

- [ ] **Step 3: Implement `assertSchemaReady`** — append to `src/db/migrate.ts` (keep the existing `runMigrations` unchanged; reuse the existing `postgres` import):

```typescript
export async function assertSchemaReady(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [{ ready }] = await sql<{ ready: boolean }[]>`
      SELECT (to_regclass('public.item_search') IS NOT NULL) AS ready`;
    if (!ready) {
      throw new Error(
        'item_search not found. In production Signals-DPG owns the search DDL (schema.sql); ' +
        'apply the search migration there, or set RUN_MIGRATIONS=true for local/dev.',
      );
    }
  } finally {
    await sql.end();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/db/assert_schema_ready.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the config flag** — in `src/config.ts`, add to `EnvSchema`:

```typescript
  RUN_MIGRATIONS: z.coerce.boolean().default(false),
```

Add to the `Config` type (top level, next to `databaseUrl`):

```typescript
  runMigrations: boolean;
```

Add to the `loadConfig` return object:

```typescript
    runMigrations: e.RUN_MIGRATIONS,
```

- [ ] **Step 6: Branch the worker boot** — in `src/worker/main.ts`, replace the line `await runMigrations(cfg.databaseUrl);` with:

```typescript
  if (cfg.runMigrations) {
    await runMigrations(cfg.databaseUrl);
  } else {
    await assertSchemaReady(cfg.databaseUrl);
  }
```

Update the import to pull both: `import { runMigrations, assertSchemaReady } from '../db/migrate.js';`. Add `RUN_MIGRATIONS=true` to `.env.example` (local dev applies the mirror; prod leaves it unset/false).

- [ ] **Step 7: Typecheck + full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: typecheck clean; all tests pass. (Existing tests call `runMigrations` directly, so gating the worker boot does not affect them.)

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/db/migrate.ts src/db/assert_schema_ready.test.ts src/worker/main.ts .env.example
git commit -m "feat(worker): gate runMigrations behind RUN_MIGRATIONS + fail-fast schema check (#6)"
```

---

### Task 2: Orphan sweep — delete `item_search` rows whose `items` row is gone

The reconciliation sweep only re-indexes rows present in `items`, so a missed/unacked `delete` event leaves a stale `item_search` row forever (no FK / `ON DELETE`). Add a sweep that removes orphaned `item_search` rows and run it each sweep cycle.

**Files:**
- Modify: `src/ingest/sweep.ts` (add `sweepOrphans`)
- Modify: `src/worker/main.ts` (call it inside the periodic sweep)
- Test: `src/ingest/sweep_orphans.test.ts`

**Interfaces:**
- Consumes: `Sql` from `postgres`; the `item_search` table and an `items` table sharing the composite key `(item_network, item_domain, item_type, item_id)`.
- Produces: `sweepOrphans(sql: Sql): Promise<number>` — deletes `item_search` rows with no matching `items` row, returns the deleted count.

- [ ] **Step 1: Write the failing test** `src/ingest/sweep_orphans.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { sweepOrphans } from './sweep.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';

let pg: StartedPostgreSqlContainer;
let sql: Sql;
const N = 1024;
const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0' };
const KEEP = '11111111-1111-1111-1111-111111111111';
const ORPHAN = '22222222-2222-2222-2222-222222222222';
function vec(seed: number) { const v = Array.from({ length: N }, () => 0); v[seed % N] = 1; return v; }

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri(); await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE items (item_network text,item_domain text,item_type text,item_id uuid,
    item_state jsonb NOT NULL DEFAULT '{}', item_locations jsonb NOT NULL DEFAULT '[]',
    lifecycle_status text NOT NULL DEFAULT 'live',
    PRIMARY KEY (item_network,item_domain,item_type,item_id))`;
  // Only KEEP exists in items; ORPHAN is indexed but its items row is gone.
  await sql`INSERT INTO items (item_network,item_domain,item_type,item_id) VALUES (${base.item_network},${base.item_domain},${base.item_type},${KEEP})`;
  const repo = new ItemSearchRepo(sql, N);
  await repo.upsert({ ...base, item_id: KEEP, embedding: vec(0), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'k' });
  await repo.upsert({ ...base, item_id: ORPHAN, embedding: vec(1), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: 'o' });
});
afterAll(async () => { await sql?.end(); await pg?.stop(); });

describe('sweepOrphans', () => {
  it('deletes item_search rows with no matching items row and returns the count', async () => {
    const deleted = await sweepOrphans(sql);
    expect(deleted).toBe(1);
    const ids = await sql<{ item_id: string }[]>`SELECT item_id FROM item_search ORDER BY item_id`;
    expect(ids.map((r) => r.item_id)).toEqual([KEEP]);
  });
  it('is a no-op when there are no orphans', async () => {
    expect(await sweepOrphans(sql)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ingest/sweep_orphans.test.ts`
Expected: FAIL — `sweepOrphans` is not exported from `./sweep.js`.

- [ ] **Step 3: Implement `sweepOrphans`** — append to `src/ingest/sweep.ts`:

```typescript
/** Remove item_search rows whose items row no longer exists (missed deletes,
 *  no FK/ON DELETE). Returns the number of rows deleted. */
export async function sweepOrphans(sql: Sql): Promise<number> {
  const res = await sql`
    DELETE FROM item_search s
    WHERE NOT EXISTS (
      SELECT 1 FROM items i
      WHERE i.item_network = s.item_network AND i.item_domain = s.item_domain
        AND i.item_type = s.item_type AND i.item_id = s.item_id)`;
  return res.count;
}
```

(`res.count` is postgres.js's affected-row count for a DELETE.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/ingest/sweep_orphans.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it into the periodic sweep** — in `src/worker/main.ts`, import `sweepOrphans` alongside `runSweep` (`import { runSweep, sweepOrphans } from '../ingest/sweep.js';`) and change the `sweep` closure so each cycle reconciles then prunes orphans:

```typescript
  const sweep = async () => {
    try {
      await runSweep({ sql, repo, embedder, fieldsFor, modelVersion, batchSize: cfg.sweep.batchSize });
      await sweepOrphans(sql);
    } catch (err) {
      console.error('sweep failed', err);
    }
  };
```

- [ ] **Step 6: Typecheck + full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/ingest/sweep.ts src/ingest/sweep_orphans.test.ts src/worker/main.ts
git commit -m "feat(worker): orphan sweep removes item_search rows with no items row (#6)"
```

---

### Task 3: PEL reclaim — re-deliver messages stranded by a dead consumer

`readBatch` reads only new (`>`) messages. If a worker dies after reading but before `XACK`, those messages sit in the consumer group's Pending Entries List forever. Add `reclaimPending` (`XAUTOCLAIM`) so a live worker reclaims messages idle longer than a threshold, then processes them through the normal path.

**Files:**
- Modify: `src/config.ts` (add `PEL_MIN_IDLE_MS` to the ingest group)
- Modify: `src/ingest/stream_consumer.ts` (add `reclaimPending`)
- Modify: `src/worker/main.ts` (reclaim at the top of each loop iteration)
- Test: `src/ingest/reclaim_pending.test.ts`

**Interfaces:**
- Consumes: `Redis` from `ioredis`; the existing module-private `fieldsToEvent` and the exported `StreamMessage`/`ItemEvent` types in `stream_consumer.ts`; `ensureConsumerGroup`.
- Produces: `reclaimPending(redis: Redis, stream: string, group: string, consumer: string, minIdleMs: number, count: number): Promise<StreamMessage[]>` — claims up to `count` pending messages idle ≥ `minIdleMs` for this consumer and returns them parsed (skipping tombstoned entries whose fields are null). `Config.ingest.pelMinIdleMs: number`.

- [ ] **Step 1: Write the failing test** `src/ingest/reclaim_pending.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { ensureConsumerGroup, reclaimPending } from './stream_consumer.js';

let c: StartedTestContainer; let redis: Redis;
const STREAM = 'signals:item-events'; const GROUP = 'signals-search';

beforeAll(async () => {
  c = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redis = new Redis(c.getMappedPort(6379), c.getHost());
  await ensureConsumerGroup(redis, STREAM, GROUP);
});
afterAll(async () => { redis?.disconnect(); await c?.stop(); });

describe('reclaimPending', () => {
  it('claims a message left pending by a dead consumer and parses it', async () => {
    await redis.xadd(STREAM, '*', 'item_network', 'purple_dot', 'item_domain', 'provider',
      'item_type', 'profile_1.0', 'item_id', 'abc', 'op', 'upsert', 'occurred_at', 't0');
    // dead-worker reads it (now pending + unacked under dead-worker)
    await redis.xreadgroup('GROUP', GROUP, 'dead-worker', 'COUNT', 10, 'STREAMS', STREAM, '>');

    const claimed = await reclaimPending(redis, STREAM, GROUP, 'live-worker', 0, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].event).toMatchObject({ item_id: 'abc', op: 'upsert', item_network: 'purple_dot' });
  });

  it('returns empty when nothing is pending', async () => {
    // ack the one outstanding message, then nothing should be reclaimable
    await redis.xack(STREAM, GROUP, ...(await redis.xrange(STREAM, '-', '+')).map(([id]) => id));
    expect(await reclaimPending(redis, STREAM, GROUP, 'live-worker', 0, 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ingest/reclaim_pending.test.ts`
Expected: FAIL — `reclaimPending` is not exported from `./stream_consumer.js`.

- [ ] **Step 3: Implement `reclaimPending`** — add to `src/ingest/stream_consumer.ts` (reuse the existing module-private `fieldsToEvent`):

```typescript
export async function reclaimPending(
  redis: Redis, stream: string, group: string, consumer: string, minIdleMs: number, count: number,
): Promise<StreamMessage[]> {
  // XAUTOCLAIM <key> <group> <consumer> <min-idle-time> <start> COUNT <count>
  // Returns [nextCursor, entries, deletedIds]; entries is [[id, fields[] | null], ...].
  const res = (await redis.xautoclaim(
    stream, group, consumer, minIdleMs, '0-0', 'COUNT', count,
  )) as [string, [string, string[] | null][], string[]];
  const entries = res?.[1] ?? [];
  const out: StreamMessage[] = [];
  for (const [id, fields] of entries) {
    if (!fields) continue; // tombstoned (message deleted from the stream) — skip
    out.push({ id, event: fieldsToEvent(fields) });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/ingest/reclaim_pending.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the config knob** — in `src/config.ts`, add to `EnvSchema`:

```typescript
  PEL_MIN_IDLE_MS: z.coerce.number().int().nonnegative().default(60_000),
```

Extend the `Config` type's `ingest` group to `{ stream: string; consumerGroup: string; consumerName: string; pelMinIdleMs: number }`, and in the `loadConfig` return set `ingest: { stream: e.INGEST_STREAM, consumerGroup: e.INGEST_CONSUMER_GROUP, consumerName: e.INGEST_CONSUMER_NAME, pelMinIdleMs: e.PEL_MIN_IDLE_MS }`. Add `PEL_MIN_IDLE_MS=60000` to `.env.example`.

- [ ] **Step 6: Process reclaimed messages each loop iteration** — in `src/worker/main.ts`, import `reclaimPending`, and inside the `while (true)` loop, BEFORE `readBatch`, reclaim then merge so stranded messages flow through the same process+ack path:

```typescript
    const reclaimed = await reclaimPending(
      redis, cfg.ingest.stream, cfg.ingest.consumerGroup, cfg.ingest.consumerName, cfg.ingest.pelMinIdleMs, 50,
    ).catch((err) => { console.error('reclaimPending failed', err); return []; });
    const fresh = await readBatch(redis, cfg.ingest.stream, cfg.ingest.consumerGroup, cfg.ingest.consumerName, 50, 5000);
    for (const msg of [...reclaimed, ...fresh]) {
      try {
        await processEvent({ event: msg.event, sql, repo, embedder, fieldsFor, modelVersion });
        await ackMessages(redis, cfg.ingest.stream, cfg.ingest.consumerGroup, [msg.id]);
      } catch (err) {
        console.error('processEvent failed; leaving unacked for retry', msg.id, err);
      }
    }
```

(Replaces the existing `const batch = await readBatch(...)` line and its `for (const msg of batch)` loop. Keep the import line updated: `import { ensureConsumerGroup, readBatch, ackMessages, reclaimPending } from '../ingest/stream_consumer.js';`.)

- [ ] **Step 7: Typecheck + full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: typecheck clean; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/ingest/stream_consumer.ts src/ingest/reclaim_pending.test.ts src/worker/main.ts .env.example
git commit -m "feat(worker): XAUTOCLAIM reclaim of stranded pending messages (#6)"
```

---

### Task 4: Sweep re-entrancy guard

`setInterval(sweep, ...)` fires on a fixed cadence; if a sweep runs longer than the interval, ticks stack and overlap. Add a small guard that skips a tick while a prior run is still in flight, and wrap the interval sweep with it.

**Files:**
- Create: `src/worker/guarded.ts`
- Modify: `src/worker/main.ts` (wrap the interval sweep)
- Test: `src/worker/guarded.test.ts`

**Interfaces:**
- Produces: `makeGuarded(fn: () => Promise<void>): () => Promise<void>` — returns a wrapper that invokes `fn` only if no prior invocation is still pending; concurrent calls during an in-flight run resolve immediately without invoking `fn`.

- [ ] **Step 1: Write the failing test** `src/worker/guarded.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { makeGuarded } from './guarded.js';

describe('makeGuarded', () => {
  it('skips overlapping invocations while one is in flight, then runs again once free', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const guarded = makeGuarded(async () => { calls += 1; await gate; });

    const a = guarded(); // starts; calls === 1, awaiting gate
    const b = guarded(); // in flight → skipped
    expect(calls).toBe(1);

    release();
    await Promise.all([a, b]);

    await guarded(); // free now → runs again
    expect(calls).toBe(2);
  });

  it('clears the in-flight flag even when fn throws', async () => {
    let calls = 0;
    const guarded = makeGuarded(async () => { calls += 1; throw new Error('boom'); });
    await expect(guarded()).rejects.toThrow('boom');
    await expect(guarded()).rejects.toThrow('boom'); // not stuck "in flight"
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/worker/guarded.test.ts`
Expected: FAIL — `Cannot find module './guarded.js'`.

- [ ] **Step 3: Implement `src/worker/guarded.ts`:**

```typescript
/** Wrap an async fn so overlapping invocations are skipped while one is in
 *  flight. Used to keep interval-driven sweeps from stacking. The wrapper
 *  re-throws fn's error (and clears the in-flight flag) so failures surface. */
export function makeGuarded(fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/worker/guarded.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wrap the interval sweep** — in `src/worker/main.ts`, add `import { makeGuarded } from './guarded.js';`, and change the sweep scheduling so the interval uses the guarded wrapper (the initial awaited run can stay direct):

```typescript
  await sweep();
  const guardedSweep = makeGuarded(sweep);
  setInterval(guardedSweep, cfg.sweep.intervalMs);
```

- [ ] **Step 6: Typecheck + full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/worker/guarded.ts src/worker/guarded.test.ts src/worker/main.ts
git commit -m "feat(worker): re-entrancy guard so interval sweeps don't stack (#6)"
```

---

## Self-Review Notes (for the implementer)

- **#6 coverage:** DDL-ownership gating ✓ (Task 1 — `RUN_MIGRATIONS` default off + fail-fast `assertSchemaReady`); orphan/delete backstop ✓ (Task 2 — `sweepOrphans` each cycle); PEL recovery ✓ (Task 3 — `XAUTOCLAIM` via `reclaimPending`, processed through the normal ack path); sweep re-entrancy ✓ (Task 4 — `makeGuarded`).
- **Type/name consistency:** new exports are `assertSchemaReady` (migrate.ts), `sweepOrphans` (sweep.ts), `reclaimPending` (stream_consumer.ts), `makeGuarded` (worker/guarded.ts); config gains `runMigrations: boolean` and `ingest.pelMinIdleMs: number`. `reclaimPending` returns `StreamMessage[]` — the same type `readBatch` returns — so both flow through the identical process+ack loop.
- **Out of scope (tracked elsewhere):** anchor lookup keys on `item_id` alone (#2 item 1 / composite-PK direction); the worker now requires `NETWORK_CONFIG_PATH` mounted (coordinate with bluedots-automation#22 / Plan 3 / Plan 4 deploy). `RUN_MIGRATIONS` and `PEL_MIN_IDLE_MS` must be threaded into the Helm chart in Plan 4.
- **Test isolation:** Tasks 1 & 2 use the PG testcontainer; Task 3 uses `redis:7-alpine`; Task 4 is a pure unit test (no container). The PG image build can be cold — prebuild with `docker build -t signals-search-pg-test test/docker -f test/docker/Dockerfile.postgres` if a hook timeout occurs.
