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
  } finally {
    await sql.end();
  }
}
