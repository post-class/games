/**
 * アクター（動物住民・ペット・プレイヤー）の生成（docs/02_ゲーム実装プラン/03_データモデル.md §2）
 *
 * ここは「生成と変換」だけを持つ。行動の判断は critter.ts / petActions.ts、
 * 移動は movement.ts が担当する。
 *
 * 制約:
 * - Math.random() 禁止（world.rng か引数の Rng を使う）
 * - parameter property / enum 禁止
 */
import {
  CRITTER_SPEED_BASE,
  PET_SPEED,
  PLAYER_SPEED,
  RELATION,
  Rng,
  encodeAnim,
  encodeFacing,
  q2,
  type Actor,
  type ActorWire,
  type Needs,
  type Traits,
  type Vec2,
} from '@ai-pet/shared';
import type { IslandWorld } from './world.ts';

/** 動物住民の種。アセット名と一致させる */
export const CRITTER_SPECIES: readonly string[] = ['rabbit', 'cat', 'bird', 'frog', 'squirrel', 'boar'];

/** 名前の素（かな2音を繋げて作る）。日本語の見た目を優先した固定プール */
const NAME_PARTS: readonly string[] = [
  'ぽこ',
  'もふ',
  'てん',
  'ころ',
  'しろ',
  'くろ',
  'ちゃ',
  'みる',
  'あん',
  'きな',
  'ゆき',
  'はな',
  'そら',
  'なつ',
];

/**
 * ペットは寿命で退場しない前提。ただし Actor 型が lifespanDays を必須にしているため
 * 実質到達しない大きな値を入れておく（Infinity は JSON 化できないので使わない）。
 */
const PET_LIFESPAN_DAYS = 3650;
const PLAYER_LIFESPAN_DAYS = 3650;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 0..1 の中央寄りな値（三角分布）。極端な性格が出過ぎないようにする */
function trait01(rng: Rng): number {
  return clamp01(0.5 + rng.noise() * 0.5);
}

export function randomTraits(rng: Rng): Traits {
  return {
    energy: trait01(rng),
    sociability: trait01(rng),
    caution: trait01(rng),
    gluttony: trait01(rng),
    curiosity: trait01(rng),
  };
}

/** 親の平均 ±0.1 のノイズ（docs 04章 §4 世代交代） */
export function inheritTraits(rng: Rng, a: Traits, b: Traits): Traits {
  const mix = (x: number, y: number): number => clamp01((x + y) / 2 + rng.noise() * 0.1);
  return {
    energy: mix(a.energy, b.energy),
    sociability: mix(a.sociability, b.sociability),
    caution: mix(a.caution, b.caution),
    gluttony: mix(a.gluttony, b.gluttony),
    curiosity: mix(a.curiosity, b.curiosity),
  };
}

/**
 * 動物・ペットの初期欲求。0=満たされている / 100=切迫。
 * 生まれた直後に全員が同時に空腹になると行動が同期して不自然なので、個体ごとにばらす。
 */
function initialNeeds(rng: Rng): Needs {
  return {
    hunger: Math.round(rng.range(10, 40)),
    sleep: Math.round(rng.range(5, 35)),
    social: Math.round(rng.range(10, 45)),
    safety: Math.round(rng.range(0, 15)),
    curiosity: Math.round(rng.range(10, 40)),
  };
}

function emptyNeeds(): Needs {
  return { hunger: 0, sleep: 0, social: 0, safety: 0, curiosity: 0 };
}

/** energy で速度に ±30% の個体差をつける（0でも止まらないようにする） */
function speedFrom(base: number, energy: number, spread: number): number {
  return base * (1 - spread + energy * spread * 2);
}

/** Partial<Traits> の undefined を無視してマージする（exactOptionalPropertyTypes:false 対策） */
function mergeTraits(base: Traits, over?: Partial<Traits>): Traits {
  if (!over) return base;
  const out: Traits = { ...base };
  for (const k of Object.keys(base) as (keyof Traits)[]) {
    const v = over[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clamp01(v);
  }
  return out;
}

function randomName(rng: Rng): string {
  return rng.pick(NAME_PARTS) + rng.pick(NAME_PARTS);
}

export function createPlayerActor(world: IslandWorld, opts: { name: string; pos?: Vec2 }): Actor {
  const pos = opts.pos ?? world.spawn;
  const actor: Actor = {
    id: world.allocId(),
    kind: 'player',
    species: 'player_a',
    name: opts.name,
    pos: { x: pos.x, y: pos.y },
    facing: 's',
    speed: PLAYER_SPEED,
    anim: 'idle',
    needs: emptyNeeds(),
    // プレイヤーは traits を使わないが、共通処理から参照されるので中央値を入れる
    traits: { energy: 0.5, sociability: 0.5, caution: 0.5, gluttony: 0.5, curiosity: 0.5 },
    ageDays: 0,
    lifespanDays: PLAYER_LIFESPAN_DAYS,
    health: 100,
    action: null,
    path: null,
  };
  return world.addActor(actor);
}

export function createCritterActor(
  world: IslandWorld,
  opts: { species: string; pos: Vec2; ageDays?: number; traits?: Partial<Traits> },
): Actor {
  const rng = world.rng;
  const traits = mergeTraits(randomTraits(rng), opts.traits);
  const actor: Actor = {
    id: world.allocId(),
    kind: 'critter',
    species: opts.species,
    name: randomName(rng),
    pos: { x: opts.pos.x, y: opts.pos.y },
    facing: rng.pick(['n', 'e', 's', 'w'] as const),
    speed: speedFrom(CRITTER_SPEED_BASE, traits.energy, 0.3),
    anim: 'idle',
    needs: initialNeeds(rng),
    traits,
    ageDays: opts.ageDays ?? 0,
    lifespanDays: rng.int(RELATION.lifespanDaysMin, RELATION.lifespanDaysMax),
    health: 100,
    action: null,
    path: null,
  };
  return world.addActor(actor);
}

export function createPetActor(
  world: IslandWorld,
  opts: { species: string; name: string; ownerId: string; pos: Vec2 },
): Actor {
  const rng = world.rng;
  const traits = randomTraits(rng);
  const actor: Actor = {
    id: world.allocId(),
    kind: 'pet',
    species: opts.species,
    name: opts.name,
    pos: { x: opts.pos.x, y: opts.pos.y },
    facing: 's',
    // ペットはオーナーに付いていける速さが要る。個体差は小さめ（±15%）
    speed: speedFrom(PET_SPEED, traits.energy, 0.15),
    anim: 'idle',
    needs: initialNeeds(rng),
    traits,
    ageDays: 0,
    lifespanDays: PET_LIFESPAN_DAYS,
    health: 100,
    action: null,
    path: null,
    ownerId: opts.ownerId,
    affection: 50,
    intent: null,
  };
  return world.addActor(actor);
}

/** 0=critter 1=pet 2=player（protocol.ts の ActorWire.k） */
function kindCode(kind: Actor['kind']): 0 | 1 | 2 {
  return kind === 'critter' ? 0 : kind === 'pet' ? 1 : 2;
}

export function actorToWire(a: Actor): ActorWire {
  const w: ActorWire = {
    i: a.id,
    k: kindCode(a.kind),
    s: a.species,
    n: a.name,
    x: q2(a.pos.x),
    y: q2(a.pos.y),
    f: encodeFacing(a.facing),
    a: encodeAnim(a.anim),
  };
  if (a.ownerId !== undefined) w.o = a.ownerId;
  return w;
}
