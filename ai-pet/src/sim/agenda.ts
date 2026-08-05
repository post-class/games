import { ACTION_DURATION_MS, type PetAction } from '../../shared/actions.js';
import type { Personality, TraitKey } from '../../shared/personality.js';
import type { Needs, PetView } from '../../shared/types.js';
import {
  findSpot,
  isNight,
  SPOTS,
  spotAppeal,
  zoneAt,
  zonePoint,
  type Spot,
} from '../../shared/world.js';

/**
 * ペットの自律行動（アジェンダ）。
 *
 * 以前は「その場で行動を抽選する」だけだったので、広いマップにしても
 * ペットは一箇所から動かないままだった。ここでは行動ではなく **行き先** を選ぶ。
 *
 *   1. スポットを重み付き抽選する（ニーズ・性格・時刻・目新しさ・距離）
 *   2. そこまで歩く（travel）
 *   3. 着いたらそのスポットの行動をする（act）。ときどき「発見」が起きる
 *   4. 1 に戻る
 *
 * LLM は待たない。ここは毎フレーム回る決定論的な計算で、
 * 乱数生成器を差し込めるのでテストできる。
 */

/** 目新しさが戻るまでの時間。直前に行った場所へ続けて行くと単調になる。 */
export const NOVELTY_MS = 150_000;

export interface SpotScore {
  spot: Spot;
  weight: number;
}

/**
 * 各スポットの魅力度。
 *
 * ニーズだけで決めると満たされたペットが動かなくなるので、
 * 性格由来の素点（base + traits）を必ず残してある。
 */
export function spotScores(
  needs: Needs,
  personality: Personality,
  hour: number,
  fromX: number,
  lastVisit: Record<string, number> = {},
  now = 0,
): SpotScore[] {
  const night = isNight(hour);
  const out: SpotScore[] = [];

  for (const spot of SPOTS) {
    let weight = spotAppeal(spot, needs, personality);
    if (weight <= 0) continue;

    // 昼だけ／夜だけの場所。完全に 0 にはせず、たまに現れる余地を残す。
    if (spot.time === 'night') weight *= night ? 2.2 : 0.08;
    if (spot.time === 'day') weight *= night ? 0.12 : 1.3;

    // 屋外は臆病な子ほど行きたがらない。夜の屋外はさらに苦手。
    const outdoor = !zoneAt(spot.x).indoor;
    if (outdoor) {
      const timid = personality.timid / 100;
      weight *= 1 - timid * 0.6;
      if (night) weight *= 1 - timid * 0.5;
    }

    // 直前に行った場所は魅力が落ちる（時間で戻る）。
    const since = now - (lastVisit[spot.id] ?? -NOVELTY_MS);
    if (since < NOVELTY_MS) weight *= 0.15 + 0.85 * (since / NOVELTY_MS);

    // 遠い場所ほど選ばれにくい。ただし完全には諦めない（元気な子は遠出する）。
    const distance = Math.abs(spot.x - fromX);
    const patience = 0.75 + (personality.energy / 100) * 0.6;
    weight *= Math.max(0.25, 1.15 - distance / patience);

    if (weight > 0) out.push({ spot, weight });
  }

  return out;
}

export function pickSpot(
  needs: Needs,
  personality: Personality,
  hour: number,
  fromX: number,
  lastVisit: Record<string, number> = {},
  now = 0,
  rand: () => number = Math.random,
): Spot {
  const list = spotScores(needs, personality, hour, fromX, lastVisit, now);
  if (!list.length) return SPOTS[0];
  const total = list.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rand() * total;
  for (const entry of list) {
    roll -= entry.weight;
    if (roll <= 0) return entry.spot;
  }
  return list[list.length - 1].spot;
}

/** スポットの行動から1つ選ぶ。元気な子は動きのある行動を選びやすい。 */
const LIVELY: ReadonlySet<PetAction> = new Set([
  'jump_joy',
  'play',
  'dance',
  'splash_puddle',
  'chase_butterfly',
  'climb_tree',
  'dig',
  'roll_around',
]);

