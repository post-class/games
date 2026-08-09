/**
 * sim/core/rng.ts — 決定論乱数 xorshift128（実装手順書 §4.3）
 *
 * `Math.random()` は sim では禁止（§0.3）。乱数が必要な箇所は必ず World が持つ
 * ストリーム（`rngCombat` / `rngAi` / `rngMap`）を使う。
 * 用途ごとにストリームを分けるのは、戦闘の乱数消費回数が AI の乱数列を
 * ずらしてデシンクするのを防ぐため。
 *
 * すべての演算は uint32 の範囲で行い、`>>> 0` で符号なしに正規化する。
 */

import type { Fx } from './fx';
import { FX_SHIFT } from './fx';

/** xorshift128 の状態語数。 */
export const RNG_STATE_WORDS = 4;

/** 2^32。nextInt の棄却域計算で使う。 */
const TWO_POW_32 = 0x100000000;

/**
 * splitmix32。単一シードから状態 4 語を撒くために使う。
 * 相関のあるシード（0,1,2…）でも独立な列になるようにするための前処理。
 */
function splitmix32(state: number): { value: number; next: number } {
  let z = (state + 0x9e3779b9) >>> 0;
  let x = z;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  z = z >>> 0;
  return { value: x, next: z };
}

/**
 * xorshift128（Marsaglia 2003）。周期 2^128 - 1。
 *
 * 状態は `state`（Uint32Array(4)）として公開している。状態ハッシュ（`sim/hash.ts`）が
 * 読む必要があるため。**外から書き換えないこと**（デシンクの原因になる）。
 */
export class Rng {
  /** 内部状態。読み取り専用として扱う（hash とリプレイ保存のため公開）。 */
  readonly state: Uint32Array;

  constructor(seed: number) {
    this.state = new Uint32Array(RNG_STATE_WORDS);
    this.seed(seed);
  }

  /** シードを撒き直す。全 0 状態（xorshift が停止する）は避ける。 */
  seed(seed: number): void {
    let s = seed >>> 0;
    let allZero = true;
    for (let i = 0; i < RNG_STATE_WORDS; i++) {
      const r = splitmix32(s);
      s = r.next;
      this.state[i] = r.value >>> 0;
      if (this.state[i] !== 0) allZero = false;
    }
    if (allZero) this.state[0] = 0x9e3779b9;
  }

  /** 次の 32bit 符号なし整数。 */
  nextU32(): number {
    const s = this.state;
    let t = s[0]!;
    t = (t ^ (t << 11)) >>> 0;
    t = (t ^ (t >>> 8)) >>> 0;
    s[0] = s[1]!;
    s[1] = s[2]!;
    s[2] = s[3]!;
    let w = s[3]!;
    w = (w ^ (w >>> 19)) >>> 0;
    w = (w ^ t) >>> 0;
    s[3] = w;
    return w;
  }

  /**
   * 0 以上 maxExclusive 未満の整数。**モジュロバイアスを棄却法で除去済み**（T-M2-04）。
   * 2^32 を maxExclusive で割った余りの部分（= 偏りを生む上端）を捨てて引き直す。
   */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`Rng.nextInt: maxExclusive must be a positive integer (got ${maxExclusive})`);
    }
    if (maxExclusive === 1) return 0;
    // limit = 2^32 - (2^32 mod max)。r >= limit を棄却すれば一様になる。
    const limit = TWO_POW_32 - (TWO_POW_32 % maxExclusive);
    for (;;) {
      const r = this.nextU32();
      if (r < limit) return r % maxExclusive;
    }
  }

  /**
   * [0, FX_ONE) の Fx。FX_ONE = 2^8 なので上位 8bit をそのまま取れば一様。
   * 剰余を取らないのでモジュロバイアスは原理的に発生しない。
   */
  nextFx(): Fx {
    return this.nextU32() >>> (32 - FX_SHIFT);
  }

  /** min 以上 maxInclusive 以下の整数。 */
  nextRange(min: number, maxInclusive: number): number {
    if (maxInclusive < min) throw new Error('Rng.nextRange: maxInclusive < min');
    return min + this.nextInt(maxInclusive - min + 1);
  }

  /** 状態を含めた複製。分岐シミュレーション（AI の先読みなど）で使う。 */
  clone(): Rng {
    const r = new Rng(0);
    r.state.set(this.state);
    return r;
  }

  /** 状態を other にコピーする（リプレイ復元用）。 */
  copyFrom(other: Rng): void {
    this.state.set(other.state);
  }
}
