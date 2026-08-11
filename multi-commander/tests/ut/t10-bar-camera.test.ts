import { describe, expect, it } from 'vitest';
import {
  BAR_ZOOM_MAX,
  barCameraCss,
  barCameraPair,
  barCameraTransform,
  barCameraWide,
  barFocusOrder,
  barNextFocus,
  type BarSpot,
} from '../../src/ui/barCamera';
import { BAR_SPOTS } from '../../src/ui/BarScene';

/**
 * 酒場のカメラ（`src/ui/barCamera.ts`）の計算テスト。
 *
 * カメラは CSS transition で動かすので見た目は単体テストで検証できない。
 * 代わりに「どこへ寄るか」の計算をここで固定する。
 */

/** 1280×720 のときの stage の実寸（会話ボックスとメニューを引いた残り） */
const VIEW = { w: 1280, h: 385 };

describe('酒場のカメラ', () => {
  it('引いた状態は等倍で原点', () => {
    expect(barCameraWide()).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it('注目点が画面の anchor に来る（縁に当たらない席で）', () => {
    // 中央付近の席なら clamp が効かないので、式どおりの位置になる
    const spot: BarSpot = { x: 50, bottom: 20, height: 50 };
    const t = barCameraTransform(spot, VIEW, { scale: 1.85, anchorX: 0.5, anchorY: 0.44 });
    const px = (VIEW.w * spot.x) / 100;
    const py = (VIEW.h * (100 - (spot.bottom + spot.height * 0.82))) / 100;
    // 変換後の注目点 = tx + scale * px
    expect(t.tx + t.scale * px).toBeCloseTo(VIEW.w * 0.5, 3);
    expect(t.ty + t.scale * py).toBeCloseTo(VIEW.h * 0.44, 3);
  });

  it('部屋の縁より外を見せない（tx / ty が範囲内）', () => {
    for (const spot of Object.values(BAR_SPOTS)) {
      for (const scale of [1, 1.25, 1.85, 2.4]) {
        const t = barCameraTransform(spot, VIEW, { scale });
        expect(t.tx).toBeLessThanOrEqual(0);
        expect(t.ty).toBeLessThanOrEqual(0);
        expect(t.tx).toBeGreaterThanOrEqual(VIEW.w - t.scale * VIEW.w - 1e-6);
        expect(t.ty).toBeGreaterThanOrEqual(VIEW.h - t.scale * VIEW.h - 1e-6);
      }
    }
  });

  it('倍率は 1..BAR_ZOOM_MAX に収まる（立ち絵の原寸を超えて拡大しない）', () => {
    const spot: BarSpot = { x: 50, bottom: 10, height: 70 };
    expect(barCameraTransform(spot, VIEW, { scale: 99 }).scale).toBe(BAR_ZOOM_MAX);
    expect(barCameraTransform(spot, VIEW, { scale: 0.2 }).scale).toBe(1);
    expect(BAR_ZOOM_MAX).toBeLessThanOrEqual(2.4);
  });

  it('等倍では平行移動しない（引いた状態と一致する）', () => {
    for (const spot of Object.values(BAR_SPOTS)) {
      expect(barCameraTransform(spot, VIEW, { scale: 1 })).toEqual({ scale: 1, tx: 0, ty: 0 });
    }
  });

  it('掛け合いは2人の中点を見る', () => {
    const a: BarSpot = { x: 20, bottom: 10, height: 70 };
    const b: BarSpot = { x: 40, bottom: 10, height: 70 };
    const pair = barCameraPair(a, b, VIEW, 1.55);
    const mid = barCameraTransform({ x: 30, bottom: 10, height: 70 }, VIEW, {
      scale: 1.55,
      anchorX: 0.5,
    });
    expect(pair).toEqual(mid);
  });

  it('transform 文字列は translate → scale の順（transform-origin 0 0 と対）', () => {
    const css = barCameraCss({ scale: 1.85, tx: -100, ty: -50 });
    expect(css).toBe('translate(-100.0px, -50.0px) scale(1.850)');
    expect(css.indexOf('translate')).toBeLessThan(css.indexOf('scale'));
  });
});

describe('見回す順番', () => {
  it('画面の左から右へ並ぶ', () => {
    const order = barFocusOrder([
      { pilotId: 'counter-a', x: 76 },
      { pilotId: 'window-a', x: 8 },
      { pilotId: 'back', x: 39 },
    ]);
    expect(order).toEqual(['window-a', 'back', 'counter-a']);
  });

  it('同じ x は渡された順（左→右）を保つ', () => {
    const order = barFocusOrder([
      { pilotId: 'left', x: 40 },
      { pilotId: 'right', x: 40 },
    ]);
    expect(order).toEqual(['left', 'right']);
  });

  it('←→ で巡回し、端では反対側へ回る', () => {
    const order = ['a', 'b', 'c'];
    expect(barNextFocus(order, 'a', 1)).toBe('b');
    expect(barNextFocus(order, 'c', 1)).toBe('a');
    expect(barNextFocus(order, 'a', -1)).toBe('c');
    // 未選択なら向きに応じて端から
    expect(barNextFocus(order, undefined, 1)).toBe('a');
    expect(barNextFocus(order, undefined, -1)).toBe('c');
    // 席から消えた相手を渡されても落ちない
    expect(barNextFocus(order, 'zzz', 1)).toBe('a');
    expect(barNextFocus([], 'a', 1)).toBeUndefined();
  });
});
