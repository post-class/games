import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // LAN 公開は IPv4 のみに限定する。`true` は IPv6 でも待ち受ける場合がある。
  server: { host: '0.0.0.0', port: 5173 },
  build: { target: 'es2022', outDir: 'dist' },
});
