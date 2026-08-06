/**
 * seed付き擬似乱数。決定論シミュレーションの土台。
 * Math.random() はプロジェクト全体で使用禁止（テストとリプレイが不可能になるため）。
 */

/** 文字列から32bit seedを作る（FNV-1a） */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** xorshift128 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string) {
    const s = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
    // splitmix32 で初期状態を撹拌する（seedが小さくても偏らないように）
    let x = s === 0 ? 0x9e3779b9 : s;
    const next = () => {
      x = (x + 0x9e3779b9) | 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
  }

  /** 0..2^32-1 */
  nextUint(): number {
    let t = this.d;
    const s = this.a;
    this.d = this.c;
    this.c = this.b;
    this.b = s;
    t ^= t << 11;
    t ^= t >>> 8;
    this.a = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.a;
  }

  /** 0以上1未満 */
  next(): number {
    return this.nextUint() / 0x100000000;
  }

  /** min以上max未満のfloat */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** min以上max以下のint */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** 確率pでtrue */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick: empty array');
    return arr[Math.floor(this.next() * arr.length)] as T;
  }

  /** 重み付き抽選。weightsの合計は0より大きいこと */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return 0;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i] as number;
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /** 破壊的シャッフル（Fisher-Yates） */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i] as T;
      arr[i] = arr[j] as T;
      arr[j] = tmp;
    }
    return arr;
  }

  /** 平均0・おおよそ±1の範囲に収まるノイズ（三角分布） */
  noise(): number {
    return this.next() + this.next() - 1;
  }

  /** 状態の保存・復元（スナップショット用） */
  getState(): [number, number, number, number] {
    return [this.a, this.b, this.c, this.d];
  }

  setState(state: readonly [number, number, number, number]): void {
    this.a = state[0] >>> 0;
    this.b = state[1] >>> 0;
    this.c = state[2] >>> 0;
    this.d = state[3] >>> 0;
  }
}
