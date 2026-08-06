/**
 * Playwright（E2E）設定。ローカル手動実行が前提（CIでは回さない）。
 *
 * - サーバ（Node）とクライアント（Vite）を webServer で自動起動する
 * - 開発用の 5173 / 8787 を占有しないよう、E2Eは 5199 / 8788 を使う
 *   （Viteのproxy先が 8787 固定なので、`tests/e2e/vite.e2e.config.ts` で上書きしている）
 * - LLMは必ず mock（コストと不安定さを持ち込まない）
 *
 * 実行: `npm run test:e2e`
 */
import { defineConfig, devices } from '@playwright/test';
import {
  E2E_BASE_URL,
  E2E_CLIENT_PORT,
  E2E_DB_PATH,
  E2E_ISLAND_SEED,
  E2E_SERVER_PORT,
} from './tests/e2e/constants.ts';

export default defineConfig({
  testDir: 'tests/e2e',
  // 注意: vitest.config.ts の include が `tests/**/*.spec.ts` なので、
  // `npm test`（Vitest）に拾われないよう E2E は `*.e2e.ts` という名前にしている。
  testMatch: '**/*.e2e.ts',

  // 4Hz tick の世界なので、状態が変わるまで数秒待つことがある。ローカル前提で寛容に。
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // 同じサーバ（同じ島）を共有するため、テスト同士が干渉しないよう直列実行する
  fullyParallel: false,
  workers: 1,
  forbidOnly: false,
  retries: 0,

  reporter: [['list']],

  use: {
    baseURL: E2E_BASE_URL,
    viewport: { width: 1280, height: 720 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      // `--llm=mock` でLLMを一切呼ばない。
      // DBは起動直前に削除する（Playwrightは webServer を globalSetup より先に起動するため、
      // globalSetup で消すと「開いているDBファイルを消す」ことになる）
      command:
        'node tests/e2e/reset-db.ts && node packages/server/src/main.ts --llm=mock',
      url: `http://localhost:${E2E_SERVER_PORT}/healthz`,
      env: {
        PORT: String(E2E_SERVER_PORT),
        DB_PATH: E2E_DB_PATH,
        ISLAND_SEED: E2E_ISLAND_SEED,
        LLM_MODE: 'mock',
        NODE_ENV: 'development',
      },
      // 開発用サーバを間違って使い回さない。テスト終了時にPlaywrightが必ず落とす
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
    {
      command: `npx vite --config tests/e2e/vite.e2e.config.ts --port ${E2E_CLIENT_PORT} --strictPort`,
      url: E2E_BASE_URL,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
    },
  ],
});
