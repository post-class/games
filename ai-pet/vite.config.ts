import { defineConfig } from 'vite';

export default defineConfig({
  // LAN 上の端末からも開けるようにし、起動ログに Network URL を表示する。
  server: {
    host: '0.0.0.0',
    port: 5273,
    // API はサーバ（tsx で起動する Express）へ転送する。APIキーはブラウザに出さない。
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  build: { target: 'es2022', sourcemap: true },
});
