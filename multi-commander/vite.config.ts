import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // LAN 上の端末からも開けるようにし、起動ログに Network URL を表示する。
  server: { host: '0.0.0.0', port: 5173 },
  build: { target: 'es2022', sourcemap: true },
});
