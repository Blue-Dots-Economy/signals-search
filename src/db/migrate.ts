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
