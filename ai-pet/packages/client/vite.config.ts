import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * 注意: envPrefix は既定（VITE_）のままにする。
 * AZURE_* などのサーバ専用変数をクライアントバンドルへ持ち込まないため。
 * （tests/security/no-secret-leak.spec.ts で検査している）
 */
export default defineConfig({
  resolve: {
    alias: {
      '@ai-pet/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    /**
     * LANの他の端末（スマホ実機など）からも開けるようにする。
     * 起動時のログに `Network: http://192.168.x.x:5173/` が出る。
     *
     * WSと /healthz はこのオリジン経由でプロキシされるので、
     * スマホからは表示されたURLを開くだけで遊べる（サーバ側の設定は要らない）。
     */
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/healthz': { target: 'http://localhost:8787' },
      '/metrics': { target: 'http://localhost:8787' },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
