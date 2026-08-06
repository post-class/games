/**
 * E2E専用の Vite 設定。
 *
 * 開発用（client:5173 / server:8787）と衝突させずにE2Eを回すため、
 * クライアントの設定を読み込んで **ポートとWSプロキシ先だけ** 上書きする。
 * クライアント側のコードや `packages/client/vite.config.ts` は一切変更しない。
 *
 * 使い方: `vite --config tests/e2e/vite.e2e.config.ts`
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig, type UserConfig } from 'vite';
import clientConfig from '../../packages/client/vite.config.ts';
import { E2E_CLIENT_PORT, E2E_SERVER_PORT } from './constants.ts';

const base = clientConfig as UserConfig;

export default defineConfig(
  mergeConfig(base, {
    // --config を外部ディレクトリに置いたので root は明示する（既定は cwd になってしまう）
    root: fileURLToPath(new URL('../../packages/client', import.meta.url)),
    server: {
      port: E2E_CLIENT_PORT,
      strictPort: true,
      proxy: {
        '/ws': { target: `ws://localhost:${E2E_SERVER_PORT}`, ws: true },
        '/healthz': { target: `http://localhost:${E2E_SERVER_PORT}` },
        '/metrics': { target: `http://localhost:${E2E_SERVER_PORT}` },
      },
    },
  } satisfies UserConfig),
);
