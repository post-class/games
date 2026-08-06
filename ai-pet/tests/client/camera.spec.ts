/**
 * render/camera.ts（Pixi非依存の座標変換・クランプ・デッドゾーン）
 */
import { describe, expect, it } from 'vitest';
import { MAP_H, MAP_W, TILE_PX } from '@ai-pet/shared';
import { Camera, ZOOM_STEPS } from '../../packages/client/src/render/camera.ts';

function makeCamera(): Camera {
  const c = new Camera({ viewW: 960, viewH: 540 });
  c.snapTo({ x: 64, y: 64 });
  return c;
}

describe('Camera: 座標変換', () => {
  it('worldToScreen / screenToWorld が往復する', () => {
    const c = makeCamera();
    for (const zoomIdx of [0, 1, 2]) {
      c.setZoomIndex(zoomIdx);
      for (const p of [
        { x: 64, y: 64 },
        { x: 60.25, y: 70.5 },
        { x: 80, y: 50 },
      ]) {
        const s = c.worldToScreen(p);
        const back = c.screenToWorld(s);
        expect(back.x).toBeCloseTo(p.x, 6);
        expect(back.y).toBeCloseTo(p.y, 6);
      }
    }
  });

  it('カメラ中心は画面中央に写る', () => {
    const c = makeCamera();
    const s = c.worldToScreen({ x: c.x, y: c.y });
    expect(s.x).toBeCloseTo(480, 6);
    expect(s.y).toBeCloseTo(270, 6);
  });

  it('containerX/Y は worldRoot に入れる変換と一致する', () => {
    const c = makeCamera();
    c.setZoomIndex(2);
    const world = { x: 70, y: 66 };
    const s = c.worldToScreen(world);
    expect(c.containerX + world.x * TILE_PX * c.zoom).toBeCloseTo(s.x, 6);
    expect(c.containerY + world.y * TILE_PX * c.zoom).toBeCloseTo(s.y, 6);
  });

  it('ズームが上がると同じワールド距離が広く写る', () => {
    const c = makeCamera();
    c.setZoomIndex(0);
    const a = c.worldToScreen({ x: 65, y: 64 }).x - c.worldToScreen({ x: 64, y: 64 }).x;
    c.setZoomIndex(2);
    const b = c.worldToScreen({ x: 65, y: 64 }).x - c.worldToScreen({ x: 64, y: 64 }).x;
    expect(b).toBeGreaterThan(a);
    expect(a).toBeCloseTo(TILE_PX * (ZOOM_STEPS[0] as number), 6);
  });
});

describe('Camera: ズーム段', () => {
  it('3段で止まる', () => {
    const c = makeCamera();
    c.setZoomIndex(0);
    c.stepZoom(-1);
    expect(c.zoom).toBe(ZOOM_STEPS[0]);
    c.stepZoom(1);
    c.stepZoom(1);
    c.stepZoom(1);
    c.stepZoom(1);
    expect(c.zoom).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  });

  it('dir=0 では動かない', () => {
    const c = makeCamera();
    const before = c.zoomIndex;
    c.stepZoom(0);
    expect(c.zoomIndex).toBe(before);
  });
});

describe('Camera: クランプ', () => {
  it('島の端を越えない', () => {
    const c = makeCamera();
    c.setZoomIndex(1);
    c.snapTo({ x: -100, y: -100 });
    const halfW = c.viewW / 2 / c.zoom / TILE_PX;
    const halfH = c.viewH / 2 / c.zoom / TILE_PX;
    expect(c.x).toBeCloseTo(halfW, 6);
    expect(c.y).toBeCloseTo(halfH, 6);

    c.snapTo({ x: 9999, y: 9999 });
    expect(c.x).toBeCloseTo(MAP_W - halfW, 6);
    expect(c.y).toBeCloseTo(MAP_H - halfH, 6);
  });

  it('画面内に島全体が収まるときは中央寄せ', () => {
    // 小さな島（16x16タイル）を大きな画面で見る
    const c = new Camera({ mapW: 16, mapH: 16, viewW: 1920, viewH: 1080 });
    c.snapTo({ x: 0, y: 0 });
    expect(c.x).toBe(8);
    expect(c.y).toBe(8);
  });

  it('可視矩形は画面サイズとズームから決まる', () => {
    const c = makeCamera();
    c.setZoomIndex(1);
    const r = c.visibleRect();
    expect(r.x1 - r.x0).toBeCloseTo(c.viewW / c.zoom / TILE_PX, 6);
    const m = c.visibleRect(16);
    expect(m.x0).toBeCloseTo(r.x0 - 16, 6);
  });
});

describe('Camera: デッドゾーン追従', () => {
  it('画面中央1/6の中では動かない', () => {
    const c = makeCamera();
    c.setZoomIndex(1);
    const before = { x: c.x, y: c.y };
    // デッドゾーンの半幅は 960/6/2 = 80px → ズーム1.0で 2.5タイル
    c.follow({ x: before.x + 2, y: before.y + 1 });
    expect(c.x).toBeCloseTo(before.x, 6);
    expect(c.y).toBeCloseTo(before.y, 6);
  });

  it('デッドゾーンを出たぶんだけ寄る（対象は縁に留まる）', () => {
    const c = makeCamera();
    c.setZoomIndex(1);
    const target = { x: c.x + 10, y: c.y };
    c.follow(target);
    const halfDeadPx = (c.viewW / 6) / 2;
    const s = c.worldToScreen(target);
    expect(s.x - c.viewW / 2).toBeCloseTo(halfDeadPx, 4);
    // 逆方向も同じ
    const target2 = { x: c.x - 10, y: c.y - 10 };
    c.follow(target2);
    const s2 = c.worldToScreen(target2);
    expect(s2.x - c.viewW / 2).toBeCloseTo(-halfDeadPx, 4);
    expect(s2.y - c.viewH / 2).toBeCloseTo(-((c.viewH / 6) / 2), 4);
  });

  it('追従してもクランプは効く', () => {
    const c = makeCamera();
    c.setZoomIndex(1);
    for (let i = 0; i < 200; i++) c.follow({ x: 0, y: 0 });
    const halfW = c.viewW / 2 / c.zoom / TILE_PX;
    expect(c.x).toBeCloseTo(halfW, 6);
    expect(c.x).toBeGreaterThan(0);
  });

  it('resize すると可視範囲とクランプが更新される', () => {
    const c = makeCamera();
    c.resize(400, 300);
    expect(c.viewW).toBe(400);
    const s = c.worldToScreen({ x: c.x, y: c.y });
    expect(s.x).toBeCloseTo(200, 6);
  });
});
