/**
 * 地形の模様の検証（T-M17-02）。
 *
 * ■ ここで守りたいこと
 *  1. **模様が無くても地形が塗られる**（`TILE_COLORS` に落ちる）
 *  2. 模様があるときも**塗りの回数がタイル種別の数を超えない**
 *     ―― 1 マス 1 回の `drawImage` にしてしまうと 4 万回になるので、
 *     「パターンで塗る」という設計が守られていることを回数で固定する
 *  3. パターンは**面ごとに 1 回だけ**作る（毎フレーム作り直さない）
 *  4. 名前の並びが `TILE_COLORS` とずれていない（ずれると地形が入れ替わる）
 */

import { describe, expect, it } from 'vitest';
import {
  TERRAIN_TEXTURE_NAMES,
  TINT_ALPHA,
  TerrainTextures,
  terrainFill,
  terrainTextureUrl,
  type PatternSource,
} from '@/render/terrainTextures';
import { TILE_COLORS } from '@/render/palette';
import { drawTerrainTiles } from '@/render/terrainLayer';
import { TILE_COUNT } from '@/sim/core/terrain';
import type { MapState } from '@/sim/core/world';
import type { Camera } from '@/render/iso';

/** `createPattern` を数える偽の面。 */
function fakeSource() {
  let created = 0;
  const source: PatternSource = {
    createPattern: () => {
      created++;
      return { fake: true } as unknown as CanvasPattern;
    },
  };
  return { source, created: () => created };
}

const FAKE_IMAGE = {} as CanvasImageSource;

describe('TerrainTextures', () => {
  it('画像を入れる前は模様が無い（色で塗る側に落ちる）', () => {
    const t = new TerrainTextures();
    expect(t.ready()).toBe(false);
    expect(t.loadedCount()).toBe(0);
    const { source } = fakeSource();
    expect(t.pattern(source, 0)).toBeNull();
  });

  it('画像を入れるとパターンが作られる', () => {
    const t = new TerrainTextures();
    t.setImage(0, FAKE_IMAGE);
    expect(t.ready()).toBe(true);
    const { source, created } = fakeSource();
    expect(t.pattern(source, 0)).not.toBeNull();
    expect(created()).toBe(1);
  });

  it('同じ面には 1 回だけ作る（毎フレーム作り直さない）', () => {
    const t = new TerrainTextures();
    t.setImage(0, FAKE_IMAGE);
    const { source, created } = fakeSource();
    for (let k = 0; k < 50; k++) t.pattern(source, 0);
    expect(created()).toBe(1);
  });

  it('別の面には別に作る（パターンは作った面に紐づく）', () => {
    const t = new TerrainTextures();
    t.setImage(0, FAKE_IMAGE);
    const a = fakeSource();
    const b = fakeSource();
    t.pattern(a.source, 0);
    t.pattern(b.source, 0);
    expect(a.created()).toBe(1);
    expect(b.created()).toBe(1);
  });

  it('範囲外のタイル種別は無視する（データが増えても壊れない）', () => {
    const t = new TerrainTextures();
    t.setImage(-1, FAKE_IMAGE);
    t.setImage(999, FAKE_IMAGE);
    expect(t.loadedCount()).toBe(0);
  });

  it('画像を外すと数が戻る', () => {
    const t = new TerrainTextures();
    t.setImage(1, FAKE_IMAGE);
    expect(t.loadedCount()).toBe(1);
    t.setImage(1, null);
    expect(t.loadedCount()).toBe(0);
  });
});

describe('terrainFill — 模様が無ければ色', () => {
  it('模様が無いときは色だけ（重ねる色は無し）', () => {
    const f = terrainFill(null, null, 0);
    expect(f.base).toBe(TILE_COLORS[0]);
    expect(f.tint).toBeNull();
  });

  it('模様があるときは模様 + 重ねる色', () => {
    const t = new TerrainTextures();
    t.setImage(3, FAKE_IMAGE);
    const { source } = fakeSource();
    const f = terrainFill(t, source, 3);
    expect(typeof f.base).toBe('object');
    expect(f.tint).toBe(TILE_COLORS[3]);
  });

  it('重ねる色の濃さは 0 と 1 の間（0 だと模様そのまま、1 だと色だけになる）', () => {
    expect(TINT_ALPHA).toBeGreaterThan(0);
    expect(TINT_ALPHA).toBeLessThan(1);
  });
});

