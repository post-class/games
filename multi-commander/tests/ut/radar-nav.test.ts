import { describe, expect, it } from 'vitest';
import { radarPoint } from '../../src/hud/HudView';

/**
 * レーダー面への射影。
 *
 * 機体の点（円）と目的地マーカー（菱形）が同じ写し方を使うことを、
 * 関数を1本化したうえで固定する。別々に書くと片方だけ直して食い違うため。
 */
describe('レーダーの射影', () => {
  it('正面は中心に来る', () => {
    const p = radarPoint({ x: 0, y: 0, z: -1 });
    expect(p.x).toBeCloseTo(0, 5);
    expect(p.y).toBeCloseTo(0, 5);
  });

  it('真後ろは外周に来る', () => {
    const p = radarPoint({ x: 0, y: 0, z: 1 });
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(44, 5);
  });

  it('真横は外周の半分の距離に来る', () => {
    // 正面から90度なので、角度比で半径の半分
    const right = radarPoint({ x: 1, y: 0, z: 0 });
    expect(Math.hypot(right.x, right.y)).toBeCloseTo(22, 5);
  });

  it('右は右、左は左、上は上、下は下に出る', () => {
    // SVG は y が下向きなので、上方向は y が負になる
    expect(radarPoint({ x: 1, y: 0, z: 0 }).x).toBeGreaterThan(0);
    expect(radarPoint({ x: -1, y: 0, z: 0 }).x).toBeLessThan(0);
    expect(radarPoint({ x: 0, y: 1, z: 0 }).y).toBeLessThan(0);
    expect(radarPoint({ x: 0, y: -1, z: 0 }).y).toBeGreaterThan(0);
  });

  it('前方にあるほど中心へ寄る（遠い目的地が外周に張り付いても向きが読める）', () => {
    const near = Math.hypot(...Object.values(radarPoint({ x: 0.2, y: 0, z: -0.98 })));
    const side = Math.hypot(...Object.values(radarPoint({ x: 0.9, y: 0, z: -0.44 })));
    expect(near).toBeLessThan(side);
  });

  it('数値が壊れた入力でも NaN を返さない（丸め誤差で |z| が 1 を超えても落ちない）', () => {
    const p = radarPoint({ x: 0, y: 0, z: -1.0000001 });
    expect(Number.isNaN(p.x)).toBe(false);
    expect(Number.isNaN(p.y)).toBe(false);
  });
});
