import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    /**
     * **テストファイルを並列実行しない。**
     *
     * このプロジェクトは性能予算そのものが完了条件に入っている
     * （手順書 T-M2-06「1000 tick/秒以上」、T-M3-07「400 体で 1 tick 4ms 以内」など）。
     * ファイルを並列に走らせると CPU を奪い合い、同じコードでも
     * 実測 0.42ms/tick が 44ms に化けて**偽の失敗**になる。
     * 閾値を緩めて誤魔化すと本物の性能劣化を見逃すので、測定条件を固定する方を選んだ。
     *
     * 代償は実行時間（並列 27 秒 → 直列 43 秒）。この差は許容する。
     */
    fileParallelism: false,
  },
});
