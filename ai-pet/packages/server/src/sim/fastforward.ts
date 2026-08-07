/**
 * 圧縮シミュレーション（docs/02_ゲーム実装プラン/04_サーバ設計.md §6）
 *
 * サーバが止まっていた空白を埋める。通常の step() とは別実装で、
 *   - 時間・天気・資源・欲求は**実時間と同じ精度**で進める（位相がズレると決定論が崩れるため）
 *   - 移動と経路探索は行わない（見ていない間の見た目は誰も気にしない）
 *   - 採食は「歩いて食べに行った」ことにして島全体から最寄りの資源を消費する
 *   - 夜は寝ていたことにする（欲求の計算が現実的になる）
 *
 * 単位に注意:
 *   実時間1分 = 240tick、島の1時間 = 600tick（2.5実分）、島の1日 = 14400tick（60実分）。
 *   引数は**tick**で受ける。実時間との変換は offlineMsToTicks() を使う。
 */
import {
  MAX_FASTFORWARD_ISLAND_HOURS,
  MAP_H,
  MAP_W,
  NEEDS,
  TICKS_PER_ISLAND_HOUR,
  TICK_MS,
  type Actor,
} from '@ai-pet/shared';
import { relieveNeed, updateNeeds } from './needs.ts';
import { harvest, updateResources } from './resource.ts';
import type { IslandSim } from './island.ts';

/** 1粗ステップ = 240tick（実時間1分）。docs §6 の粒度 */
const TICKS_PER_COARSE = 240;
/** 早送りできるtick数の上限（24島時間 = 島の1日ぶん） */
export const MAX_FASTFORWARD_TICKS = MAX_FASTFORWARD_ISLAND_HOURS * TICKS_PER_ISLAND_HOUR;
/** この空腹を超えたら「食べに行った」ことにする */
const FEED_HUNGER_THRESHOLD = 45;
/** 1回の採食量（critter.ts の eatPortion と揃える） */
const FEED_PORTION = 1.5;
/** 圧縮中は歩いて探しに行ける前提なので、島全体を探索範囲にする */
const ISLAND_WIDE_RADIUS = Math.max(MAP_W, MAP_H);

export interface FastForwardResult {
  ticks: number;
  /** 進めた島時間 */
  islandHours: number;
  dayChanges: number;
  fed: number;
  clamped: boolean;
  elapsedMs: number;
}

/** 停止していた実時間（ms）を tick に換算する */
export function offlineMsToTicks(offlineMs: number): number {
  if (!Number.isFinite(offlineMs) || offlineMs <= 0) return 0;
  return Math.floor(offlineMs / TICK_MS);
}

/**
 * 指定tickぶん島時間を進める。
 * 上限は MAX_FASTFORWARD_TICKS（それ以上は「島は少し眠っていた」扱いで打ち切る）。
 */
export function fastForward(sim: IslandSim, ticks: number): FastForwardResult {
  const t0 = performance.now();
  const clamped = ticks > MAX_FASTFORWARD_TICKS;
  const total = Math.max(0, Math.min(MAX_FASTFORWARD_TICKS, Math.floor(ticks)));

  const world = sim.world;
  let dayChanges = 0;
  let fed = 0;
  let done = 0;

  while (done < total) {
    const chunk = Math.min(TICKS_PER_COARSE, total - done);
    let dayChanged = false;

    // 時計・資源・欲求はtick単位で進める（位相と量を実時間と一致させる）
    for (let i = 0; i < chunk; i++) {
      sim.tick++;
      const changed = sim.clock.advance(sim.tick);
      if (changed.dayChanged) dayChanged = true;
      updateResources(world, sim.tick, sim.clock);
      updateNeeds(world, sim.tick, sim.clock);
    }
    done += chunk;

    fed += coarseBehavior(sim, sim.clock.isNight(sim.tick));

    if (dayChanged) {
      dayChanges++;
      // 年齢・繁殖・寿命・餓死はここで処理される
      sim.relations.onIslandDay(sim.tick);
      // 留守中も日記は書かれる（「島の時間が進んでいた」ことの証拠になる）
      sim.notifyIslandDayEnd(sim.clock.islandDay - 1, sim.tick);
    }
    sim.events.flush();
  }

  return {
    ticks: total,
    islandHours: Math.round((total / TICKS_PER_ISLAND_HOUR) * 10) / 10,
    dayChanges,
    fed,
    clamped,
    elapsedMs: Math.round(performance.now() - t0),
  };
}

/**
 * 見ていない間の行動を粗く再現する。
 * 夜は寝かせ、腹が減っている個体は島のどこかで食べたことにする。
 */
function coarseBehavior(sim: IslandSim, isNight: boolean): number {
  const world = sim.world;
  let fed = 0;

  for (const a of world.actors.values()) {
    if (a.kind === 'player') continue;
    setCoarseAnim(a, isNight);

    if (a.needs.hunger < FEED_HUNGER_THRESHOLD) continue;
    // 夜間は食べに出ない（起きている個体だけ食べる）
    if (a.anim === 'sleep') continue;

    const node = world.findNearestResource(
      a.pos,
      ['berry_tree', 'field', 'fishing_spot'],
      ISLAND_WIDE_RADIUS,
      FEED_PORTION,
    );
    if (!node) continue;
    const got = harvest(world, node, FEED_PORTION, sim.tick);
    if (got <= 0) continue;
    relieveNeed(a, 'hunger', NEEDS.eatRelief * Math.min(1, got / FEED_PORTION));
    fed++;

    // 水も飲んだことにする（水場は実質枯れないので在庫だけ減らす）
    const waterNode = world.findNearestResource(a.pos, ['water'], ISLAND_WIDE_RADIUS);
    if (waterNode) harvest(world, waterNode, 1, sim.tick);
  }
  return fed;
}

/**
 * 夜は寝ている扱いにする。
 * updateNeeds は `anim === 'sleep'` を睡眠の唯一の判定にしているので、
 * ここを揃えないと「見ていない間ずっと寝不足だった」ことになってしまう。
 */
function setCoarseAnim(a: Actor, isNight: boolean): void {
  if (isNight) {
    a.anim = 'sleep';
    return;
  }
  if (a.anim === 'sleep') a.anim = 'idle';
}

/** 早送りの結果を人が読める1文にする（起動ログと留守中サマリに使う） */
export function describeFastForward(r: FastForwardResult): string {
  return (
    `${r.islandHours}島時間ぶん島の時間を進めました` +
    `（${r.dayChanges}日経過・採食${r.fed}回・${r.elapsedMs}ms${r.clamped ? '・上限で打ち切り' : ''}）`
  );
}
