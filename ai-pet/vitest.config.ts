import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ai-pet/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.spec.ts'],
    // E2E（Playwright）はVitestで走らせない。`npm run test:e2e` で実行する
    exclude: ['tests/e2e/**'],
    testTimeout: 20_000,
  },
});
