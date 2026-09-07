import { createHash } from 'node:crypto';
import { startPostgres, sqlClient } from './pg.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ItemSearchRepo } from '../../src/db/item_search_repo.js';
import { loadNetworkRegistry } from '../../src/config/network_registry.js';
import { buildServer, type ApiDeps } from '../../src/api/server.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';
import type { FastifyInstance } from 'fastify';

// Shared boot block for the route-level search tests (#644). Three new suites
// need the same scaffolding — a real Postgres with the item_search migrations,
// the `items` and `apikey` tables that live in Signals-DPG (so they are created
// here rather than migrated), one enabled API key, and a server wired to the
// purple_dot fixture registry. Extracted rather than copied a third time; the
// two pre-existing suites keep their own inline blocks untouched.

export const EMBEDDING_DIM = 1024;

/** A one-hot embedding, so cosine order between seeded rows is predictable. */
export function oneHot(seed: number, dim = EMBEDDING_DIM): number[] {
  const v = Array.from({ length: dim }, () => 0);
  v[seed % dim] = 1;
  return v;
}

export type SearchAppOptions = {
  /** Raw API key the suite will send as `x-api-key`. */
  apiKey: string;
  /** Overrides merged over the default deps (e.g. rerank config, embedder). */
  deps?: Partial<ApiDeps>;
};

export type SearchApp = {
  pg: StartedPostgreSqlContainer;
  sql: Sql;
  app: FastifyInstance;
  repo: ItemSearchRepo;
  /** Build a second server over the SAME database with different deps. */
  buildWith: (overrides: Partial<ApiDeps>) => FastifyInstance;
  stop: () => Promise<void>;
};

export async function startSearchApp(opts: SearchAppOptions): Promise<SearchApp> {
  const pg = await startPostgres();
  const url = pg.getConnectionUri();
  await runMigrations(url);
  const sql = sqlClient(url);

  // `items` and `apikey` are owned by Signals-DPG, not by this repo's
  // migrations, so the test creates the columns the search path reads.
  await sql`CREATE TABLE items (
    item_network text, item_domain text, item_type text, item_id uuid,
    item_state jsonb NOT NULL DEFAULT '{}', item_locations jsonb NOT NULL DEFAULT '[]',
    lifecycle_status text NOT NULL DEFAULT 'live',
    item_instance_url text, item_schema_url text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    PRIMARY KEY (item_network, item_domain, item_type, item_id))`;
  await sql`CREATE TABLE "apikey" (
    id text PRIMARY KEY, key text NOT NULL, user_id text,
    enabled boolean NOT NULL DEFAULT true, expires_at timestamp, remaining integer)`;
  await sql`INSERT INTO "apikey" (id, key, user_id, enabled)
    VALUES ('k1', ${createHash('sha256').update(opts.apiKey).digest('base64url')}, 'usr_1', true)`;

  const registry = await loadNetworkRegistry('test/fixtures/networks');

  const baseDeps: ApiDeps = {
    sql,
    // No Redis container: the result cache is exercised by result_cache.test.ts.
    // A miss-always stub keeps each request independent, which is what the sort
    // and paging assertions need.
    redis: { get: async () => null, set: async () => 'OK' } as unknown as ApiDeps['redis'],
    embedder: { embed: async (texts: string[]) => texts.map(() => oneHot(0)) },
    registry,
    rerank: { model: 'r', defaultOn: false, topN: 50 },
    cacheTtlSeconds: 0,
    embeddingDim: EMBEDDING_DIM,
    defaultDistanceMeters: 30000,
  };

  const built: FastifyInstance[] = [];
  const buildWith = (overrides: Partial<ApiDeps>): FastifyInstance => {
    const app = buildServer({ deps: { ...baseDeps, ...overrides } });
    built.push(app);
    return app;
  };

  const app = buildWith(opts.deps ?? {});

  return {
    pg,
    sql,
    app,
    repo: new ItemSearchRepo(sql, EMBEDDING_DIM),
    buildWith,
    stop: async () => {
      await Promise.all(built.map((a) => a.close()));
      await sql.end();
      await pg.stop();
    },
  };
}
