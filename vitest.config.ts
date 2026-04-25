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
