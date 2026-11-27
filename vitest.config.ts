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
    // Covers a cold Testcontainers image build (CI pre-builds the image).
    hookTimeout: 300_000,
  },
});
