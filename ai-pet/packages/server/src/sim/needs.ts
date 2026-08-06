/**
 * 欲求の増減（docs/02_ゲーム実装プラン/04_サーバ設計.md §4）
 *
 * 方針:
 * - 速度は「1島時間あたり」で constants.ts に持ち、ここで1tickぶんに割る
 * - 行動の選択は critter.ts。ここは「時間が経つと欲求が募る」だけを担当する
 * - 食べた・飲んだ・交流したの効果は呼び出し側が relieveNeed で適用する
 * - プレイヤーは欲求を持たない（0のまま触らない）
 *
 * 制約: Math.random() 禁止 / parameter property 禁止 / enum 禁止
 */
import { NEEDS, TICKS_PER_ISLAND_HOUR, TICK_SEC, type Actor, type Needs } from '@ai-pet/shared';
import type { WorldClock } from './clock.ts';
import type { IslandWorld } from './world.ts';

/** 1島時間の実秒数（tickSec を受け取る関数のために持つ） */
const ISLAND_HOUR_SEC = TICKS_PER_ISLAND_HOUR * TICK_SEC;

function clampNeed(v: number): number {
  return v < 0 ? 0 : v > 100 ? 100 : v;
}

function clampHealth(v: number): number {
  return v < 0 ? 0 : v > 100 ? 100 : v;
}

/** 1島時間あたりの量を1tickぶんにする */
function perTick(perIslandHour: number): number {
  return perIslandHour / TICKS_PER_ISLAND_HOUR;
}

/** traits（0..1）を 0.5 中心の倍率にする。factor=0.8 なら 0.6〜1.4倍 */
function traitScale(t: number, factor: number): number {
  return 1 + (t - 0.5) * factor;
}

/** 全アクターの欲求を進める。1tickぶん。ペットも対象、プレイヤーは対象外 */
export function updateNeeds(world: IslandWorld, tick: number, clock: WorldClock): void {
  const night = clock.isNight(tick);

  for (const actor of world.actors.values()) {
    if (actor.kind === 'player') continue;
    const n = actor.needs;
    const t = actor.traits;
    const sleeping = actor.anim === 'sleep';

    // 空腹: 大食いほど速い。寝ている間は代謝が落ちる
    let hunger = NEEDS.hungerPerIslandHour * traitScale(t.gluttony, NEEDS.hungerGluttonyFactor);
    if (sleeping) hunger *= NEEDS.sleepHungerMultiplier;
    n.hunger = clampNeed(n.hunger + perTick(hunger));

    if (sleeping) {
      // 寝ている間は眠気が増えず、減る
      applySleepRecovery(actor, TICK_SEC);
    } else {
      // energy が高い個体はへばりにくい。夜は眠気が加速する
      let sleep = NEEDS.sleepPerIslandHour * traitScale(1 - t.energy, NEEDS.sleepEnergyFactor);
      if (night) sleep *= NEEDS.sleepNightMultiplier;
      n.sleep = clampNeed(n.sleep + perTick(sleep));

      // 社交・好奇心は起きている間だけ募る
      const social = NEEDS.socialPerIslandHour * traitScale(t.sociability, NEEDS.socialSociabilityFactor);
      n.social = clampNeed(n.social + perTick(social));
      const curiosity = NEEDS.curiosityPerIslandHour * traitScale(t.curiosity, NEEDS.curiosityTraitFactor);
      n.curiosity = clampNeed(n.curiosity + perTick(curiosity));
    }

    // 安全欲を上げるのは critter.ts（脅威の検知）。ここでは時間で収まらせる
    n.safety = clampNeed(n.safety - perTick(NEEDS.safetyRecoverPerIslandHour));

    applyStarvation(actor, TICK_SEC);
  }
}

/** 欲求を満たす（採食・水飲み・交流などの効果適用）。0未満にはしない */
export function relieveNeed(actor: Actor, need: keyof Needs, amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  actor.needs[need] = clampNeed(actor.needs[need] - amount);
}

/** 睡眠中の回復（1tickぶん）。updateNeedsから呼ばれるが単体でも使える */
export function applySleepRecovery(actor: Actor, tickSec: number): void {
  const amount = (NEEDS.sleepReliefPerIslandHour * tickSec) / ISLAND_HOUR_SEC;
  actor.needs.sleep = clampNeed(actor.needs.sleep - amount);
}

/**
 * 空腹が限界を超え続けたときの健康ダメージ（1tickぶん）。死亡判定は relation.ts の担当。
 * 逆に空腹が落ち着いていれば健康は戻る（健康の増減を1箇所にまとめている）。
 */
export function applyStarvation(actor: Actor, tickSec: number): void {
  if (actor.needs.hunger >= NEEDS.starvationHunger) {
    const dmg = (NEEDS.starvationHealthPerIslandHour * tickSec) / ISLAND_HOUR_SEC;
    actor.health = clampHealth(actor.health - dmg);
    return;
  }
  if (actor.health < 100 && actor.needs.hunger < NEEDS.healthRecoverHungerBelow) {
    const heal = (NEEDS.healthRecoverPerIslandHour * tickSec) / ISLAND_HOUR_SEC;
    actor.health = clampHealth(actor.health + heal);
  }
}

/**
 * 0..1 に正規化した「切迫度」。低いうちは緩やかで、高いと急に上がる（ユーティリティAIが使う）。
 *
 * 意図: 「そこそこ空腹」では散歩や交流に負け、「限界間近」なら必ず採食が勝つようにしたい。
 * そのため前半は t^2.5 でほとんど伸ばさず、urgencyLateStart(0.6) から smoothstep を足して
 * 一気に立ち上げる。両項とも単調増加なので合成も単調増加。urgency(0)=0 / urgency(100)=1。
 */
export function urgency(value: number): number {
  const t = value <= 0 ? 0 : value >= 100 ? 1 : value / 100;
  const early = Math.pow(t, NEEDS.urgencyPow);
  const s = Math.min(1, Math.max(0, (t - NEEDS.urgencyLateStart) / (1 - NEEDS.urgencyLateStart)));
  const late = s * s * (3 - 2 * s);
  return (1 - NEEDS.urgencyLateWeight) * early + NEEDS.urgencyLateWeight * late;
}
