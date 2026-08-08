/**
 * 海のアニメーション（B-4）。
 *
 * `WaveLayer` 本体は Pixi と DOM が必要なので、ここでは
 * 「海岸線の判定」「波の位置決め」「reduced で時間が止まること」を検証する。
 */
import { describe, expect, it } from 'vitest';
import { MAP_H, MAP_W, TERRAINS, TILE_PX } from '@ai-pet/shared';
import {
  MAX_COAST_TILES,
  SIDE_E,
  SIDE_N,
  SIDE_S,
  SIDE_W,
  WATER_INDEX,
  WAVE_PERIOD_SEC,
  advanceWaveTime,
  coastTilesIn,
  collectCoastTiles,
  foamOffset,
  landMaskAt,
  shallowOffset,
} from '../../packages/client/src/render/waves.ts';

const GRASS = TERRAINS.indexOf('grass');
const SAND = TERRAINS.indexOf('sand');

/**
 * 文字絵から `terrainAt` を作る。`.` = 水 / `#` = 草 / `s` = 砂 / `?` = 未受信(-1)。
 * 盤の外は未受信(-1) 扱いにして、`terrainAt` と同じ振る舞いにする。
 */
function grid(rows: string[]): (x: number, y: number) => number {
  return (x, y) => {
    const row = rows[y];
    if (row === undefined) return -1;
    const ch = row[x];
    if (ch === undefined) return -1;
    if (ch === '.') return WATER_INDEX;
    if (ch === '#') return GRASS;
    if (ch === 's') return SAND;
    return -1;
  };
}

const FULL_RECT = { x0: 0, y0: 0, x1: MAP_W, y1: MAP_H };

describe('WATER_INDEX', () => {
  it('TERRAINS の並びから引いている（数値を直書きしていない）', () => {
    expect(WATER_INDEX).toBe(TERRAINS.indexOf('water'));
    expect(TERRAINS[WATER_INDEX]).toBe('water');
  });
});

describe('landMaskAt', () => {
  it('陸タイルは対象外（0）', () => {
    const g = grid(['##', '##']);
    expect(landMaskAt(g, 0, 0)).toBe(0);
  });

  it('四方が水の沖は動かさない（0）', () => {
    const g = grid(['...', '...', '...']);
    expect(landMaskAt(g, 1, 1)).toBe(0);
  });

  it('陸に接している辺だけビットが立つ', () => {
    // 中央の水タイルの北だけ陸
    expect(landMaskAt(grid(['.#.', '...', '...']), 1, 1)).toBe(SIDE_N);
    expect(landMaskAt(grid(['...', '...', '.#.']), 1, 1)).toBe(SIDE_S);
    expect(landMaskAt(grid(['...', '..#', '...']), 1, 1)).toBe(SIDE_E);
    expect(landMaskAt(grid(['...', '#..', '...']), 1, 1)).toBe(SIDE_W);
  });

  it('入り江（2辺が陸）は両方のビットが立つ', () => {
    expect(landMaskAt(grid(['.#.', '#..', '...']), 1, 1)).toBe(SIDE_N | SIDE_W);
  });

  it('斜めだけ陸のタイルは拾わない（辺で接していないので白波を描く辺が無い）', () => {
    expect(landMaskAt(grid(['#..', '...', '...']), 1, 1)).toBe(0);
  });

  it('砂浜でも草地でも「陸」として扱う（水以外はすべて岸）', () => {
    expect(landMaskAt(grid(['.s.', '...', '...']), 1, 1)).toBe(SIDE_N);
  });

  it('未受信チャンク(-1)は水とみなす＝チャンク境界に嘘の白波を出さない', () => {
    // 盤の外＝-1。左上の水タイルは上と左が -1 だが、白波は出ない
    expect(landMaskAt(grid(['..', '..']), 0, 0)).toBe(0);
    // 右に陸があれば、そちらだけ立つ
    expect(landMaskAt(grid(['.#', '..']), 0, 0)).toBe(SIDE_E);
  });
});

