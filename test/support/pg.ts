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
