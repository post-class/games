import { describe, it, expect } from 'vitest';
import {
  TILE_H,
  TILE_W,
  ZOOM_LEVELS,
  type Camera,
  drawOrderKey,
  lerp,
  screenToTile,
  stepZoom,
  tileToScreen,
  tileToWorld,
  visibleTileBounds,
  worldToTile,
} from '../../src/render/iso.js';

const cam = (over: Partial<Camera> = {}): Camera => ({
  cx: 100,
  cy: 100,
  zoom: 1,
  viewW: 1280,
  viewH: 720,
  ...over,
});

describe('T-M5-01 擬似アイソメ座標変換', () => {
  it('手順書 §7.1 の式どおり', () => {
    expect(tileToWorld(0, 0)).toEqual({ sx: 0, sy: 0 });
    expect(tileToWorld(1, 0)).toEqual({ sx: TILE_W / 2, sy: TILE_H / 2 });
    expect(tileToWorld(0, 1)).toEqual({ sx: -TILE_W / 2, sy: TILE_H / 2 });
    // x と y が同じだけ増えると真下に進む（菱形になっている証拠）
    expect(tileToWorld(3, 3)).toEqual({ sx: 0, sy: 3 * TILE_H });
  });

  it('worldToTile は tileToWorld の逆変換（全ズームで往復一致）', () => {
    for (const zoom of ZOOM_LEVELS) {
      for (const [x, y] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [37, 4],
        [199, 199],
        [12.5, 3.25],
      ] as const) {
        const w = tileToWorld(x, y, zoom);
        const t = worldToTile(w.sx, w.sy, zoom);
        expect(t.x).toBeCloseTo(x, 6);
        expect(t.y).toBeCloseTo(y, 6);
      }
    }
  });

  it('カメラ中央のマスは画面中央に来る', () => {
    const c = cam();
    const p = tileToScreen(c, c.cx, c.cy);
    expect(p.sx).toBeCloseTo(c.viewW / 2, 6);
    expect(p.sy).toBeCloseTo(c.viewH / 2, 6);
  });

  it('screenToTile は tileToScreen の逆変換（ズーム・カメラ位置を変えても）', () => {
    for (const zoom of ZOOM_LEVELS) {
      const c = cam({ zoom, cx: 63.5, cy: 12 });
      for (const [x, y] of [
        [63.5, 12],
        [0, 0],
        [120, 40],
      ] as const) {
        const s = tileToScreen(c, x, y);
        const t = screenToTile(c, s.sx, s.sy);
        expect(t.x).toBeCloseTo(x, 5);
        expect(t.y).toBeCloseTo(y, 5);
      }
    }
  });

  it('visibleTileBounds はマップ外に出ず、画面四隅を含む', () => {
    const c = cam({ cx: 5, cy: 5 });
    const b = visibleTileBounds(c, 200, 200);
    expect(b.x0).toBe(0);
    expect(b.y0).toBe(0);
    expect(b.x1).toBeLessThanOrEqual(199);
    expect(b.y1).toBeLessThanOrEqual(199);

    // 画面中央のマスは必ず範囲に入る
    expect(b.x0).toBeLessThanOrEqual(5);
    expect(b.x1).toBeGreaterThanOrEqual(5);

    // 引くほど見える範囲が広がる
    const wide = visibleTileBounds(cam({ cx: 100, cy: 100, zoom: 0.5 }), 400, 400);
    const near = visibleTileBounds(cam({ cx: 100, cy: 100, zoom: 1.5 }), 400, 400);
    expect(wide.x1 - wide.x0).toBeGreaterThan(near.x1 - near.x0);
  });

  it('drawOrderKey は sy 昇順、同値は EntityId 昇順（ちらつき防止）', () => {
    // 奥のものが先（小さいキー）
    expect(drawOrderKey(1, 1, 0)).toBeLessThan(drawOrderKey(2, 2, 0));
    // 同じ位置なら ID が小さい方が先 = 描画順が毎フレーム安定する
    expect(drawOrderKey(3, 3, 1)).toBeLessThan(drawOrderKey(3, 3, 2));
    // ID の差が位置の差を追い越さない
    expect(drawOrderKey(3, 3, 0xfffff)).toBeLessThan(drawOrderKey(3, 3.001, 0));
  });

  it('stepZoom は 4 段階を端で止まりながら移動する', () => {
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(0.5, 1)).toBe(0.75);
    expect(stepZoom(1.5, 1)).toBe(1.5);
    expect(stepZoom(1.0, -1)).toBe(0.75);
    // 段階外の値からでも最も近い段を基準に動く
    expect(stepZoom(0.9, 1)).toBe(1.5);
  });

  it('lerp は tick 間補間に使える', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });
});
