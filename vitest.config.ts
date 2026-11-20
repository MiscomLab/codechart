import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@codechart/core': resolve(import.meta.dirname, 'packages/core/src/index.ts'),
    },
  },
  // Git-heavy tests take 6-11s on Windows runners.
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'tests/scripts/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
  },
});