describe('並びと URL', () => {
  it('模様の枚数はタイル種別の数と同じ（ずれると地形が入れ替わる）', () => {
    expect(TERRAIN_TEXTURE_NAMES).toHaveLength(TILE_COUNT);
    expect(TERRAIN_TEXTURE_NAMES).toHaveLength(TILE_COLORS.length);
  });

  it('名前が重複していない', () => {
    expect(new Set(TERRAIN_TEXTURE_NAMES).size).toBe(TERRAIN_TEXTURE_NAMES.length);
  });

  it('URL は assets/terrain/<name>.webp。範囲外は null', () => {
    expect(terrainTextureUrl(0)).toBe('assets/terrain/grass.webp');
    expect(terrainTextureUrl(99)).toBeNull();
  });
});

// ------------------------------------------------------------------ 塗りの回数

/** 全部同じ種別の小さなマップ。 */
function flatMap(size: number, tile: number): MapState {
  const tiles = new Uint8Array(size * size).fill(tile);
  return {
    widthTiles: size,
    heightTiles: size,
    tiles,
    mapType: 'plain',
    starts: new Int32Array(2),
    lawZones: new Uint8Array(0),
  } as unknown as MapState;
}

function camera(): Camera {
  return { cx: 8, cy: 8, zoom: 1, viewW: 800, viewH: 600 } as Camera;
}

/** 塗り回数を数える偽 ctx（`createPattern` も持つ）。 */
function countingCtx() {
  let fills = 0;
  const ctx = {
    fillStyle: '' as unknown,
    globalAlpha: 1,
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    fill: () => {
      fills++;
    },
    createPattern: () => ({}) as CanvasPattern,
  };
  return { ctx, fills: () => fills };
}

describe('drawTerrainTiles の塗りの回数', () => {
  it('模様が無いとき: タイル種別 1 つにつき 1 回', () => {
    const { ctx, fills } = countingCtx();
    const stats = drawTerrainTiles(
      ctx as unknown as Parameters<typeof drawTerrainTiles>[0],
      camera(),
      flatMap(16, 0),
    );
    expect(stats.tiles).toBeGreaterThan(0);
    expect(fills()).toBe(1);
    expect(stats.fills).toBe(1);
  });

  it('模様があるとき: 1 種別につき 2 回（模様 + 重ねる色）。**マス数に比例しない**', () => {
    const t = new TerrainTextures();
    t.setImage(0, FAKE_IMAGE);
    const small = countingCtx();
    const smallStats = drawTerrainTiles(
      small.ctx as unknown as Parameters<typeof drawTerrainTiles>[0],
      camera(),
      flatMap(16, 0),
      undefined,
      t,
    );
    const big = countingCtx();
    const bigStats = drawTerrainTiles(
      big.ctx as unknown as Parameters<typeof drawTerrainTiles>[0],
      camera(),
      flatMap(64, 0),
      undefined,
      t,
    );
    expect(small.fills()).toBe(2);
    // マスの数が増えても塗りの回数は変わらない（ここが設計の要点）
    expect(bigStats.tiles).toBeGreaterThan(smallStats.tiles);
    expect(big.fills()).toBe(2);
  });

  it('重ねたあと globalAlpha を元に戻す（次のレイヤに影響を残さない）', () => {
    const t = new TerrainTextures();
    t.setImage(0, FAKE_IMAGE);
    const { ctx } = countingCtx();
    ctx.globalAlpha = 1;
    drawTerrainTiles(
      ctx as unknown as Parameters<typeof drawTerrainTiles>[0],
      camera(),
      flatMap(16, 0),
      undefined,
      t,
    );
    expect(ctx.globalAlpha).toBe(1);
  });
});
