import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      // Allow tests/integration/health/ to import ../../src/app.js
      // (off-by-one relative path in test — resolves to tests/src/app.js
      // without this alias, but the test intent is src/app.ts)
      {
        find: /^\.\.\/\.\.\/src\//,
        replacement: path.resolve(__dirname, 'src') + '/',
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Provide test-safe placeholders so getConfig() doesn't throw in
    // unit tests that only care about PORT/DATABASE_URL (e.g. startup.test.ts).
    // Integration tests override these via their own beforeAll/afterAll hooks.
    // Real credentials are NOT needed here — Twilio SDK is mocked in all unit tests.
    // AUTH-004: JWT_SECRET placeholder (≥32 chars) added so getConfig() passes
    // in unit tests that don't explicitly set JWT env vars.
    env: {
      TWILIO_ACCOUNT_SID: 'ACtest_vitest_placeholder_00000000ab',
      TWILIO_AUTH_TOKEN: 'test_auth_token_vitest_placeholder0',
      TWILIO_VERIFY_SERVICE_SID: 'VAtest_vitest_placeholder_0000000',
      JWT_SECRET: 'vitest_placeholder_jwt_secret_32chars_min',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'migrations/',
        'tests/',
        'scripts/',
        '*.config.*',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
    testTimeout: 120000, // Testcontainers can take time to start
    hookTimeout: 120000,
  },
});
