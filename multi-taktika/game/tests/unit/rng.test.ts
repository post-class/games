/**
 * T-M2-04: xorshift128（実装手順書 §4.3）
 *
 * 検証:
 *  - 同一シードで同一列（clone / copyFrom も含む）
 *  - `nextInt` にモジュロバイアスがない（統計テスト）
 *  - 用途別 3 ストリームが独立している（World 側）
 */

import { describe, expect, it } from 'vitest';
import { FX_ONE } from '@/sim/core/fx';
import { RNG_STATE_WORDS, Rng } from '@/sim/core/rng';
import { createWorld } from '@/sim/core/world';

/** カイ二乗統計量。自由度 k-1。 */
function chiSquare(counts: readonly number[], total: number): number {
  const expected = total / counts.length;
  let x = 0;
  for (const c of counts) {
    const d = c - expected;
    x += (d * d) / expected;
  }
  return x;
}

describe('T-M2-04: 同一シードで同一列', () => {
  it('同じシードなら列が完全一致する', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 10000; i++) {
      expect(a.nextU32()).toBe(b.nextU32());
    }
  });

  it('違うシードなら列が異なる', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let same = 0;
    for (let i = 0; i < 1000; i++) {
      if (a.nextU32() === b.nextU32()) same++;
    }
    expect(same).toBeLessThan(5);
  });

  it('隣接シード（0,1,2…）でも初手が偏らない', () => {
    const firsts = new Set<number>();
    for (let s = 0; s < 256; s++) firsts.add(new Rng(s).nextU32());
    expect(firsts.size).toBe(256);
  });

  it('シード 0 でも状態が全 0 にならない（列が停止しない）', () => {
    const r = new Rng(0);
    const vals = new Set<number>();
    for (let i = 0; i < 100; i++) vals.add(r.nextU32());
    expect(vals.size).toBeGreaterThan(90);
  });

  it('clone は以後の列が一致し、元に影響しない', () => {
    const a = new Rng(999);
    for (let i = 0; i < 37; i++) a.nextU32();
    const b = a.clone();
    expect(Array.from(b.state)).toEqual(Array.from(a.state));
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it('copyFrom で状態を復元できる（リプレイ用）', () => {
    const a = new Rng(7);
    for (let i = 0; i < 100; i++) a.nextU32();
    const snapshot = a.clone();
    const expected: number[] = [];
    for (let i = 0; i < 100; i++) expected.push(a.nextU32());
    a.copyFrom(snapshot);
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(expected[i]);
  });

  it('状態は 4 語の uint32', () => {
    const r = new Rng(42);
    expect(r.state.length).toBe(RNG_STATE_WORDS);
    for (let i = 0; i < 5000; i++) {
      const v = r.nextU32();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('T-M2-04: nextInt にモジュロバイアスがない', () => {
  it('範囲内に収まる', () => {
    const r = new Rng(5);
    for (const max of [1, 2, 3, 7, 100, 0xffff]) {
      for (let i = 0; i < 2000; i++) {
        const v = r.nextInt(max);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(max);
      }
    }
  });

  it('不正な引数は例外', () => {
    const r = new Rng(1);
    expect(() => r.nextInt(0)).toThrow();
    expect(() => r.nextInt(-1)).toThrow();
    expect(() => r.nextInt(1.5)).toThrow();
  });

  it('2 の冪でない max（3, 7, 10, 100）で一様（カイ二乗）', () => {
    // 2^32 は 3 でも 7 でも割り切れないので、棄却法が無いと上端が僅かに多くなる。
    // 有意水準 0.001 の上側棄却点を上回らないことを確認する。
    const cases: ReadonlyArray<{ max: number; n: number; crit: number }> = [
      { max: 3, n: 300000, crit: 13.82 }, // df=2
      { max: 7, n: 350000, crit: 22.46 }, // df=6
      { max: 10, n: 400000, crit: 27.88 }, // df=9
      { max: 100, n: 400000, crit: 149.45 }, // df=99
    ];
    for (const { max, n, crit } of cases) {
      const r = new Rng(0x1234abcd);
      const counts = new Array<number>(max).fill(0);
      for (let i = 0; i < n; i++) counts[r.nextInt(max)]! += 1;
      expect(chiSquare(counts, n)).toBeLessThan(crit);
    }
  });

  it('巨大な max（2^31 + 1 相当）でも上位ビットが偏らない', () => {
    // 棄却法が効いていないと、上位半分と下位半分の出現数に有意差が出る。
    const max = 0x60000000; // 2^32 / max = 2.66… → 剰余が大きく、バイアスが出やすい
    const r = new Rng(777);
    const buckets = new Array<number>(6).fill(0);
    const n = 300000;
    for (let i = 0; i < n; i++) {
      const v = r.nextInt(max);
      buckets[Math.floor((v / max) * 6)]! += 1;
    }
    expect(chiSquare(buckets, n)).toBeLessThan(20.52); // df=5, p=0.001
  });

  it('nextInt(1) は常に 0（棄却ループに入らない）', () => {
    const r = new Rng(3);
    for (let i = 0; i < 1000; i++) expect(r.nextInt(1)).toBe(0);
  });

  it('nextRange は両端を含む', () => {
    const r = new Rng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(r.nextRange(-2, 2));
    expect(Array.from(seen).sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);
  });
});

describe('nextFx', () => {
  it('[0, FX_ONE) に収まり一様（剰余を取らないので原理的に無バイアス）', () => {
    const r = new Rng(2024);
    const counts = new Array<number>(FX_ONE).fill(0);
    const n = 256 * 2000;
    for (let i = 0; i < n; i++) {
      const v = r.nextFx();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(FX_ONE);
      counts[v]! += 1;
    }
    expect(chiSquare(counts, n)).toBeLessThan(400); // df=255, p≈0.001 は約 331。余裕をみて 400
  });
});

describe('用途別 3 ストリームの分離（§4.3）', () => {
  it('rngCombat を消費しても rngAi / rngMap の列は変わらない', () => {
    const w1 = createWorld({ seed: 42, playerCount: 2, mapWidthTiles: 200, mapHeightTiles: 200 });
    const w2 = createWorld({ seed: 42, playerCount: 2, mapWidthTiles: 200, mapHeightTiles: 200 });

    // w1 だけ戦闘乱数を大量に消費する
    for (let i = 0; i < 1000; i++) w1.rngCombat.nextU32();

    for (let i = 0; i < 100; i++) {
      expect(w1.rngAi.nextU32()).toBe(w2.rngAi.nextU32());
      expect(w1.rngMap.nextU32()).toBe(w2.rngMap.nextU32());
    }
  });

  it('3 ストリームは同一シードでも別の列', () => {
    const w = createWorld({ seed: 7, playerCount: 1, mapWidthTiles: 200, mapHeightTiles: 200 });
    const a = w.rngCombat.nextU32();
    const b = w.rngAi.nextU32();
    const c = w.rngMap.nextU32();
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
