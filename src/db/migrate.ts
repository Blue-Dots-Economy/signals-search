import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = ['0001_item_search.sql', '0002_item_search_source_updated_at.sql'];

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

    // Signals-DPG owns this DDL, so the database may predate `source_updated_at`.
    // The sweep and every upsert need it; booting without it would stay ready
    // while every sweep throws and every message retries to the DLQ.
    const [{ hasColumn }] = await sql<{ hasColumn: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'item_search'
          AND column_name = 'source_updated_at'
      ) AS "hasColumn"`;
    if (!hasColumn) {
      throw new Error(
        'item_search.source_updated_at not found — the database predates the staleness-marker ' +
        'migration this worker requires. Apply Signals-DPG migration ' +
        '0012_item_search_source_updated_at (its deploy migrate job) BEFORE rolling out this ' +
        'version, or set RUN_MIGRATIONS=true for local/dev.',
      );
    }
  } finally {
    await sql.end();
  }
}