describe('collectCoastTiles', () => {
  it('陸に隣接する水タイルだけを拾う', () => {
    // 3x3 の陸の島を水が囲む形。海岸は島の上下左右に接する4枚だけ
    const g = grid([
      '.....',
      '.....',
      '..#..',
      '.....',
      '.....',
    ]);
    const tiles = coastTilesIn(FULL_RECT, g);
    expect(tiles.map((t) => `${t.x},${t.y}`).sort()).toEqual(['2,1', '2,3', '1,2', '3,2'].sort());
    // 沖（0,0 など）は入っていない
    expect(tiles.some((t) => t.x === 0 && t.y === 0)).toBe(false);
  });

  it('陸タイル自体は拾わない（波は水側に描く）', () => {
    const g = grid(['.#.', '.#.', '.#.']);
    const tiles = coastTilesIn(FULL_RECT, g);
    expect(tiles.every((t) => g(t.x, t.y) === WATER_INDEX)).toBe(true);
  });

  it('画面外は拾わない（visibleRect の外は走査しない）', () => {
    const g = grid(['.#.', '.#.', '.#.']);
    const near = coastTilesIn({ x0: 0, y0: 0, x1: 0, y1: 0 }, g);
    // (0,0) は東が陸なので1枚だけ拾う
    expect(near).toEqual([{ x: 0, y: 0, mask: SIDE_E }]);
  });

  it('マップ外へはみ出した矩形でも落ちない', () => {
    const g = grid(['.#']);
    expect(() => coastTilesIn({ x0: -50, y0: -50, x1: MAP_W + 50, y1: MAP_H + 50 }, g)).not.toThrow();
  });

  it('limit で打ち切る（上限は性能の安全弁）', () => {
    // 全面水＋1列だけ陸 → 海岸がたくさんできる盤
    const rows: string[] = [];
    for (let y = 0; y < 20; y++) rows.push('.#.'.repeat(10));
    const g = grid(rows);
    const buf: number[] = [];
    const n = collectCoastTiles(FULL_RECT, g, 7, buf);
    expect(n).toBe(7);
  });

  it('同じ入力なら同じ結果（走査順が固定＝決定論）', () => {
    const rows: string[] = [];
    for (let y = 0; y < 12; y++) rows.push('..##..#...##');
    const g = grid(rows);
    const a = coastTilesIn(FULL_RECT, g, 9);
    const b = coastTilesIn(FULL_RECT, g, 9);
    expect(a).toEqual(b);
  });

  it('既定の上限は 200（1280×720 の視界の海岸線 40〜70 枚に対する安全弁）', () => {
    expect(MAX_COAST_TILES).toBe(200);
  });
});

describe('foamOffset', () => {
  it('同じ入力なら必ず同じ位置（Math.random を使っていない）', () => {
    for (const u of [0, 13.5, 512, -320]) {
      expect(foamOffset(u, 1.1)).toBe(foamOffset(u, 1.1));
    }
  });

  it('常に水側（正の食い込み）＝陸へ食い込まない', () => {
    for (let i = 0; i < 400; i++) {
      const u = i * 7.3;
      const t = (i % 53) * 0.05;
      expect(foamOffset(u, t)).toBeGreaterThan(0);
    }
  });

  it('タイルより浅い位置に収まる（沖まで白波が伸びない）', () => {
    for (let i = 0; i < 400; i++) {
      expect(foamOffset(i * 3.1, (i % 31) * 0.09)).toBeLessThan(TILE_PX / 2);
    }
  });

  it('周期は WAVE_PERIOD_SEC（寄せて引くのが2〜3秒で1巡する）', () => {
    for (const u of [0, 48, 200.5]) {
      expect(foamOffset(u, 0.4)).toBeCloseTo(foamOffset(u, 0.4 + WAVE_PERIOD_SEC), 6);
    }
  });

  it('時間が進むと位置が動く（＝静止画に見えない）', () => {
    const a = foamOffset(64, 0);
    const b = foamOffset(64, WAVE_PERIOD_SEC / 2);
    expect(Math.abs(a - b)).toBeGreaterThan(1);
  });

  it('タイル境界で連続する（位相を辺沿いのワールドpxで作っているため）', () => {
    // タイル1枚ぶん右の点は、隣タイルの左端と同じ u になる
    const t = 0.77;
    const uEdge = 5 * TILE_PX;
    expect(foamOffset(uEdge, t)).toBe(foamOffset(uEdge, t));
    // 位置をわずかにずらしても跳ばない（連続なので差は小さい）
    expect(Math.abs(foamOffset(uEdge, t) - foamOffset(uEdge + 0.01, t))).toBeLessThan(0.05);
  });

  it('位相をずらすと別の場所に来る（引いた波が主線と重ならない）', () => {
    expect(foamOffset(96, 0.3)).not.toBeCloseTo(foamOffset(96, 0.3, Math.PI), 3);
  });
});

describe('shallowOffset', () => {
  it('時間を取らない＝岸の明るい縁は呼吸しない', () => {
    expect(shallowOffset(100)).toBe(shallowOffset(100));
    expect(shallowOffset.length).toBe(1);
  });

  it('常に水側に収まる', () => {
    for (let i = 0; i < 200; i++) {
      const off = shallowOffset(i * 4.7);
      expect(off).toBeGreaterThan(0);
      expect(off).toBeLessThan(TILE_PX / 2);
    }
  });
});

describe('advanceWaveTime', () => {
  it('通常は dt ぶん進む', () => {
    expect(advanceWaveTime(0, 0.5, false)).toBeCloseTo(0.5, 9);
  });

  it('reduced では時間が進まない（動きだけ止め、波の形は残す）', () => {
    let t = 0.4;
    for (let i = 0; i < 30; i++) t = advanceWaveTime(t, 1 / 60, true);
    expect(t).toBe(0.4);
  });

  it('周期で折り返して数値が育たない（長時間開いても精度が落ちない）', () => {
    let t = 0;
    for (let i = 0; i < 100000; i++) t = advanceWaveTime(t, 1 / 60, false);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(WAVE_PERIOD_SEC);
  });

  it('折り返しても波の形は連続（周期の整数倍で戻しているため）', () => {
    const before = foamOffset(64, WAVE_PERIOD_SEC - 0.01);
    const after = foamOffset(64, advanceWaveTime(WAVE_PERIOD_SEC - 0.01, 0.02, false));
    // 0.01秒ぶんしか進まないので、ほぼ同じ位置
    expect(Math.abs(before - after)).toBeLessThan(0.5);
  });
});
