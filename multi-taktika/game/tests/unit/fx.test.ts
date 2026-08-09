/**
 * T-M2-01 / T-M2-02: 固定小数点 Fx（実装手順書 §4.2）
 *
 * 検証:
 *  - fxMul / fxDiv の丸めが **0 方向切り捨て**で統一されている（境界値・負数）
 *  - fxSqrt が 0〜10^6 の範囲で誤差 ≤ 1/256、かつ単調増加
 */

import { describe, expect, it } from 'vitest';
import {
  FX_HALF,
  FX_ONE,
  distSq,
  fx,
  fxAbs,
  fxClamp,
  fxDiv,
  fxFromInt,
  fxMax,
  fxMin,
  fxMul,
  fxSqrt,
  fxToInt,
  idiv,
  isqrt,
  withinRange,
} from '@/sim/core/fx';

/** -0 を +0 に正規化する（期待値の作成用）。 */
function norm(v: number): number {
  return v === 0 ? 0 : v;
}

describe('fx: 基本の変換', () => {
  it('FX_ONE は 256', () => {
    expect(FX_ONE).toBe(256);
    expect(FX_HALF).toBe(128);
  });

  it('fx() は実数を 1/256 単位に丸める', () => {
    expect(fx(1)).toBe(256);
    expect(fx(0.5)).toBe(128);
    expect(fx(-1.5)).toBe(-384);
    expect(fx(1 / 256)).toBe(1);
  });

  it('fxFromInt / fxToInt は往復する', () => {
    for (const n of [0, 1, 7, 200, 400, -1, -400]) {
      expect(fxToInt(fxFromInt(n))).toBe(n);
    }
  });

  it('fxToInt は 0 方向切り捨て', () => {
    expect(fxToInt(fx(1.9))).toBe(1);
    expect(fxToInt(fx(-1.9))).toBe(-1); // floor なら -2 になる
    expect(fxToInt(-1)).toBe(0);
  });
});

describe('T-M2-01: fxMul / fxDiv の丸めは 0 方向で統一', () => {
  it('正の値の積', () => {
    expect(fxMul(fx(2), fx(3))).toBe(fx(6));
    expect(fxMul(fx(1.5), fx(2))).toBe(fx(3));
    expect(fxMul(FX_ONE, FX_ONE)).toBe(FX_ONE);
    expect(fxMul(0, fx(123.5))).toBe(0);
  });

  it('負の値の積は 0 方向に切り捨てる（算術シフト = floor ではない）', () => {
    // -1 * 1 / 256 = -0.0039… → 0 方向切り捨てで 0。 (-1 >> 8) は -1 になってしまう。
    expect(fxMul(-1, 1)).toBe(0);
    expect(fxMul(1, -1)).toBe(0);
    expect(fxMul(-255, 1)).toBe(0);
    expect(fxMul(-256, 1)).toBe(-1);
    expect(fxMul(-257, 1)).toBe(-1);
    expect(fxMul(fx(-1.5), fx(2))).toBe(fx(-3));
  });

  it('結果に -0 が出ない（Object.is で +0 と等しい）', () => {
    // -0 は === では 0 と等しいが JSON.stringify や 1/x の符号で違いが出るため、
    // 状態に混ざるとハッシュ・比較の食い違いの種になる。
    expect(Object.is(fxMul(-1, 1), 0)).toBe(true);
    expect(Object.is(fxDiv(-1, fx(2)), 0)).toBe(true);
    expect(Object.is(idiv(-1, 2), 0)).toBe(true);
    expect(Object.is(fx(-0.001), 0)).toBe(true);
    expect(Object.is(fxToInt(-1), 0)).toBe(true);
    expect(Object.is(fxFromInt(-0.5), 0)).toBe(true);
  });

  it('積の丸めは Math.trunc と一致する（総当たり。-0 は +0 に正規化）', () => {
    for (let a = -600; a <= 600; a += 7) {
      for (let b = -600; b <= 600; b += 11) {
        expect(fxMul(a, b)).toBe(norm(Math.trunc((a * b) / FX_ONE)));
      }
    }
  });

  it('正の値の商', () => {
    expect(fxDiv(fx(6), fx(3))).toBe(fx(2));
    expect(fxDiv(fx(1), fx(3))).toBe(85); // 256/3 = 85.33 → 85
    expect(fxDiv(fx(1), fx(2))).toBe(FX_HALF);
  });

  it('負の値の商は 0 方向に切り捨てる', () => {
    expect(fxDiv(fx(-1), fx(3))).toBe(-85); // floor なら -86
    expect(fxDiv(fx(1), fx(-3))).toBe(-85);
    expect(fxDiv(fx(-1), fx(-3))).toBe(85);
    expect(fxDiv(-1, fx(2))).toBe(0);
  });

  it('商の丸めは Math.trunc と一致する（総当たり）', () => {
    for (let a = -600; a <= 600; a += 7) {
      for (let b = -600; b <= 600; b += 11) {
        if (b === 0) continue;
        expect(fxDiv(a, b)).toBe(norm(Math.trunc((a * FX_ONE) / b)));
      }
    }
  });

  it('fxMul / fxDiv / idiv の符号対称性: f(-a, b) === -f(a, b)', () => {
    for (let a = 1; a <= 5000; a += 37) {
      for (let b = 1; b <= 5000; b += 53) {
        expect(fxMul(-a, b)).toBe(norm(-fxMul(a, b)));
        expect(fxDiv(-a, b)).toBe(norm(-fxDiv(a, b)));
        expect(idiv(-a, b)).toBe(norm(-idiv(a, b)));
      }
    }
  });

  it('0 除算は例外', () => {
    expect(() => fxDiv(FX_ONE, 0)).toThrow();
    expect(() => idiv(1, 0)).toThrow();
  });
});

