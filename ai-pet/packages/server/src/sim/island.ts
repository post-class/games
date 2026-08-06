/**
 * 島シミュレーション本体（docs/02_ゲーム実装プラン/04_サーバ設計.md §1）
 *
 * 原則:
 * - 固定ステップ（TICK_HZ）。遅れは検出して詰める
 * - この中で await しない（LLMは別経路で非同期に走る）
 * - Math.random() を使わない。乱数は this.rng のみ
 *
 * M0時点では時計だけを進める。M1以降で地形・アクター・行動系を追加する。
 */
import { MAX_CATCHUP_STEPS, Rng, TICK_MS, TICK_SEC, type ClockState } from '@ai-pet/shared';
import { WorldClock } from './clock.ts';
import { generateIsland } from './worldgen.ts';
import { NavService } from './nav.ts';
import { updateMovement } from './movement.ts';
import type { IslandWorld } from './world.ts';

export interface SimMetrics {
  tick: number;
  tickMsP50: number;
  tickMsP95: number;
  tickOverrun: number;
  uptimeSec: number;
}

export class IslandSim {
  tick = 0;
  readonly rng: Rng;
  readonly clock: WorldClock;
  readonly world: IslandWorld;
  readonly nav: NavService;
  readonly seed: string;
  readonly islandId: string;
  /** 直前のstepで島時間の表示が変わったか（クライアントへclockを送る判断に使う） */
  clockChanged = false;

  private timer: NodeJS.Timeout | null = null;
  private accumulatorMs = 0;
  private lastMs = 0;
  private startedAtMs = Date.now();
  private tickDurations: number[] = [];
  private tickOverrun = 0;
  private readonly hooks: ((tick: number) => void)[] = [];

  constructor(opts: { islandId: string; seed: string }) {
    this.islandId = opts.islandId;
    this.seed = opts.seed;
    // 島の生成で乱数列を消費したあと、同じRngをシミュレーション本体でも使い続ける。
    // seedが同じなら生成も以降の進行も完全に再現される。
    this.world = generateIsland(opts.seed);
    this.rng = this.world.rng;
    this.clock = new WorldClock(this.rng);
    this.nav = new NavService(this.world);
  }

  /** 毎tickの最後に呼ばれる処理を登録する（ブロードキャストなど） */
  onTick(fn: (tick: number) => void): void {
    this.hooks.push(fn);
  }

  clockState(): ClockState {
    return this.clock.state(this.tick);
  }

  start(): void {
    if (this.timer) return;
    this.lastMs = performance.now();
    this.startedAtMs = Date.now();
    const loop = (): void => {
      const now = performance.now();
      this.accumulatorMs += now - this.lastMs;
      this.lastMs = now;

      let steps = 0;
      while (this.accumulatorMs >= TICK_MS && steps < MAX_CATCHUP_STEPS) {
        const t0 = performance.now();
        this.step();
        this.recordTickDuration(performance.now() - t0);
        this.accumulatorMs -= TICK_MS;
        steps++;
      }
      if (steps === MAX_CATCHUP_STEPS && this.accumulatorMs >= TICK_MS) {
        // 追いつけていない = 負荷過多。余剰を捨てて島時間のズレを止める
        this.accumulatorMs = 0;
        this.tickOverrun++;
      }

      const elapsed = performance.now() - now;
      this.timer = setTimeout(loop, Math.max(0, TICK_MS - elapsed));
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 1tick進める。順序が意味を持つので変更時は設計書を確認すること */
  step(): void {
    this.tick++;
    const changed = this.clock.advance(this.tick);
    this.clockChanged = changed.dayChanged || changed.weatherChanged;
    // M3: resources / needs / critterAI / petActions をここに入れる（navへの目的地要求もここ）
    this.nav.update(); // 経路を確定させてから動かす
    updateMovement(this.world, TICK_SEC);
    // M3: interactions / relations / events
    for (const hook of this.hooks) hook(this.tick);
  }

  private recordTickDuration(ms: number): void {
    this.tickDurations.push(ms);
    if (this.tickDurations.length > 512) this.tickDurations.shift();
  }

  metrics(): SimMetrics {
    const sorted = [...this.tickDurations].sort((a, b) => a - b);
    const at = (p: number): number =>
      sorted.length === 0 ? 0 : Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0) * 100) / 100;
    return {
      tick: this.tick,
      tickMsP50: at(0.5),
      tickMsP95: at(0.95),
      tickOverrun: this.tickOverrun,
      uptimeSec: Math.round((Date.now() - this.startedAtMs) / 1000),
    };
  }
}
