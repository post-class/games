/**
 * render/interp.ts — tick 間補間（T-M5-03。手順書 §4.1 / §7.1）
 *
 * シムは 25 tick/秒（1 tick = 40ms）で、描画は 60fps。そのまま描くと
 * 1 マス動くたびに 2〜3 フレーム止まって見えるので、**前 tick の座標と
 * 今の座標を `alpha`（= acc / 40）で線形補間**して描く。
 *
 * `sim` に `prevX` / `prevY` の列を足すことはできない（決定論の状態を増やすと
 * ハッシュとリプレイの互換が壊れる。そもそも描画都合の列を World に持たせない）ので、
 * **描画層側にリングバッファを持つ**。
 *
 * 使い方（`src/main.ts`）:
 * ```ts
 * while (acc >= TICK_MS && steps < 5) {
 *   motion.capture(world);          // ★ stepWorld の「前」に退避
 *   stepWorld(world, cmds);
 *   acc -= TICK_MS; steps++;
 * }
 * renderer.draw(world, acc / TICK_MS);   // alpha
 * ```
 *
 * 決定論には一切関与しない（読むだけ）。ここで作った値を Command に混ぜないこと。
 */

import type { Entities } from '@/sim/core/entity';
import { FX_ONE } from '@/sim/core/fx';
import type { World } from '@/sim/core/world';

/**
 * 保持する過去スナップショットの枚数。
 *
 * 補間に必要なのは直前の 1 枚だけだが、
 *  - 1 フレームで複数 tick 進む（acc ループ）ときに「どれが直前か」を取り違えない
 *  - 将来 2 枚使う補間（速度推定・残像）に広げられる
 * ようにリングにしてある。2 枚あれば足りるので既定は 2。
 */
export const DEFAULT_MOTION_HISTORY = 2;

/** エンティティ座標のリングバッファ。 */
export class MotionBuffer {
  /** スナップショット枚数。 */
  readonly history: number;
  /** エンティティ容量（`Entities.capacity` と同じ）。 */
  readonly capacity: number;

  private readonly xs: Int32Array;
  private readonly ys: Int32Array;
  /** そのスロットに入っている座標の generation（再利用の検出用）。 */
  private readonly gens: Uint16Array;
  /** 1 = 有効なスナップショットが入っている。 */
  private readonly valid: Uint8Array;

  /** 次に書き込むスロット。 */
  private writeSlot = 0;
  /** 直近に書き込んだスロット（-1 = まだ 1 枚も無い）。 */
  private lastSlot = -1;
  /** 直近に capture した tick（デバッグ・テスト用）。 */
  private lastTick = -1;

  constructor(capacity: number, history: number = DEFAULT_MOTION_HISTORY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`MotionBuffer: capacity must be positive (got ${capacity})`);
    }
    if (!Number.isInteger(history) || history < 1) {
      throw new Error(`MotionBuffer: history must be >= 1 (got ${history})`);
    }
    this.capacity = capacity;
    this.history = history;
    this.xs = new Int32Array(capacity * history);
    this.ys = new Int32Array(capacity * history);
    this.gens = new Uint16Array(capacity * history);
    this.valid = new Uint8Array(capacity * history);
  }

  /** 何枚か記録済みか。 */
  hasSnapshot(): boolean {
    return this.lastSlot >= 0;
  }

  /** 直近 capture の tick。 */
  snapshotTick(): number {
    return this.lastTick;
  }

  /**
   * 今の座標を退避する。**`stepWorld` の直前に 1 回だけ**呼ぶ。
   * 生存していないスロットは無効化するので、index を再利用されても
   * 別のエンティティの座標から補間してしまうことはない。
   */
  capture(w: World): void {
    const e = w.entities;
    const slot = this.writeSlot;
    const base = slot * this.capacity;
    const n = e.highWater < this.capacity ? e.highWater : this.capacity;
    for (let i = 0; i < n; i++) {
      const o = base + i;
      if (e.alive[i] !== 1) {
        this.valid[o] = 0;
        continue;
      }
      this.xs[o] = e.x[i]!;
      this.ys[o] = e.y[i]!;
      this.gens[o] = e.generation[i]!;
      this.valid[o] = 1;
    }
    // highWater の外は前フレームの残りを無効化しておく（容量を跨いだ縮小は起きないが安全側）
    for (let i = n; i < this.capacity; i++) this.valid[base + i] = 0;

    this.lastSlot = slot;
    this.lastTick = w.tick;
    this.writeSlot = (slot + 1) % this.history;
  }

  /** 補間の基準になる過去座標があるか（generation 一致を含む）。 */
  hasPrev(e: Entities, i: number): boolean {
    if (this.lastSlot < 0 || i >= this.capacity) return false;
    const o = this.lastSlot * this.capacity + i;
    return this.valid[o] === 1 && this.gens[o] === e.generation[i];
  }

  /**
   * 補間後の X（**マス単位の小数**）。
   * 過去座標が無い（今 tick で生まれた / index を再利用された）ときは現在値を返す。
   */
  sampleX(e: Entities, i: number, alpha: number): number {
    const cur = e.x[i]! / FX_ONE;
    if (!this.hasPrev(e, i)) return cur;
    const prev = this.xs[this.lastSlot * this.capacity + i]! / FX_ONE;
    return prev + (cur - prev) * alpha;
  }

  /** 補間後の Y（マス単位の小数）。 */
  sampleY(e: Entities, i: number, alpha: number): number {
    const cur = e.y[i]! / FX_ONE;
    if (!this.hasPrev(e, i)) return cur;
    const prev = this.ys[this.lastSlot * this.capacity + i]! / FX_ONE;
    return prev + (cur - prev) * alpha;
  }

  /** すべて無効化する（試合を作り直したとき）。 */
  reset(): void {
    this.valid.fill(0);
    this.writeSlot = 0;
    this.lastSlot = -1;
    this.lastTick = -1;
  }
}
