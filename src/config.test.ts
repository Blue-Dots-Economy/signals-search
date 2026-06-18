import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@h:5432/db',
    REDIS_URL: 'redis://h:6379',
    EMBEDDING_BASE_URL: 'http://tei:8080/v1',
    EMBEDDING_MODEL: 'BAAI/bge-m3',
    EMBEDDING_DIM: '1024',
    NETWORK_CONFIG_PATH: './test/fixtures/networks',
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

  it('defaults boolean flags to false when unset', () => {
    const cfg = loadConfig(base);
    expect(cfg.runMigrations).toBe(false);
    expect(cfg.rerank.defaultOn).toBe(false);
  });

  // Regression: z.coerce.boolean() read the string "false" as true, so
  // RUN_MIGRATIONS="false" wrongly ran migrations in prod.
  it('parses "false"/"0" as false and "true"/"1" as true', () => {
    expect(loadConfig({ ...base, RUN_MIGRATIONS: 'false' }).runMigrations).toBe(false);
    expect(loadConfig({ ...base, RUN_MIGRATIONS: '0' }).runMigrations).toBe(false);
    expect(loadConfig({ ...base, RUN_MIGRATIONS: 'true' }).runMigrations).toBe(true);
    expect(loadConfig({ ...base, RUN_MIGRATIONS: '1' }).runMigrations).toBe(true);
    expect(loadConfig({ ...base, RERANK_DEFAULT: 'false' }).rerank.defaultOn).toBe(false);
    expect(loadConfig({ ...base, RERANK_DEFAULT: 'true' }).rerank.defaultOn).toBe(true);
  });

  it('rejects a non-boolean flag value', () => {
    expect(() => loadConfig({ ...base, RUN_MIGRATIONS: 'maybe' })).toThrow();
  });
});