describe('T-M2-02: fxSqrt / isqrt', () => {
  it('isqrt は floor(sqrt(n))', () => {
    expect(isqrt(0)).toBe(0);
    expect(isqrt(1)).toBe(1);
    expect(isqrt(2)).toBe(1);
    expect(isqrt(3)).toBe(1);
    expect(isqrt(4)).toBe(2);
    expect(isqrt(8)).toBe(2);
    expect(isqrt(9)).toBe(3);
    expect(isqrt(-5)).toBe(0);
    for (let n = 0; n < 20000; n++) {
      const r = isqrt(n);
      expect(r * r).toBeLessThanOrEqual(n);
      expect((r + 1) * (r + 1)).toBeGreaterThan(n);
    }
  });

  it('平方数の境界で厳密（大きい値でも）', () => {
    for (const k of [255, 256, 257, 1000, 65535, 65536, 1000000, 16000000]) {
      expect(isqrt(k * k)).toBe(k);
      expect(isqrt(k * k - 1)).toBe(k - 1);
      expect(isqrt(k * k + 1)).toBe(k);
    }
  });

  it('fxSqrt(FX_ONE) は FX_ONE、fxSqrt(fx(4)) は fx(2)', () => {
    expect(fxSqrt(FX_ONE)).toBe(FX_ONE);
    expect(fxSqrt(fx(4))).toBe(fx(2));
    expect(fxSqrt(fx(9))).toBe(fx(3));
    expect(fxSqrt(0)).toBe(0);
    expect(fxSqrt(-1)).toBe(0);
  });

  it('実数 0〜10^6 の範囲で誤差 ≤ 1/256（切り捨てのみ）', () => {
    // Fx 値 a に対し fxSqrt(a) = floor(sqrt(a * 256))。
    // 真値 sqrt(a/256) * 256 との差が 0 以上 1 未満（= 1/256 未満）であることを確認する。
    const check = (a: number): void => {
      const got = fxSqrt(a);
      const truth = Math.sqrt(a / FX_ONE) * FX_ONE; // 期待値の算出はテスト側なので float 可
      const err = truth - got;
      expect(err).toBeGreaterThanOrEqual(0);
      expect(err).toBeLessThan(1);
    };
    // 小さい範囲は密に
    for (let a = 0; a <= 65536; a += 1) check(a);
    // 実数 10^6 まで（Fx で 2.56e8）を粗く
    const maxFx = 1000000 * FX_ONE;
    for (let a = 65536; a <= maxFx; a += 99991) check(a);
    check(maxFx);
  });

  it('単調増加（非減少）である', () => {
    let prev = fxSqrt(0);
    for (let a = 1; a <= 200000; a += 1) {
      const cur = fxSqrt(a);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
    const maxFx = 1000000 * FX_ONE;
    prev = fxSqrt(200000);
    for (let a = 200000; a <= maxFx; a += 65537) {
      const cur = fxSqrt(a);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('距離: 平方距離で比較する（fxSqrt を使わない）', () => {
  it('distSq は Fx² 単位', () => {
    expect(distSq(0, 0, fx(3), fx(4))).toBe(fx(5) * fx(5));
  });

  it('withinRange は境界を含む', () => {
    const r = fx(5);
    expect(withinRange(0, 0, fx(3), fx(4), r)).toBe(true); // ちょうど 5
    expect(withinRange(0, 0, fx(3), fx(4) + 1, r)).toBe(false);
    expect(withinRange(0, 0, 0, 0, 0)).toBe(true);
  });

  it('マップ最大サイズ（400 マス）でも 2^53 を超えない', () => {
    const far = fxFromInt(400);
    const d = distSq(0, 0, far, far);
    expect(d).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(d)).toBe(true);
  });
});

describe('補助関数', () => {
  it('fxAbs / fxMin / fxMax / fxClamp', () => {
    expect(fxAbs(-5)).toBe(5);
    expect(fxAbs(5)).toBe(5);
    expect(fxMin(1, 2)).toBe(1);
    expect(fxMax(1, 2)).toBe(2);
    expect(fxClamp(-1, 0, FX_ONE)).toBe(0);
    expect(fxClamp(FX_ONE + 1, 0, FX_ONE)).toBe(FX_ONE);
    expect(fxClamp(FX_HALF, 0, FX_ONE)).toBe(FX_HALF);
  });
});
