/**
 * LLMの予算・レート制限（docs/02_ゲーム実装プラン/07_ペットAI設計.md §7）
 *
 * 3つの制限をこの1クラスで見る:
 *   1. プレイヤー単位  1時間あたりの呼び出し回数（既定40 = env.llmMaxRphPerPlayer）
 *   2. 島単位          全用途あわせて1時間300回
 *   3. グローバル      同時実行8（セマフォ）。空きを待つのは queueWaitMs まで
 *
 * 原則:
 * - 「回数」はスライディングウィンドウ（直近1時間のタイムスタンプ列）で数える。
 *   固定ウィンドウだと境界でバーストできてしまうため
 * - 上限判定は**セマフォ待ちの前**に行う。待たせてから捨てるのは無駄
 * - `release()` の呼び忘れで同時実行枠が枯れないよう、呼び出し側（client.ts）で try/finally する。
 *   このクラス側でも release は冪等にしてある
 *
 * 制約:
 * - parameter property 禁止 / enum・namespace 禁止（Node の type-stripping で動かすため）
 */
import { LLM } from '@ai-pet/shared';
import type { LlmPurpose } from './client.ts';

export interface BudgetLimits {
  /** プレイヤーごとの1時間あたり上限 */
  perPlayerPerHour: number;
  /** 島全体の1時間あたり上限 */
  perIslandPerHour: number;
  /** 同時実行数 */
  maxConcurrent: number;
  /** 同時実行の空きを待つ最大時間。超えたら諦める */
  queueWaitMs: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  perPlayerPerHour: 40,
  perIslandPerHour: 300,
  maxConcurrent: LLM.maxConcurrent,
  queueWaitMs: 3000,
};

/** 1時間（ms） */
const WINDOW_MS = 60 * 60 * 1000;

export type BudgetReason = 'player_rate' | 'island_rate' | 'queue_timeout';

export type BudgetGrant =
  | { ok: true; release: () => void }
  | { ok: false; reason: BudgetReason };

interface Waiter {
  resolve: (granted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Budget {
  private limits: BudgetLimits;
  /** テストから時刻を注入できるようにしている（1時間経過の検証） */
  private now: () => number;

  /** プレイヤーIDごとの呼び出し時刻（直近1時間） */
  private perPlayer = new Map<string, number[]>();
  /** 島全体の呼び出し時刻（直近1時間） */
  private island: number[] = [];

  private inFlight = 0;
  private waiters: Waiter[] = [];

  private granted = 0;
  private rejected: Record<BudgetReason, number> = {
    player_rate: 0,
    island_rate: 0,
    queue_timeout: 0,
  };
  private byPurpose = new Map<LlmPurpose, number>();
  private peakInFlight = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(limits?: Partial<BudgetLimits>, now: () => number = () => Date.now()) {
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...(limits ?? {}) };
    this.now = now;
  }

  /**
   * 予算内なら acquire して true。**呼び出し後に必ず release() すること**。
   * 回数は acquire できた時点で1回として数える（失敗した呼び出しもコストになるため）。
   */
  async tryAcquire(purpose: LlmPurpose, playerId?: string): Promise<BudgetGrant> {
    const t = this.now();
    this.prune(t);

    if (playerId !== undefined) {
      const hits = this.perPlayer.get(playerId);
      if ((hits?.length ?? 0) >= this.limits.perPlayerPerHour) {
        this.rejected.player_rate++;
        return { ok: false, reason: 'player_rate' };
      }
    }
    if (this.island.length >= this.limits.perIslandPerHour) {
      this.rejected.island_rate++;
      return { ok: false, reason: 'island_rate' };
    }

    const got = await this.acquireSlot();
    if (!got) {
      this.rejected.queue_timeout++;
      return { ok: false, reason: 'queue_timeout' };
    }

    // 枠が取れてから計上する（キューで捨てた分は課金されないので数えない）
    const at = this.now();
    this.island.push(at);
    if (playerId !== undefined) {
      const hits = this.perPlayer.get(playerId);
      if (hits) hits.push(at);
      else this.perPlayer.set(playerId, [at]);
    }
    this.granted++;
    this.byPurpose.set(purpose, (this.byPurpose.get(purpose) ?? 0) + 1);

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return; // 二重解放でも枠が増えないようにする
        released = true;
        this.releaseSlot();
      },
    };
  }

  /** 残量（UI表示とメトリクス用）。playerId 省略時はプレイヤー枠を満額として返す */
  remaining(playerId?: string): { player: number; island: number } {
    const t = this.now();
    this.prune(t);
    const used = playerId === undefined ? 0 : (this.perPlayer.get(playerId)?.length ?? 0);
    return {
      player: Math.max(0, this.limits.perPlayerPerHour - used),
      island: Math.max(0, this.limits.perIslandPerHour - this.island.length),
    };
  }

  stats(): Record<string, unknown> {
    const t = this.now();
    this.prune(t);
    return {
      limits: { ...this.limits },
      islandUsedLastHour: this.island.length,
      players: this.perPlayer.size,
      inFlight: this.inFlight,
      queued: this.waiters.length,
      peakInFlight: this.peakInFlight,
      granted: this.granted,
      rejected: { ...this.rejected },
      byPurpose: Object.fromEntries(this.byPurpose),
    };
  }

  /** メトリクス用の軽い覗き見（health() から使う） */
  load(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.waiters.length };
  }

  // ---------- セマフォ ----------

  private acquireSlot(): Promise<boolean> {
    if (this.inFlight < this.limits.maxConcurrent) {
      this.inFlight++;
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          // 待ち行列から自分を外して諦める
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(false);
        }, this.limits.queueWaitMs),
      };
      this.waiters.push(waiter);
    });
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      // 枠は次の待ち人へそのまま引き継ぐ（inFlight は減らさない）
      clearTimeout(next.timer);
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
      next.resolve(true);
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  // ---------- スライディングウィンドウ ----------

  private prune(t: number): void {
    const from = t - WINDOW_MS;
    this.island = dropOlder(this.island, from);
    for (const [id, hits] of this.perPlayer) {
      const kept = dropOlder(hits, from);
      if (kept.length === 0) this.perPlayer.delete(id);
      else this.perPlayer.set(id, kept);
    }
  }
}

/** 昇順の時刻配列から from 以前を落とす。先頭から数えるだけなのでO(捨てる数) */
function dropOlder(arr: number[], from: number): number[] {
  let i = 0;
  while (i < arr.length) {
    const v = arr[i];
    if (v === undefined || v > from) break;
    i++;
  }
  return i === 0 ? arr : arr.slice(i);
}
