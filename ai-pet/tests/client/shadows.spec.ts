/**
 * 接地影（D-1）とスタイルガイド §5 の数値が一致していることを見る。
 *
 * Pixi を読まない純粋関数（`ellipseFor`）だけを対象にしている。
 * 描画そのものは実機のスクリーンショットで確認する（影は「見て分かる」以外の判定が難しい）。
 */
import { describe, expect, it } from 'vitest';
import {
  SHADOW_ALPHA,
  SHADOW_ASPECT,
  SHADOW_COLOR,
  SHADOW_SLEEP_FLATTEN,
  SHADOW_WIDTH_RATIO,
  ellipseFor,
} from '../../packages/client/src/render/shadows.ts';
import { crowdOffset } from '../../packages/client/src/render/sprites.ts';

describe('D-1 接地影', () => {
  it('スタイルガイド §5 の値になっている', () => {
    expect(SHADOW_COLOR).toBe(0x4a3b2a); // --ink
    expect(SHADOW_ALPHA).toBeCloseTo(0.26); // 0.18 では実機で見えなかった
    expect(SHADOW_WIDTH_RATIO).toBeCloseTo(0.6);
    expect(SHADOW_ASPECT).toBeCloseTo(0.38);
  });

  it('幅は対象の 0.6 倍、縦横比は 0.38', () => {
    const e = ellipseFor(100, 200, 48, 1);
    expect(e.x).toBe(100);
    expect(e.y).toBe(200);
    expect(e.rx).toBeCloseTo((48 * 0.6) / 2); // 14.4
    expect(e.ry).toBeCloseTo(e.rx * 0.38);
  });

  it('大きい対象ほど影も大きい（いのししの1.3倍などに追従する）', () => {
    const small = ellipseFor(0, 0, 48, 1);
    const big = ellipseFor(0, 0, 48 * 1.3, 1);
    expect(big.rx).toBeGreaterThan(small.rx);
    expect(big.rx / small.rx).toBeCloseTo(1.3);
  });

  it('睡眠中は縦だけ潰れる（横幅は変わらない）', () => {
    const awake = ellipseFor(0, 0, 48, 1);
    const asleep = ellipseFor(0, 0, 48, SHADOW_SLEEP_FLATTEN);
    expect(asleep.rx).toBeCloseTo(awake.rx);
    expect(asleep.ry).toBeCloseTo(awake.ry * SHADOW_SLEEP_FLATTEN);
    expect(asleep.ry).toBeLessThan(awake.ry);
  });

  it('潰し係数は 0 より大きい（影が消えてしまわない）', () => {
    expect(SHADOW_SLEEP_FLATTEN).toBeGreaterThan(0);
    expect(SHADOW_SLEEP_FLATTEN).toBeLessThan(1);
  });
});

describe('D-7 団子のほぐし', () => {
  it('2体以下は動かさない（群れの位置をむやみに崩さない）', () => {
    expect(crowdOffset(0, 1)).toEqual({ dx: 0, dy: 0 });
    expect(crowdOffset(1, 2)).toEqual({ dx: 0, dy: 0 });
  });

  it('3体以上なら1体目以外をずらす', () => {
    expect(crowdOffset(0, 5)).toEqual({ dx: 0, dy: 0 });
    for (let i = 1; i < 5; i++) {
      const o = crowdOffset(i, 5);
      expect(Math.hypot(o.dx, o.dy)).toBeGreaterThan(0);
    }
  });

  it('ずらし量は 0.42タイル以内（当たり判定と見た目がずれすぎない）', () => {
    for (let total = 3; total <= 20; total++) {
      for (let i = 0; i < total; i++) {
        const o = crowdOffset(i, total);
        expect(Math.abs(o.dx)).toBeLessThanOrEqual(0.42 + 1e-9);
        expect(Math.abs(o.dy)).toBeLessThanOrEqual(0.42 + 1e-9);
      }
    }
  });

  it('同じ位置に重ならない（10体を互いに離す）', () => {
    const pts = Array.from({ length: 10 }, (_, i) => crowdOffset(i, 10));
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const pa = pts[a] as { dx: number; dy: number };
        const pb = pts[b] as { dx: number; dy: number };
        expect(Math.hypot(pa.dx - pb.dx, pa.dy - pb.dy)).toBeGreaterThan(0.02);
      }
    }
  });

  it('決定論（同じ引数なら同じ結果）', () => {
    for (let i = 0; i < 12; i++) expect(crowdOffset(3, 8)).toEqual(crowdOffset(3, 8));
  });
});
