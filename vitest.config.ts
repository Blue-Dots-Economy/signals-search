import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      // lcov is what the SonarCloud scan consumes (see sonar-project.properties).
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/main.ts'],
    },
    // Generous hook timeout so a cold Testcontainers image build (pgvector +
    // postgis) on a cache miss does not trip the default. CI pre-builds the
    // image to keep this fast; this is the local/cold-build backstop.
    hookTimeout: 300_000,
  },
});
