/**
 * E2Eで共有する定数。
 * `playwright.config.ts` / `global-setup.ts` / テスト本体から参照する。
 */

/** E2E用クライアント（Vite）のポート。開発用 5173 と分ける */
export const E2E_CLIENT_PORT = 5199;
/** E2E用サーバのポート。開発用 8787 と分ける */
export const E2E_SERVER_PORT = 8788;
/** ブラウザが見るURL */
export const E2E_BASE_URL = `http://localhost:${E2E_CLIENT_PORT}`;
/** E2E用のSQLite。`data/island.db`（開発用）を壊さない */
export const E2E_DB_PATH = '.tmp/e2e-island.db';
/** E2E用の島シード。開発用の島と別の島になる */
export const E2E_ISLAND_SEED = 'e2e-seed';

/** サーバのtick周期（4Hz = 250ms）。待ち時間の見積りに使う */
export const TICK_MS = 250;
