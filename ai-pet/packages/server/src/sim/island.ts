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
import { EventBus, textWeather } from './events.ts';
import { RelationSystem } from './relation.ts';
import { relieveNeed, updateNeeds, urgency } from './needs.ts';
import { harvest, isAvailable, updateResources } from './resource.ts';
import { CritterAI, setCritterDeps } from './critter.ts';
import { PetActions, type PetActionDeps } from './petAction.ts';
import { InteractSystem } from './interact.ts';
import { BuildSystem } from './build.ts';
import type { IslandWorld } from './world.ts';

const SEASON_LABEL: Record<string, string> = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };

function seasonLabel(season: string): string {
  return SEASON_LABEL[season] ?? season;
}

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
  readonly events: EventBus;
  readonly relations: RelationSystem;
  readonly critterAI: CritterAI;
  /** プレイヤーの収穫・水やり */
  readonly interact: InteractSystem;
  /** 設置物と共同建設 */
  readonly build: BuildSystem;
  /** 地形が変わったときに呼ばれる（チャンクの再送に使う） */
  private terrainHooks: ((tiles: { x: number; y: number }[]) => void)[] = [];
  /** プレイヤーの表示名を引く（建設の文面に使う）。hub から差し替える */
  private nameLookup: ((playerId: string) => string | undefined) | null = null;
  /** ペットの行動系。ペットが登場するM4以降で hub から注入される */
  private petActions: PetActions | null = null;
  readonly seed: string;
  readonly islandId: string;
  /** 直前のstepで島時間の表示が変わったか（クライアントへclockを送る判断に使う） */
  clockChanged = false;
  /** 島日が変わったときに呼ばれる（終わった島日を受ける）。日記の生成に使う */
  private dayEndHooks: ((endedIslandDay: number, tick: number) => void)[] = [];

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
    this.events = new EventBus(this.clock);
    this.relations = new RelationSystem(this.world, this.clock, this.events);
    // critter.ts は needs/resource を差し替え可能な継ぎ目経由で使う（実装順の都合）。
    // ここで本実装を注入しないと既定の簡易版のまま動くので、必ず先に呼ぶ。
    setCritterDeps({ urgency, relieveNeed, harvest, isAvailable });
    this.critterAI = new CritterAI(this.world, this.nav, this.clock);
    this.interact = new InteractSystem(this.world, this.clock, {
      emitEvent: (input) => this.events.emit(this.tick, input),
    });
    this.build = new BuildSystem(this.world, {
      emitEvent: (input) => this.events.emit(this.tick, input),
      onTerrainChanged: (tiles) => this.notifyTerrainChanged(tiles),
      nameOf: (playerId) => this.nameLookup?.(playerId) ?? playerId,
    });
  }

  /**
   * ペットの行動系をつなぐ。
   * オーナー（接続中プレイヤー）の情報が必要なので、外から注入する形にしている。
   */
  attachPets(deps: PetActionDeps): void {
    this.petActions = new PetActions(this.world, this.nav, this.clock, deps);
  }

  petStats(): Record<string, unknown> {
    return this.petActions?.stats() ?? { pets: 0 };
  }

  /** 地形が変わったときに呼ばれる処理を登録する（橋の完成でチャンクを再送する） */
  onTerrainChanged(fn: (tiles: { x: number; y: number }[]) => void): void {
    this.terrainHooks.push(fn);
  }

  private notifyTerrainChanged(tiles: { x: number; y: number }[]): void {
    // 通れるようになった直後は、進行中の経路が古い。周辺のアクターの経路を捨てる
    for (const a of this.world.actors.values()) {
      if (!a.path || a.path.length === 0) continue;
      const near = tiles.some((t) => Math.hypot(a.pos.x - t.x, a.pos.y - t.y) < 24);
      if (near) {
        a.path = null;
        this.nav.clear(a.id);
      }
    }
    for (const fn of this.terrainHooks) {
      try {
        fn(tiles);
      } catch (e) {
        console.error('[island] 地形変更の通知でエラー', e);
      }
    }
  }

  /** プレイヤー名の引き当てを差し替える（建設の文面に使う） */
  setNameLookup(fn: (playerId: string) => string | undefined): void {
    this.nameLookup = fn;
  }

  /** 毎tickの最後に呼ばれる処理を登録する（ブロードキャストなど） */
  onTick(fn: (tick: number) => void): void {
    this.hooks.push(fn);
  }

  /**
   * 島日の境界で呼ばれる処理を登録する。引数は**終わった島日**。
   * 早送り（fastforward）からも呼ばれる。
   */
  onIslandDayEnd(fn: (endedIslandDay: number, tick: number) => void): void {
    this.dayEndHooks.push(fn);
  }

  /** 島日の境界を通知する（step と fastForward の両方から使う） */
  notifyIslandDayEnd(endedIslandDay: number, tick: number): void {
    for (const fn of this.dayEndHooks) {
      try {
        fn(endedIslandDay, tick);
      } catch (e) {
        console.error('[island] 島日境界の処理でエラー', e);
      }
    }
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
    if (changed.dayChanged) this.notifyIslandDayEnd(this.clock.islandDay - 1, this.tick);
    if (changed.weatherChanged) {
      this.events.emit(this.tick, {
        kind: 'weather',
        text: textWeather(this.clock.weather, seasonLabel(this.clock.season)),
      });
    }
    updateResources(this.world, this.tick, this.clock);
    updateNeeds(this.world, this.tick, this.clock);
    // 行動の選択と完了処理（内部で resolveActions も呼ぶ）。M5でここに petActions が入る
    this.critterAI.update(this.tick);
    this.petActions?.update(this.tick);
    this.nav.update(); // 経路を確定させてから動かす
    updateMovement(this.world, TICK_SEC);
    // M3: interactions
    this.relations.update(this.tick);
    this.events.flush();
    for (const hook of this.hooks) hook(this.tick);
  }

  private recordTickDuration(ms: number): void {
    this.tickDurations.push(ms);
    if (this.tickDurations.length > 512) this.tickDurations.shift();
  }

  /**
   * 生態系の状態。バランス調整の主要な観測点（docs 04章§8）。
   * 「絶滅していないか」「食料が枯れていないか」「夜に寝ているか」をここで見る。
   */
  ecologyMetrics(): Record<string, unknown> {
    const world = this.world;
    let sleeping = 0;
    let critters = 0;
    const byAction: Record<string, number> = {};
    for (const a of world.actors.values()) {
      if (a.kind !== 'critter') continue;
      critters++;
      if (a.anim === 'sleep') sleeping++;
      const k = a.action?.kind ?? 'none';
      byAction[k] = (byAction[k] ?? 0) + 1;
    }
    return {
      islandDay: this.clock.islandDay,
      season: this.clock.season,
      weather: this.clock.weather,
      timeOfDay: this.clock.state(this.tick).timeOfDay,
      critters,
      sleepingRatio: critters === 0 ? 0 : Math.round((sleeping / critters) * 100) / 100,
      actions: byAction,
      resourceTotal: Math.round(world.totalResourceAmount()),
      decayedTileRatio: Math.round(world.decayedTileRatio() * 1000) / 1000,
      relations: this.relations.stats(),
      events: this.events.stats(),
      critterAI: this.critterAI.stats(),
    };
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
