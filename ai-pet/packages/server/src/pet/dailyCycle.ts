/**
 * 島日の境界でまわす処理（docs/02_ゲーム実装プラン/07_ペットAI設計.md §3.4）
 *
 * - 全ペットの日記を書き、長期記憶（summary）を更新する
 * - 日記の気分（moodDelta）を懐き度に反映する
 * - 古い記憶を剪定する
 *
 * tickループを止めないため、日記は**非同期に投げるだけ**。
 * 島の1日は実時間60分なので、20秒かかる生成でも困らない。
 */
import type { Actor } from '@ai-pet/shared';
import type { PetRepo } from '../db/petRepo.ts';
import type { ReflectionService } from './reflection.ts';
import type { IslandWorld } from '../sim/world.ts';

export interface DailyCycleDeps {
  /** 島に居るすべてのペットのID（不在ぶんも含む） */
  allPetIds: () => number[];
  /** ペットのアクター（接続中のみ。懐き度の即時反映に使う） */
  petActorOf: (petId: number) => Actor | undefined;
  /** その島日にオーナーが島に来ていたか */
  ownerVisited: (petId: number) => boolean;
  /** 日記ができたらプレイヤーへ知らせる（接続中のみ） */
  onDiary?: (petId: number, diary: string, affection: number) => void;
}

export class DailyCycle {
  private reflection: ReflectionService;
  private repo: PetRepo;
  private world: IslandWorld;
  private deps: DailyCycleDeps;
  private lastDoneIslandDay = 0;
  private running = false;
  /** 早送りで複数島日を一気にまたいだとき、順番に処理する待ち行列 */
  private queue: { islandDay: number; tick: number }[] = [];
  private counters = { days: 0, diaries: 0, pruned: 0, errors: 0 };

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(reflection: ReflectionService, repo: PetRepo, world: IslandWorld, deps: DailyCycleDeps) {
    this.reflection = reflection;
    this.repo = repo;
    this.world = world;
    this.deps = deps;
  }

  /**
   * 島日が変わったときに呼ぶ。`endedIslandDay` は**終わった島日**。
   * 二重起動と再入は内部で防ぐ（ReflectionService 側にもDB単位のガードがある）。
   */
  onIslandDayEnd(endedIslandDay: number, tick: number): void {
    if (endedIslandDay <= this.lastDoneIslandDay) return;
    this.lastDoneIslandDay = endedIslandDay;
    // 走っている間に来た島日は捨てずに積む（早送りで数日ぶん来ることがある）
    this.queue.push({ islandDay: endedIslandDay, tick });
    if (this.running) return;
    void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (;;) {
        const next = this.queue.shift();
        if (!next) break;
        this.counters.days++;
        await this.run(next.islandDay, next.tick);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(islandDay: number, tick: number): Promise<void> {
    const ids = this.deps.allPetIds();
    for (const petId of ids) {
      try {
        const result = await this.reflection.writeDiary({
          petId,
          islandDay,
          tick,
          ownerVisited: this.deps.ownerVisited(petId),
        });
        this.counters.diaries++;

        // 気分の変化を懐き度に反映する（日記は「その日どう過ごしたか」の総括）
        const affection = this.applyMood(petId, result.moodDelta);
        this.counters.pruned += this.reflection.pruneOldMemories(petId, islandDay);

        if (result.errorKind !== 'written') {
          this.deps.onDiary?.(petId, result.diary, affection);
        }
      } catch (e) {
        // 1匹の失敗で他のペットの日記を止めない
        this.counters.errors++;
        console.error(`[daily] 日記の生成に失敗 pet=${petId}`, e);
      }
    }
  }

  /** moodDelta を懐き度へ。DBとメモリ上のアクター両方を更新する */
  private applyMood(petId: number, moodDelta: number): number {
    const row = this.repo.findPetById(petId);
    if (!row) return 0;
    const next = Math.max(0, Math.min(100, row.affection + moodDelta));
    if (next !== row.affection) {
      this.repo.updatePet(petId, { affection: next });
      const actor = this.deps.petActorOf(petId);
      if (actor) actor.affection = next;
    }
    return next;
  }

  stats(): Record<string, unknown> {
    return {
      ...this.counters,
      lastDoneIslandDay: this.lastDoneIslandDay,
      running: this.running,
      queued: this.queue.length,
    };
  }

  /** 復元時に「すでに書き終わっている島日」を教える（再起動で書き直さないため） */
  setLastDoneIslandDay(day: number): void {
    this.lastDoneIslandDay = Math.max(this.lastDoneIslandDay, day);
  }

  /** テストとメトリクス用 */
  worldRef(): IslandWorld {
    return this.world;
  }
}
