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

  it('enables the served docs surface by default (non-production, nothing set)', () => {
    const cfg = loadConfig(base);
    expect(cfg.apiReference.enabled).toBe(true);
  });

  it('disables the served docs surface in production by default', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'production' });
    expect(cfg.apiReference.enabled).toBe(false);
  });

  it('re-enables the served docs surface in production when force-flagged', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'production', API_REFERENCE_FORCE: 'true' });
    expect(cfg.apiReference.enabled).toBe(true);
  });

  it('disables the served docs surface outside production when explicitly turned off', () => {
    const cfg = loadConfig({ ...base, API_REFERENCE_ENABLED: 'false' });
    expect(cfg.apiReference.enabled).toBe(false);
  });

  it('passes through the public base URL when configured, and leaves it undefined otherwise', () => {
    expect(loadConfig(base).apiReference.publicBaseUrl).toBeUndefined();
    expect(
      loadConfig({ ...base, PUBLIC_API_BASE_URL: 'https://search.example.org' }).apiReference.publicBaseUrl,
    ).toBe('https://search.example.org');
  });
});

describe('loadConfig — auth', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@h:5432/db',
    REDIS_URL: 'redis://h:6379',
    EMBEDDING_BASE_URL: 'http://tei:8080/v1',
    EMBEDDING_MODEL: 'BAAI/bge-m3',
    EMBEDDING_DIM: '1024',
    NETWORK_CONFIG_PATH: './test/fixtures/networks',
  };

  it('defaults to api-key-only when no Keycloak base url is set', () => {
    const cfg = loadConfig(base);
    expect(cfg.auth).toEqual({ acceptApiKey: true });
  });

  it('builds the issuer and jwks uri from the base url and realm', () => {
    const cfg = loadConfig({
      ...base,
      KEYCLOAK_BASE_URL: 'https://auth.example.com/',
      KEYCLOAK_SERVICE_CLIENT_IDS: 'signals-search, voice-dpg',
    });
    expect(cfg.auth.keycloak).toEqual({
      issuer: 'https://auth.example.com/realms/bluedots',
      jwksUri: 'https://auth.example.com/realms/bluedots/protocol/openid-connect/certs',
      audience: 'signals-search',
      serviceClientIds: ['signals-search', 'voice-dpg'],
      jwksCacheMaxAgeMs: 600_000,
      clockToleranceSeconds: 30,
    });
    expect(cfg.auth.acceptApiKey).toBe(true);
  });

  it('fetches the jwks from the internal base url when one is given', () => {
    const cfg = loadConfig({
      ...base,
      KEYCLOAK_BASE_URL: 'https://auth.example.com',
      KEYCLOAK_INTERNAL_BASE_URL: 'http://keycloak:8080',
      KEYCLOAK_SERVICE_CLIENT_IDS: 'signals-search',
    });
    // iss is what the token carries (public); the fetch stays in-cluster.
    expect(cfg.auth.keycloak?.issuer).toBe('https://auth.example.com/realms/bluedots');
    expect(cfg.auth.keycloak?.jwksUri).toBe(
      'http://keycloak:8080/realms/bluedots/protocol/openid-connect/certs',
    );
  });

  it('refuses to boot with Keycloak configured but no client allowlist', () => {
    expect(() =>
      loadConfig({ ...base, KEYCLOAK_BASE_URL: 'https://auth.example.com' }),
    ).toThrow(/KEYCLOAK_SERVICE_CLIENT_IDS/);
  });

  it('refuses to boot with no authentication at all', () => {
    expect(() => loadConfig({ ...base, AUTH_ACCEPT_API_KEY: 'false' })).toThrow(
      /No authentication is configured/,
    );
  });

  it('closes the dual-accept window when AUTH_ACCEPT_API_KEY is false', () => {
    const cfg = loadConfig({
      ...base,
      KEYCLOAK_BASE_URL: 'https://auth.example.com',
      KEYCLOAK_SERVICE_CLIENT_IDS: 'signals-search',
      AUTH_ACCEPT_API_KEY: 'false',
    });
    expect(cfg.auth.acceptApiKey).toBe(false);
  });
});
