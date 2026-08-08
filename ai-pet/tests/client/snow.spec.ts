/**
 * 冬の雪の地面（F-4）。
 *
 * ここで守りたいのは3つ:
 * - **冬だけ**出ること（春夏秋に雪が乗ると季節が読めなくなる）
 * - 同じタイルは常に同じ雪（座標ハッシュなので `Math.random` に依らない）
 * - 一面まっ白にならないこと（地面の色が全部消えると地形が読めない）
 *   かつ穴だらけにもならないこと（雪原に見えない）
 */
import { describe, expect, it } from 'vitest';
import {
  BARE_BLOCK,
  BARE_RATIO,
  SNOW_ALPHA,
  hasSnowAt,
  isSnowSeason,
  snowBlobAt,
} from '../../packages/client/src/render/snow.ts';

describe('F-4 冬の雪', () => {
  it('雪が出るのは冬だけ', () => {
    expect(isSnowSeason('winter')).toBe(true);
    for (const s of ['spring', 'summer', 'autumn', 'unknown']) {
      expect(isSnowSeason(s), s).toBe(false);
    }
  });

  it('同じタイルは常に同じ雪（決定論）', () => {
    for (const [x, y] of [
      [0, 0],
      [63, 71],
      [127, 127],
    ] as const) {
      const a = snowBlobAt(x, y);
      const b = snowBlobAt(x, y);
      expect(b).toEqual(a);
    }
  });

  it('雪の被り具合が「まっ白」でも「穴だらけ」でもない', () => {
    let snow = 0;
    let total = 0;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        total++;
        if (hasSnowAt(x, y)) snow++;
      }
    }
    const ratio = snow / total;
    // 設定値どおりの割合になっている（ハッシュが偏っていない）
    expect(ratio).toBeGreaterThan(1 - BARE_RATIO - 0.06);
    expect(ratio).toBeLessThan(1 - BARE_RATIO + 0.06);
    // 地面が読める余地は必ず残す
    expect(ratio).toBeLessThan(0.96);
  });

  it('抜けはブロックでまとまる（1タイルだけの抜けを作らない）', () => {
    // 同じブロックの中は全部同じ判定になる（＝抜けが必ず BARE_BLOCK 角になる）
    for (let by = 0; by < 20; by++) {
      for (let bx = 0; bx < 20; bx++) {
        const base = hasSnowAt(bx * BARE_BLOCK, by * BARE_BLOCK);
        for (let dy = 0; dy < BARE_BLOCK; dy++) {
          for (let dx = 0; dx < BARE_BLOCK; dx++) {
            expect(hasSnowAt(bx * BARE_BLOCK + dx, by * BARE_BLOCK + dy), `${bx},${by}`).toBe(base);
          }
        }
      }
    }
  });

  it('円は隣のタイルと重なる大きさ（32pxの格子が見えないため）', () => {
    for (let y = 10; y < 30; y++) {
      for (let x = 10; x < 30; x++) {
        const b = snowBlobAt(x, y);
        if (!b) continue;
        // 半径が 0.5 タイル以下だと円が孤立して水玉模様になる
        expect(b.r, `${x},${y}`).toBeGreaterThan(0.5);
        expect(b.r, `${x},${y}`).toBeLessThanOrEqual(1);
        // 中心はタイルの中に収まっている（隣のタイルへ飛ばない）
        expect(Math.abs(b.cx - (x + 0.5)), `${x},${y}`).toBeLessThan(0.5);
        expect(Math.abs(b.cy - (y + 0.5)), `${x},${y}`).toBeLessThan(0.5);
      }
    }
  });

  it('雪は不透明（半透明にすると円の重なりが縁として見えてしまう）', () => {
    // 実測で 0.82 にしたら円の輪郭が全部出て「泡」になった。snow.ts のコメント参照
    expect(SNOW_ALPHA).toBe(1);
  });
});