export function pickSpotAction(
  spot: Spot,
  personality: Personality,
  rand: () => number = Math.random,
): PetAction {
  const weights = spot.actions.map((action) => {
    if (LIVELY.has(action)) return 0.4 + (personality.energy / 100) * 1.6;
    return 0.6 + (1 - personality.energy / 100) * 0.8;
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  let roll = rand() * total;
  for (let i = 0; i < spot.actions.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return spot.actions[i];
  }
  return spot.actions[0];
}

export type AgendaPhase = 'travel' | 'act';

export interface AgendaState {
  phase: AgendaPhase;
  action: PetAction;
  /** 行き先／滞在中のスポット。ぶらぶら歩いている間は null。 */
  spotId: string | null;
  /** act の終了時刻。travel では移動を諦める打ち切り時刻。 */
  until: number;
  /** 世界座標（0〜1）。 */
  x: number;
  /** 床の奥行き（0 = 奥、1 = 手前）。 */
  depth: number;
  targetX: number;
  targetDepth: number;
  facing: 1 | -1;
  /** スポットごとの最終滞在時刻。目新しさの計算に使う。 */
  lastVisit: Record<string, number>;
}

/** たまごが待っている場所（リビングのラグの上）。 */
const EGG_X = zonePoint('living', 0.78);

export function initialAgenda(now: number): AgendaState {
  const start = findSpot('rug');
  return {
    phase: 'act',
    action: 'idle',
    spotId: start?.id ?? null,
    until: now + 2500,
    x: start?.x ?? EGG_X,
    depth: start?.depth ?? 0.8,
    targetX: start?.x ?? EGG_X,
    targetDepth: start?.depth ?? 0.8,
    facing: 1,
    lastVisit: {},
  };
}

/** 目標に着いたと見なす距離。 */
const ARRIVE_X = 0.006;
const ARRIVE_DEPTH = 0.04;

/** 移動速度（世界座標／ms）。世界を端から端まで 35〜60 秒で歩く速さ。 */
function speedOf(personality: Personality, energy: number): number {
  const vigor = 0.55 + (personality.energy / 100) * 0.6 + (energy / 100) * 0.35;
  return 0.0000165 * vigor;
}

export interface AgendaEvent {
  spotId: string | null;
  action: PetAction;
  /** そのスポットで起きた小さな発見（なければ null）。 */
  find: string | null;
}

export interface AgendaUpdate {
  state: AgendaState;
  /** この更新で行動が切り替わったか。 */
  changed: boolean;
  /** 新しく滞在を始めたときだけ入る。ログ・LLM のきっかけに使う。 */
  event: AgendaEvent | null;
}

/** ぶらぶら歩きに入る確率。用が済んだのにすぐ次の目的地へ向かうと機械的に見える。 */
const WANDER_CHANCE = 0.22;

const WANDER_ACTIONS: PetAction[] = ['idle', 'stretch', 'sing', 'daydream', 'roll_around'];

function beginTravelToSpot(
  state: AgendaState,
  spot: Spot,
  now: number,
  rand: () => number,
): AgendaState {
  return {
    ...state,
    phase: 'travel',
    action: 'walk',
    spotId: spot.id,
    // 同じ場所に何匹も重ならないよう、少しだけずらして立つ。
    targetX: spot.x + (rand() - 0.5) * 0.012,
    targetDepth: Math.max(0.05, Math.min(0.95, spot.depth + (rand() - 0.5) * 0.12)),
    until: now + 90_000,
  };
}

function beginWander(state: AgendaState, now: number, rand: () => number): AgendaState {
  const drift = (rand() - 0.5) * 0.18;
  return {
    ...state,
    phase: 'travel',
    action: 'walk',
    spotId: null,
    targetX: Math.max(0.01, Math.min(0.99, state.x + drift)),
    targetDepth: Math.max(0.05, Math.min(0.95, state.depth + (rand() - 0.5) * 0.3)),
    until: now + 20_000,
  };
}

function beginAct(
  state: AgendaState,
  now: number,
  rand: () => number,
  personality: Personality,
): { state: AgendaState; event: AgendaEvent } {
  const spot = state.spotId ? findSpot(state.spotId) : undefined;
  const action = spot
    ? pickSpotAction(spot, personality, rand)
    : WANDER_ACTIONS[Math.floor(rand() * WANDER_ACTIONS.length) % WANDER_ACTIONS.length];
  const finds = spot?.finds ?? [];
  // 毎回発見が出ると「作り物」になるので、半分くらいに間引く。
  const find = finds.length && rand() < 0.5 ? finds[Math.floor(rand() * finds.length) % finds.length] : null;

  const next: AgendaState = {
    ...state,
    phase: 'act',
    action,
    until: now + ACTION_DURATION_MS[action] * (0.8 + rand() * 0.7),
    lastVisit: spot ? { ...state.lastVisit, [spot.id]: now } : state.lastVisit,
  };
  return { state: next, event: { spotId: spot?.id ?? null, action, find } };
}

export function updateAgenda(
  state: AgendaState,
  pet: PetView,
  now: number,
  deltaMs: number,
  rand: () => number = Math.random,
): AgendaUpdate {
  // たまごは動かない。ラグの上で揺れて待っている。
  if (pet.stage === 'egg') {
    return {
      state: { ...state, phase: 'act', action: 'idle', x: EGG_X, targetX: EGG_X, spotId: 'rug' },
      changed: false,
      event: null,
    };
  }

  let next = { ...state };
  let changed = false;
  let event: AgendaEvent | null = null;

  if (next.phase === 'travel') {
    const speed = speedOf(pet.personality, pet.needs.energy) * deltaMs;
    const dx = next.targetX - next.x;
    const dd = next.targetDepth - next.depth;
    if (Math.abs(dx) > ARRIVE_X) {
      next.x += Math.sign(dx) * Math.min(Math.abs(dx), speed);
      next.facing = dx > 0 ? 1 : -1;
    }
    if (Math.abs(dd) > ARRIVE_DEPTH) {
      // 奥行きは横移動より短い距離なので、同じ時間で着くよう速めに詰める。
      next.depth += Math.sign(dd) * Math.min(Math.abs(dd), speed * 2.4);
    }
    const arrived = Math.abs(next.targetX - next.x) <= ARRIVE_X;
    if (arrived || now >= next.until) {
      const begun = beginAct(next, now, rand, pet.personality);
      next = begun.state;
      event = begun.event;
      changed = true;
    }
    return { state: next, changed, event };
  }

  // 滞在中。時間が来たら次の行き先を決める。
  if (now >= next.until) {
    if (rand() < WANDER_CHANCE) {
      next = beginWander(next, now, rand);
    } else {
      const hour = new Date(now).getHours();
      const spot = pickSpot(
        pet.needs,
        pet.personality,
        hour,
        next.x,
        next.lastVisit,
        now,
        rand,
      );
      // すでにそこに居るなら歩かずにもう一度滞在する（行ったり来たりを防ぐ）。
      if (Math.abs(spot.x - next.x) <= ARRIVE_X * 3 && spot.id === next.spotId) {
        const begun = beginAct({ ...next, spotId: spot.id }, now, rand, pet.personality);
        next = begun.state;
        event = begun.event;
      } else {
        next = beginTravelToSpot(next, spot, now, rand);
      }
    }
    changed = true;
  }

  return { state: next, changed, event };
}

/**
 * 外部（世話・LLM の思いつき・ミニゲーム）から行動を差し込む。
 * 行き先の途中でも、その場でいまの行動を上書きする。
 */
export function forceAction(state: AgendaState, action: PetAction, now: number): AgendaState {
  return {
    ...state,
    phase: 'act',
    action,
    until: now + ACTION_DURATION_MS[action],
    targetX: state.x,
    targetDepth: state.depth,
  };
}

/** いまペットが居るゾーン。HUD の「いまどこにいるか」表示に使う。 */
export function currentZone(state: AgendaState) {
  return zoneAt(state.x);
}
