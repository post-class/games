/** 決定的な擬似乱数 (mulberry32)。テストとリプレイ性のため seed 可能にしている。 */
export class Rng {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  /** 種を差し替える (テストや決定的な再生のため) */
  setSeed(seed: number): void {
    this.state = seed >>> 0;
  }

  /** [0,1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min,max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** [-a,a] */
  signed(a = 1): number {
    return (this.next() * 2 - 1) * a;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** ゲーム全体で共有する乱数 (演出と AI の揺らぎ) */
export const rng = new Rng(Math.floor(Math.random() * 0xffffffff));

/** テストで結果を再現したいときに種を固定する */
export function reseed(seed: number): void {
  rng.setSeed(seed);
}
