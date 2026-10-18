import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // The PGlite (WASM Postgres) suites apply whole SQL artifacts inside
    // `beforeAll`. Starting a WASM instance and hashing/loading the artifacts
    // competes with the other PGlite files when vitest runs them in parallel,
    // so the 10s default is not a meaningful bound and produced spurious
    // "Hook timed out" failures. The tests themselves stay fast.
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
