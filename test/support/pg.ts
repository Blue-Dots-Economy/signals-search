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

export async function createItemActionsTable(sql: ReturnType<typeof sqlClient>) {
  await sql`CREATE TABLE item_actions (
    partition_network text NOT NULL, action_type text NOT NULL,
    action_id uuid NOT NULL DEFAULT gen_random_uuid(), action_status text NOT NULL,
    source_item_id uuid NOT NULL, target_item_id uuid NOT NULL,
    requirements_snapshot jsonb NOT NULL DEFAULT '{}', remarks text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (partition_network, action_type, action_id))`;
}
