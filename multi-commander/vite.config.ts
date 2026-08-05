import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // GLTFLoader/SkeletonUtils も同じ Three.js インスタンスを参照する。
  // 別インスタンスになると Three.js が警告し、Loader の型判定も不安定になる。
  resolve: { dedupe: ['three'] },
  // LAN 上の端末からも開けるようにし、起動ログに Network URL を表示する。
  server: { host: '0.0.0.0', port: 5173 },
  build: { target: 'es2022', sourcemap: true },
});
