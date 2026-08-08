/**
 * 動物住民のユーティリティAI（docs/02_ゲーム実装プラン/04_サーバ設計.md §4）
 *
 * このゲームの中核。「住民が本当に自律している」ように見せるための判断機構。
 * LLMは使わず、候補行動を全部スコアリングして最大のものを選ぶ。
 *
 * 方針:
 * - スコアは「欲求の切迫度 × 距離の減衰 × traits × 時間帯 × 天気 × 季節 × 荒廃度」の掛け算。
 *   加算は原則使わない（要素が増えても効き方が読めるので）。例外は夜のsleepだけ（後述）。
 * - ヒステリシス（現在の行動に +WEIGHTS.hysteresis）で行動のちらつきを防ぐ
 * - 再評価は time slicing（id % 8 === tick % 8）で1個体あたり2秒ごと。移動は movement.ts が毎tick
 * - 経路は自前で探さず nav.request() に投げる（1tick8件制限があるので発行数に予算を持つ）
 *
 * 制約: Math.random() 禁止 / parameter property 禁止 / enum 禁止 / 相対importは .ts 込み
 */
import {
  CRITTER_WEIGHTS,
  MAP_H,
  MAP_W,
  NEEDS,
  RESOURCE,
  TICKS_PER_ISLAND_HOUR,
  type Actor,
  type ActionKind,
  type ActiveAction,
  type EntityId,
  type Needs,
  type Nest,
  type ResourceNode,
  type ResourceType,
  type Season,
  type Terrain,
  type TimeOfDay,
  type Vec2,
  type Weather,
} from '@ai-pet/shared';
import { ISLAND_OWNER } from './build.ts';
import type { WorldClock } from './clock.ts';
import type { NavService } from './nav.ts';
import { distance, type IslandWorld } from './world.ts';

// ---------------------------------------------------------------------------
// 重み
// ---------------------------------------------------------------------------

/**
 * 行動選択の重みは `shared/constants.ts` の `CRITTER_WEIGHTS` に移した（D-7）。
 * ここでは短い別名を置くだけ（本文の `W.` / `WEIGHTS.` を書き換えずに済ませる）。
 */
const WEIGHTS = CRITTER_WEIGHTS;

/** 木の下に集まる先とみなす地形 */
const SHELTER_TERRAINS: readonly Terrain[] = ['forest'];
/** 魚を獲る種（うさぎが釣りをすると変なので絞る） */
const FISHER_SPECIES: ReadonlySet<string> = new Set(['cat', 'bird', 'frog']);
/** 大型で他個体に恐れられる種 */
const BIG_SPECIES: ReadonlySet<string> = new Set(['boar']);

const FOOD_TYPES_LAND: readonly ResourceType[] = ['berry_tree', 'field'];
const FOOD_TYPES_FISHER: readonly ResourceType[] = ['berry_tree', 'field', 'fishing_spot'];
const WATER_TYPES: readonly ResourceType[] = ['water'];

// ---------------------------------------------------------------------------
// needs.ts / resource.ts への依存（差し替え可能な継ぎ目）
// ---------------------------------------------------------------------------

/**
 * needs.ts / resource.ts の関数。
 *
 * 実装時点でこの2ファイルが未作成だったため、static import すると
 * typecheck もテストも動かせなかった。そこで「同じ意味の既定実装」を持ちつつ
 * 差し替えられる継ぎ目にしている。
 *
 * 結合時は island.ts で1回だけ:
 *   import { relieveNeed, urgency } from './needs.ts';
 *   import { harvest, isAvailable } from './resource.ts';
 *   setCritterDeps({ urgency, relieveNeed, harvest, isAvailable });
 * を呼べば本実装に切り替わる（既定実装は以降使われない）。
 */
export interface CritterDeps {
  urgency(value: number): number;
  relieveNeed(actor: Actor, need: keyof Needs, amount: number): void;
  harvest(world: IslandWorld, node: ResourceNode, want: number, tick: number): number;
  isAvailable(node: ResourceNode): boolean;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * 既定の urgency。constants.ts の NEEDS.urgencyPow / urgencyLateStart / urgencyLateWeight を
 * 使うので、needs.ts の本実装と数値がズレにくい。
 * 0.5あたりまでは t^pow で緩く、lateStart(0.6) を超えると smoothstep が立ち上がって急になる。
 */
function defaultUrgency(value: number): number {
  const t = clamp01(value / 100);
  const early = Math.pow(t, NEEDS.urgencyPow);
  const late = smoothstep((t - NEEDS.urgencyLateStart) / (1 - NEEDS.urgencyLateStart));
  const w = NEEDS.urgencyLateWeight;
  return clamp01(early * (1 - w) + late * w);
}

function defaultRelieveNeed(actor: Actor, need: keyof Needs, amount: number): void {
  actor.needs[need] = Math.max(0, Math.min(100, actor.needs[need] - amount));
}

function defaultIsAvailable(node: ResourceNode): boolean {
  return node.amount > 0;
}

function defaultHarvest(world: IslandWorld, node: ResourceNode, want: number, _tick: number): number {
  const got = Math.max(0, Math.min(want, node.amount));
  node.amount -= got;
  if (got > 0 && node.type !== 'water') {
    world.addDecay(Math.floor(node.pos.x), Math.floor(node.pos.y), RESOURCE.decayPerHarvest);
  }
  return got;
}

let deps: CritterDeps = {
  urgency: defaultUrgency,
  relieveNeed: defaultRelieveNeed,
  harvest: defaultHarvest,
  isAvailable: defaultIsAvailable,
};

/** needs.ts / resource.ts の本実装を注入する（結合時に island.ts から1回呼ぶ） */
export function setCritterDeps(overrides: Partial<CritterDeps>): void {
  deps = { ...deps, ...overrides };
}

/** テストとデバッグ用 */
export function critterDeps(): CritterDeps {
  return deps;
}

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

/** 距離の減衰。0で1、scaleで0.5、遠いほど0に近づく */
export function falloff(dist: number, scale: number): number {
  const d = dist > 0 ? dist : 0;
  return scale / (scale + d);
}

/** 決定論ハッシュ（0..1）。rng を消費せずに個体ごとの散らばりを作る */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (b + 0x165667b1), 0xc2b2ae35);
  h ^= h >>> 15;
  return (h >>> 0) / 0x1_0000_0000;
}

/**
 * 密集の割引（D-7）。目的地の周りに既にいる数でスコアを下げる。
 *
 * `near`（`actorsNear` の結果）を数え直すだけなので**世界の再走査をしない**
 * （`actorsNear` は全アクターの線形走査なので、候補ごとに呼ぶと tick 時間が候補数倍になる）。
 *
 * ⚠️ `free` 体までは割り引かない。つがい・小群は「群れ」であって団子ではない。
 * ⚠️ `floor` で下限を作る。0まで下げると密集地から全員が離れて交流が途切れ、繁殖が止まる。
 */
export function crowdFactor(near: readonly Actor[], pos: Vec2, exceptId?: EntityId): number {
  const c = WEIGHTS.crowd;
  const r2 = c.radius * c.radius;
  let n = 0;
  for (const a of near) {
    if (a.id === exceptId) continue;
    const dx = a.pos.x - pos.x;
    const dy = a.pos.y - pos.y;
    if (dx * dx + dy * dy <= r2) n++;
  }
  const over = n - c.free;
  if (over <= 0) return 1;
  return Math.max(c.floor, 1 - over * c.penaltyPerActor);
}

/** 荒れたタイルは避ける */
function decayFactor(world: IslandWorld, pos: Vec2): number {
  const d = world.decayAt(Math.floor(pos.x), Math.floor(pos.y)) / RESOURCE.maxDecay;
  return 1 - clamp01(d) * WEIGHTS.decayAversion;
}

/** 屋外行動の天気補正 */
function outdoorWeather(weather: Weather): number {
  if (weather === 'rain') return WEIGHTS.weather.rainOutdoor;
  if (weather === 'fog') return WEIGHTS.weather.fogOutdoor;
  return 1;
}

/** その個体が周囲を見渡せる距離 */
export function searchRadius(actor: Actor, weather: Weather): number {
  const t = WEIGHTS.searchRadiusBase * (0.8 + actor.traits.curiosity * 0.4);
  return weather === 'fog' ? t * WEIGHTS.fogSearchScale : t;
}

function tileCenter(x: number, y: number): Vec2 {
  return { x: x + 0.5, y: y + 0.5 };
}

/**
 * 指定地形の最も近いタイル（中心座標）をリング探索で探す。
 * 見つからなければ null。半径を打ち切るので最悪でも (2r+1)^2 回の参照で済む。
 */
export function findNearestTerrainTile(
  world: IslandWorld,
  pos: Vec2,
  terrains: readonly Terrain[],
  maxRadius: number,
): Vec2 | null {
  const cx = Math.floor(pos.x);
  const cy = Math.floor(pos.y);
  for (let r = 0; r <= maxRadius; r++) {
    let best: Vec2 | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!world.isWalkableTile(x, y)) continue;
        if (!terrains.includes(world.terrainAt(x, y))) continue;
        const c = tileCenter(x, y);
        const d = (c.x - pos.x) * (c.x - pos.x) + (c.y - pos.y) * (c.y - pos.y);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 個体ごとの作業メモ（1tick内で使い捨てて良いものだけをモジュール側に持つ）
//
// ⚠️ 巣（nest）はここに置いていたが、再起動で全個体の寝床が失われるため
//    `Actor.nest` へ移した（C-3。M3申し送り4 / M5申し送り6）。
//    「消えても次の評価で作り直せるもの」だけを WeakMap に残す方針。
// ---------------------------------------------------------------------------

interface CritterMemo {
  /** 行動を発行したtick（移動の打ち切り判定に使う） */
  issuedAtTick: number;
  /** 目的地に着いたか。着いてから durationTicks を数える */
  arrived: boolean;
  /** 最後に nav へ要求したtick */
  lastNavTick: number;
  /** 森タイルのキャッシュ */
  shelter?: Vec2 | null;
  shelterTick?: number;
}

const memos = new WeakMap<Actor, CritterMemo>();

function memoOf(actor: Actor): CritterMemo {
  let m = memos.get(actor);
  if (!m) {
    m = { issuedAtTick: 0, arrived: false, lastNavTick: -9999 };
    memos.set(actor, m);
  }
  return m;
}

/** 森タイル（木の下）。1個体あたり shelterCacheTicks ごとにしか探索しない */
function shelterTileOf(world: IslandWorld, actor: Actor, tick: number): Vec2 | null {
  const m = memoOf(actor);
  if (m.shelterTick !== undefined && tick - m.shelterTick < WEIGHTS.shelterCacheTicks) {
    return m.shelter ?? null;
  }
  m.shelterTick = tick;
  m.shelter = findNearestTerrainTile(world, actor.pos, SHELTER_TERRAINS, WEIGHTS.shelterMaxRadius);
  return m.shelter;
}

/**
 * テスト・アクター退場時に呼ぶ（WeakMapなので必須ではないが明示できるように）。
 * 巣の設置物の掃除はここではしない（world を持っていないため）。
 * `syncNestPlaceables()` が持ち主のいない巣をまとめて片づける。
 */
export function forgetCritter(actor: Actor): void {
  memos.delete(actor);
}

// ---------------------------------------------------------------------------
// 巣（C-3）
// ---------------------------------------------------------------------------

/**
 * 巣の設置物の attract は **0**。
 * 人工物と同じ理由で、餌の無い場所に群れが通い続けて餓死する
 * （M3の長期シミュレーションで踏んだ罠）。巣は「作った本人の寝床」であって
 * 他個体を引き寄せる場所ではない。
 */
const NEST_ATTRACT = 0;

/** 巣の設置物の持ち主。プレイヤー扱いにすると `BuildSystem.remove()` で撤去されてしまう */
const NEST_OWNER = ISLAND_OWNER;

/** 巣として使えるタイルか（歩けること。設置物は歩行判定を変えないので陸の連結性には影響しない） */
function isNestableTile(world: IslandWorld, x: number, y: number): boolean {
  return world.isWalkableTile(x, y);
}

/** いま巣の設置物が乗っているタイル（`tileKey` の集合）。1回作って使い回す */
function occupiedNestTiles(world: IslandWorld, exceptPlaceableId: EntityId): Set<number> {
  const out = new Set<number>();
  for (const p of world.placeables.values()) {
    if (p.type !== 'nest' || p.id === exceptPlaceableId) continue;
    out.add(Math.floor(p.pos.y) * MAP_W + Math.floor(p.pos.x));
  }
  return out;
}

/**
 * 巣を置くタイルを決める。
 *
 * 素直に「行動の目的地タイル」へ置くと、同じ森タイルを寝床に選んだ個体ぶん
 * 巣が重なって1枚の絵に見えてしまう（`shelterTileOf` は最近傍を返すので実際に重なる）。
 * 空いているタイルへリング探索でずらす。rng は使わず走査順だけで決めるので決定論。
 */
function nestTileFor(world: IslandWorld, want: Vec2, exceptPlaceableId: EntityId): Vec2 {
  const occupied = occupiedNestTiles(world, exceptPlaceableId);
  const cx = Math.floor(want.x);
  const cy = Math.floor(want.y);
  for (let r = 0; r <= WEIGHTS.nestSpreadRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!isNestableTile(world, x, y)) continue;
        if (occupied.has(y * MAP_W + x)) continue;
        return tileCenter(x, y);
      }
    }
  }
  // 周り3タイルが全部巣で埋まっている密集地。重なりを許して元の場所に作る
  return tileCenter(cx, cy);
}

/**
 * 巣に対応する設置物が無ければ作る。作ったら true。
 * 復元直後（設置物だけ欠けたセーブ）や、設置物が先に消えた場合の自己修復にも使う。
 */
function ensureNestPlaceable(world: IslandWorld, actor: Actor): boolean {
  const nest = actor.nest;
  if (!nest) return false;
  if (nest.placeableId > 0 && world.placeables.has(nest.placeableId)) return false;
  const p = world.addPlaceable({
    id: world.allocId(),
    type: 'nest',
    pos: { x: nest.pos.x, y: nest.pos.y },
    ownerId: NEST_OWNER,
    attract: NEST_ATTRACT,
  });
  nest.placeableId = p.id;
  return true;
}

/**
 * 巣を作る（作り直す）。前の巣の設置物は捨てる。
 * 同じタイルに作り直したときは設置物を作り直さない（IDが増え続けるのを避ける）。
 */
export function setNest(world: IslandWorld, actor: Actor, want: Vec2, tick: number): Nest {
  const prev = actor.nest;
  const pos = nestTileFor(world, want, prev?.placeableId ?? 0);
  if (prev && Math.floor(prev.pos.x) === Math.floor(pos.x) && Math.floor(prev.pos.y) === Math.floor(pos.y)) {
    ensureNestPlaceable(world, actor);
    return prev;
  }
  if (prev && prev.placeableId > 0) world.placeables.delete(prev.placeableId);
  const nest: Nest = { pos, placeableId: 0, createdAtTick: tick };
  actor.nest = nest;
  ensureNestPlaceable(world, actor);
  return nest;
}

/** 巣を捨てる（設置物も消す）。テストと、巣を持ったまま退場させたい場合に使う */
export function abandonNest(world: IslandWorld, actor: Actor): void {
  const nest = actor.nest;
  if (!nest) return;
  if (nest.placeableId > 0) world.placeables.delete(nest.placeableId);
  delete actor.nest;
}

/**
 * 巣の設置物を世界の状態に合わせる。
 *
 * - 持ち主が居なくなった巣の設置物を消す（**これが無いと死んだ個体の巣が無限に溜まる**）
 * - `Actor.nest` はあるのに設置物が無いものを作る（再起動直後・古いセーブの補完）
 *
 * 結果として `nest` の設置物は「巣を持つ生きた動物の数」と常に一致する。
 */
export function syncNestPlaceables(world: IslandWorld): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const live = new Set<EntityId>();
  for (const a of world.actors.values()) {
    // 巣を作るのは動物だけ。ペット・プレイヤーが nest を持っていたら無効として扱う
    if (a.kind !== 'critter' || !a.nest) continue;
    if (ensureNestPlaceable(world, a)) added++;
    live.add(a.nest.placeableId);
  }
  for (const [id, p] of [...world.placeables]) {
    if (p.type !== 'nest' || live.has(id)) continue;
    world.placeables.delete(id);
    removed++;
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// 候補とスコアリング
// ---------------------------------------------------------------------------

export interface Candidate {
  kind: ActionKind;
  targetEntity?: EntityId;
  targetTile?: Vec2;
  score: number;
  /** デバッグ表示とテスト用。なぜこのスコアになったか */
  why?: string;
}

/** 行動選択の文脈（テストしやすくするため引数で渡す） */
export interface CritterContext {
  tick: number;
  clock: WorldClock;
  isNight: boolean;
}

function timeOfDayOf(ctx: CritterContext): TimeOfDay {
  return ctx.clock.state(ctx.tick).timeOfDay;
}

/** 1体ぶんの候補を全部スコアリングして返す（テストの主対象） */
export function scoreCandidates(world: IslandWorld, actor: Actor, ctx: CritterContext): Candidate[] {
  const out: Candidate[] = [];
  const u = deps.urgency;
  const needs = actor.needs;
  const traits = actor.traits;
  const clock = ctx.clock;
  const weather = clock.weather;
  const season: Season = clock.season;
  const tod = timeOfDayOf(ctx);
  const isNight = ctx.isNight;
  const radius = searchRadius(actor, weather);
  const outdoor = outdoorWeather(weather);
  const W = WEIGHTS;

  // 近傍のアクターは1回だけ走査して flee と socialize で共有する
  const near = world.actorsNear(actor.pos, W.nearRadius, actor.id);

  // ---- flee: 近くの脅威。ほぼ何にでも勝つので最初に見る ----
  for (const other of near) {
    const isPlayer = other.kind === 'player';
    const isBig = other.kind === 'critter' && BIG_SPECIES.has(other.species) && !BIG_SPECIES.has(actor.species);
    if (!isPlayer && !isBig) continue;
    // 寝ている相手は怖くない（寝ているいのししから逃げ続けるのは不自然だった）
    if (other.anim === 'sleep') continue;
    const range = isPlayer ? W.threat.playerRadius : W.threat.bigRadius;
    const d = distance(actor.pos, other.pos);
    if (d > range) continue;
    // 自分が寝ているときは、すぐ隣に来られない限り起きない（夜の睡眠率が落ちるのを防ぐ）
    if (actor.anim === 'sleep' && d > W.threat.wakeRadius) continue;
    const proximity = 1 - d / range; // 近いほど怖い（距離の減衰ではなく線形。至近距離で一気に効かせる）
    const caution = W.trait.cautionBase + traits.caution * W.trait.cautionSpan;
    const score = W.base.flee * caution * proximity * (1 + u(needs.safety) * 0.5);
    out.push({
      kind: 'flee',
      targetTile: fleeTileFrom(world, actor.pos, other.pos),
      score,
      why: `flee from ${other.id} d=${d.toFixed(1)} caution=${caution.toFixed(2)}`,
    });
    break; // near は距離順。最も近い脅威だけで十分
  }

  // ---- eat: 空腹 × 資源の近さ ----
  const foodTypes = FISHER_SPECIES.has(actor.species) ? FOOD_TYPES_FISHER : FOOD_TYPES_LAND;
  // 腹が減るほど遠くまで探しに行く。
  // 固定半径だと「近くの木を食べ尽くした群れが、20タイル先に食料があるのに餓死する」
  // という挙動になった（実測。島全体の資源は余っているのに死んでいた）。
  const foodRadius = radius * (1 + W.hungerSearchSpan * u(needs.hunger));
  // 1回ぶん食べられる量が残っている資源だけを狙う（空同然の木に群がって餓死しないように）
  const food = world.findNearestResource(actor.pos, foodTypes, foodRadius, W.eatPortion);
  if (food && deps.isAvailable(food)) {
    const d = distance(actor.pos, food.pos);
    const need = u(needs.hunger);
    const gl = W.trait.gluttonyBase + traits.gluttony * W.trait.gluttonySpan;
    const timeMul = isNight ? W.time.eatNight : tod === 'day' || tod === 'morning' ? W.time.eatDay : 1;
    const score =
      W.base.eat * need * falloff(d, W.distScale.eat) * gl * outdoor * timeMul * decayFactor(world, food.pos);
    out.push({
      kind: 'eat',
      targetEntity: food.id,
      score,
      why: `eat need=${need.toFixed(2)} d=${d.toFixed(1)} gluttony=${gl.toFixed(2)}`,
    });
  }

  // ---- drink: 渇き値は持たないので空腹の副次。夏は効きが強い ----
  //
  // ⚠️ **団子の最大の原因はここだった**（D-7。実測で団子になっている個体の約2/3が `drink`、砂浜の水際）。
  // 水場は島に20か所しかなく「実質枯れない」ので取り合いにならず、
  // 暇な個体まで水際に集まって立ち続けていた。効いたのは `drinkIdleNeed` を下げること。
  // 「空いている水場を選び直す」「目的地の手前に散らして立つ」も試したが**どちらも効果0だった**
  // （それぞれ clump 0.87 / 19.52。後者は逆に悪化した）ので入れていない。
  const water = world.findNearestResource(actor.pos, WATER_TYPES, radius);
  if (water && deps.isAvailable(water)) {
    const d = distance(actor.pos, water.pos);
    // 空腹0でも少しは水を飲みに行く
    const need = u(needs.hunger) * 0.5 + W.drinkIdleNeed;
    const wMul = weather === 'rain' ? W.weather.rainDrink : outdoor;
    const crowd = crowdFactor(near, water.pos);
    const score = W.base.drink * need * falloff(d, W.distScale.drink) * W.season.thirst[season] * wMul * crowd;
    out.push({
      kind: 'drink',
      targetEntity: water.id,
      score,
      why: `drink need=${need.toFixed(2)} d=${d.toFixed(1)} crowd=${crowd.toFixed(2)}`,
    });
  }

  // ---- sleep: 眠気 × 夜であること。雨なら木の下、巣があれば巣で ----
  {
    const need = u(needs.sleep);
    const energy = W.trait.sleepEnergyBase + traits.energy * W.trait.sleepEnergySpan;
    const timeMul = isNight ? W.time.sleepNight : tod === 'evening' ? W.time.sleepEvening : W.time.sleepDay;
    const bed = bedTileFor(world, actor, ctx, weather);
    // 寝床が遠くても「寝たい」気持ちは消えないので、距離の効きは 0.7〜1.0 に圧縮する
    const distMul = bed ? 0.7 + 0.3 * falloff(distance(actor.pos, bed), W.distScale.sleep) : 1;
    let score = W.base.sleep * need * energy * timeMul * distMul;
    // 夜だけの下駄。これが「夜はちゃんと寝る」の担保
    if (isNight) score += W.time.sleepNightFloor * (0.4 + need * 0.6);
    const cand: Candidate = { kind: 'sleep', score, why: `sleep need=${need.toFixed(2)} time=${tod}` };
    if (bed) cand.targetTile = bed;
    out.push(cand);
  }

  // ---- socialize: 社交欲 × 起きている相手の近さ ----
  {
    // 相手はいちばん近い起きている個体（near は距離順）。
    // ⚠️ 「近い数体の中からまわりが空いている相手を選ぶ」も試したが**団子が増えた**
    //    （実測 clump 8.98 → 13.20）。遠くの1体を目指して移動する個体が増え、
    //    移動の途中で別の群れを横切って合流してしまう。近所の相手を選ぶほうが散る。
    let partner: Actor | null = null;
    for (const other of near) {
      if (other.kind === 'player') continue;
      if (other.anim === 'sleep') continue;
      partner = other;
      break;
    }
    if (partner) {
      // ⚠️ 相手自身も数に入れる（除外すると実測で団子が増えた: clump 8.98 → 14.69）。
      // 「相手＋まわり」で混雑を測るのが、群れの大きさの感覚に合う
      const partnerCrowd = crowdFactor(near, partner.pos);
      const d = distance(actor.pos, partner.pos);
      const need = u(needs.social);
      const soc = W.trait.sociabilityBase + traits.sociability * W.trait.sociabilitySpan;
      const timeMul = isNight ? W.time.socialNight : tod === 'day' || tod === 'morning' ? W.time.socialDay : 1;
      // 広場は社交の場（ベンチの加点は goto 側で効く）
      const placeMul = world.terrainAt(Math.floor(actor.pos.x), Math.floor(actor.pos.y)) === 'plaza' ? 1.25 : 1;
      // 相手のまわりが既に混んでいたら割り引く（3体目以降が同じ塊へ吸い寄せられるのを止める）
      const crowd = partnerCrowd;
      const score =
        W.base.socialize * need * falloff(d, W.distScale.socialize) * soc * timeMul * outdoor * placeMul * crowd;
      out.push({
        kind: 'socialize',
        targetEntity: partner.id,
        score,
        why: `socialize need=${need.toFixed(2)} d=${d.toFixed(1)} soc=${soc.toFixed(2)} crowd=${crowd.toFixed(2)}`,
      });
    }
  }

  // ---- nest: 眠気＋安全欲。冬は巣ごもり、春は繁殖準備 ----
  {
    const shelter = shelterTileOf(world, actor, ctx.tick);
    const need = u(needs.sleep) * 0.6 + u(needs.safety) * 0.4;
    const caution = 0.6 + traits.caution * 0.6;
    const seasonMul = W.season.nest[season];
    const rainMul = weather === 'rain' ? W.weather.rainNest : 1;
    const target = shelter ?? tileCenter(Math.floor(actor.pos.x), Math.floor(actor.pos.y));
    const distMul = falloff(distance(actor.pos, target), W.distScale.nest);
    // 既に何体も居るタイルへ巣を作りに行かない（`nestTileFor` が設置物はずらすが、
    // 動物本体は目的地タイルに集まるので団子になる）
    const crowd = crowdFactor(near, target);
    const score =
      W.base.nest * need * caution * seasonMul * rainMul * distMul * decayFactor(world, target) * crowd;
    out.push({
      kind: 'nest',
      targetTile: target,
      score,
      why: `nest need=${need.toFixed(2)} season=${season} rain=${rainMul} crowd=${crowd.toFixed(2)}`,
    });
  }

  // ---- goto: 設置物の attract（ベンチを置くと動物が集まる。M7の要件） ----
  {
    let bestP: { id: EntityId; pos: Vec2; score: number } | null = null;
    for (const p of world.placeablesNear(actor.pos, radius)) {
      if (p.attract <= 0) continue;
      const d = distance(actor.pos, p.pos);
      const attract = Math.min(W.attractMax, p.attract / W.attractRef);
      const cur = W.trait.curiosityBase + traits.curiosity * W.trait.curiositySpan;
      const timeMul = isNight ? 0.5 : 1;
      // 同じベンチに全員が集まるのを抑える（設置物は動かないので放っておくと必ず溜まる）
      const score =
        W.base.goto * attract * falloff(d, W.distScale.goto) * cur * outdoor * timeMul * crowdFactor(near, p.pos);
      if (!bestP || score > bestP.score) bestP = { id: p.id, pos: p.pos, score };
    }
    if (bestP) {
      out.push({ kind: 'goto', targetEntity: bestP.id, score: bestP.score, why: `goto placeable attract` });
    }
  }

  // ---- goto（雨の避難）: 雨の日は森／木の下に集まる ----
  if (weather === 'rain') {
    const shelter = shelterTileOf(world, actor, ctx.tick);
    // すでに木の下にいるなら避難は「達成済み」。候補を出し続けると
    // 距離0で満点を取り続け、雨の夜に立ったまま眠れなくなる（実測で発見）。
    if (shelter && distance(actor.pos, shelter) > W.actRange) {
      const d = distance(actor.pos, shelter);
      const nightMul = isNight ? W.weather.rainShelterNight : 1;
      // 腹が減れば雨でも出ていく。
      // 避難は距離0で満点(=61)を取り続けるのに対し、eat は距離減衰で30点前後しか出ないため、
      // この係数が無いと長雨のあいだ木の下で餓死してしまう（実測で発見）。
      const hungerMul = 1 - W.weather.rainShelterHungerRelief * u(needs.hunger);
      // 混んでいる木の下より空いている木の下へ（`shelterTileOf` の起点ずらしと合わせて散らす）
      const crowd = crowdFactor(near, shelter);
      const score = W.base.rainShelter * falloff(d, W.distScale.shelter) * nightMul * hungerMul * crowd;
      out.push({
        kind: 'goto',
        targetTile: shelter,
        score,
        why: `rain shelter d=${d.toFixed(1)} hungerMul=${hungerMul.toFixed(2)} crowd=${crowd.toFixed(2)}`,
      });
    }
  }

  // ---- wander: 常に低い基礎値。好奇心で伸びる ----
  {
    const need = 0.5 + u(needs.curiosity);
    const cur = W.trait.curiosityBase + traits.curiosity * W.trait.curiositySpan;
    const timeMul = isNight ? W.time.wanderNight : 1;
    const score = W.base.wander * need * cur * timeMul * outdoor;
    out.push({ kind: 'wander', targetTile: wanderTileFor(world, actor, ctx.tick), score, why: 'wander' });
  }

  return out;
}

/** 逃走先を探す向き（真後ろ→斜め→横→前）と距離の縮め方 */
const FLEE_ANGLES: readonly number[] = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (Math.PI * 3) / 4, -((Math.PI * 3) / 4), Math.PI];
const FLEE_DISTANCE_SCALES: readonly number[] = [1, 0.6, 0.35];

/**
 * 脅威から離れる方向のタイル。
 *
 * ⚠️ 素直に「真後ろへ fleeDistance タイル」だと**海に向かって逃げる**ことがある。
 * 岬や砂浜の袋小路にいる個体は経路が引けず、
 * 「逃走 → 経路なし → travelTimeout で諦める → また逃走」を延々くり返して**その場から動かなくなる**
 * （invariants の「長時間動かない個体がいない」がこれを捕まえた）。
 * 歩けるタイルが見つかるまで向きを回し、それでも駄目なら距離を縮める。
 */
function fleeTileFrom(world: IslandWorld, pos: Vec2, threat: Vec2): Vec2 {
  let dx = pos.x - threat.x;
  let dy = pos.y - threat.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    dx = 1;
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  const base = Math.atan2(dy, dx);
  const d = WEIGHTS.threat.fleeDistance;
  let fallback: Vec2 | null = null;
  for (const scale of FLEE_DISTANCE_SCALES) {
    for (const a of FLEE_ANGLES) {
      const ang = base + a;
      const x = Math.min(MAP_W - 1.5, Math.max(1.5, pos.x + Math.cos(ang) * d * scale));
      const y = Math.min(MAP_H - 1.5, Math.max(1.5, pos.y + Math.sin(ang) * d * scale));
      if (world.isWalkableTile(Math.floor(x), Math.floor(y))) return { x, y };
      if (!fallback) fallback = { x, y };
    }
  }
  // 陸が1タイルも見つからない（起きえないが型のため）。真後ろを返す
  return fallback ?? tileCenter(Math.floor(pos.x), Math.floor(pos.y));
}

/**
 * 寝床。優先度は 巣 > （雨なら）森 > いまいる場所。
 * 巣を持っていれば毎晩そこへ帰るので「就寝 → 起床」のサイクルが場所として見える。
 */
function bedTileFor(world: IslandWorld, actor: Actor, ctx: CritterContext, weather: Weather): Vec2 | null {
  const nest = actor.nest;
  if (nest) return nest.pos;
  if (weather === 'rain') {
    const shelter = shelterTileOf(world, actor, ctx.tick);
    if (shelter) return shelter;
  }
  return null;
}

/**
 * 徘徊先。rng を消費せずに (id, tickブロック) から決める。
 * tickブロックで固定するのは、毎tick目標が変わるとヒステリシスが効かなくなるため。
 */
function wanderTileFor(world: IslandWorld, actor: Actor, tick: number): Vec2 {
  // 徘徊中なら目標を変えない（ちらつき防止）
  const cur = actor.action;
  if (cur && cur.kind === 'wander' && cur.targetTile) return cur.targetTile;

  const block = Math.floor(tick / WEIGHTS.wanderBlockTicks);
  for (let i = 0; i < 3; i++) {
    const angle = hash01(actor.id * 3 + i, block) * Math.PI * 2;
    const r = WEIGHTS.wanderMinRadius + hash01(actor.id * 3 + i + 1, block + 7) * (WEIGHTS.wanderRadius - WEIGHTS.wanderMinRadius);
    const x = actor.pos.x + Math.cos(angle) * r;
    const y = actor.pos.y + Math.sin(angle) * r;
    if (world.isWalkableTile(Math.floor(x), Math.floor(y))) {
      return { x: Math.min(MAP_W - 1.5, Math.max(1.5, x)), y: Math.min(MAP_H - 1.5, Math.max(1.5, y)) };
    }
  }
  // 3回外したら動かない（次のブロックで再挑戦する）
  return tileCenter(Math.floor(actor.pos.x), Math.floor(actor.pos.y));
}

/** 同じ行動・同じ対象か（ヒステリシスの判定） */
function sameTarget(a: { targetEntity?: EntityId; targetTile?: Vec2 }, b: Candidate): boolean {
  if (a.targetEntity !== undefined || b.targetEntity !== undefined) return a.targetEntity === b.targetEntity;
  if (a.targetTile && b.targetTile) return Math.abs(a.targetTile.x - b.targetTile.x) < 0.75 && Math.abs(a.targetTile.y - b.targetTile.y) < 0.75;
  return !a.targetTile && !b.targetTile;
}

/** 最良の候補を選ぶ。現在の行動には継続ボーナスを与えてちらつきを防ぐ */
export function chooseAction(world: IslandWorld, actor: Actor, ctx: CritterContext): Candidate | null {
  const cands = scoreCandidates(world, actor, ctx);
  if (cands.length === 0) return null;
  const cur = actor.action;
  let best: Candidate | null = null;
  let bestEff = -Infinity;
  for (const c of cands) {
    const keep = cur !== null && cur.kind === c.kind && sameTarget(cur, c);
    const eff = c.score + (keep ? WEIGHTS.hysteresis : 0);
    // 同点なら先に評価した候補（flee → eat → ...）を優先。順序が決定論になる
    if (eff > bestEff) {
      bestEff = eff;
      best = keep ? { ...c, why: `${c.why ?? ''} +hysteresis` } : c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// CritterAI
// ---------------------------------------------------------------------------

function durationOf(kind: ActionKind): number {
  const d = WEIGHTS.duration;
  switch (kind) {
    case 'eat':
      return d.eat;
    case 'drink':
      return d.drink;
    case 'sleep':
      return d.sleep;
    case 'socialize':
      return d.socialize;
    case 'nest':
      return d.nest;
    case 'wander':
      return d.wander;
    case 'goto':
      return d.goto;
    case 'flee':
      return d.flee;
    default:
      return d.other;
  }
}

/** 行動中の見た目。movement.ts は 'sleep' / 'act' を上書きしない */
function animFor(kind: ActionKind): 'sleep' | 'act' | 'talk' | null {
  if (kind === 'sleep') return 'sleep';
  if (kind === 'eat' || kind === 'drink' || kind === 'nest') return 'act';
  if (kind === 'socialize') return 'talk';
  return null;
}

interface TargetInfo {
  pos: Vec2 | null;
  /** 対象エンティティが消えた（行動を破棄する） */
  gone: boolean;
}

export class CritterAI {
  private world: IslandWorld;
  private nav: NavService;
  private clock: WorldClock;
  private evaluated = 0;
  private switched = 0;
  private byAction: Record<string, number> = {};
  private nestAdded = 0;
  private nestRemoved = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(world: IslandWorld, nav: NavService, clock: WorldClock) {
    this.world = world;
    this.nav = nav;
    this.clock = clock;
  }

  /** 毎tick呼ぶ。内部で time slicing する（1体あたり2秒ごとに再判断） */
  update(tick: number): void {
    const ctx: CritterContext = { tick, clock: this.clock, isNight: this.clock.isNight(tick) };
    const slice = tick % WEIGHTS.sliceMod;

    // 死んだ個体の巣の設置物を片づける（無限に増えるのを防ぐ）。
    // 退場処理（relation.ts）は world を巣に結び付けていないので、ここで定期的に均す
    if (tick % WEIGHTS.nestSyncTicks === 0) {
      const r = syncNestPlaceables(this.world);
      this.nestAdded += r.added;
      this.nestRemoved += r.removed;
    }

    for (const actor of this.world.actors.values()) {
      if (actor.kind !== 'critter') continue;
      if (actor.id % WEIGHTS.sliceMod !== slice) continue;
      this.evaluated++;

      const best = chooseAction(this.world, actor, ctx);
      if (!best) continue;

      const cur = actor.action;
      if (cur && cur.kind === best.kind && sameTarget(cur, best)) continue; // 継続

      // 行動を切り替える
      this.switched++;
      this.byAction[best.kind] = (this.byAction[best.kind] ?? 0) + 1;
      this.beginAction(actor, best, tick);
    }

    this.resolveActions(tick);
  }

  private beginAction(actor: Actor, c: Candidate, tick: number): void {
    // 前の行動の見た目を解除する（'sleep'/'act' は movement.ts が戻せない）
    if (actor.anim === 'sleep' || actor.anim === 'act' || actor.anim === 'talk') actor.anim = 'idle';
    const action: ActiveAction = {
      kind: c.kind,
      startedAtTick: tick,
      durationTicks: durationOf(c.kind),
    };
    if (c.targetEntity !== undefined) action.targetEntity = c.targetEntity;
    if (c.targetTile) action.targetTile = { x: c.targetTile.x, y: c.targetTile.y };
    actor.action = action;

    const m = memoOf(actor);
    m.issuedAtTick = tick;
    m.arrived = false;
    m.lastNavTick = -9999;
    actor.path = null;
    this.nav.clear(actor.id);
  }

  /** 行動の完了判定と効果適用（採食で満腹になる等）。update内から呼ぶが単体でも使える */
  resolveActions(tick: number): void {
    let navBudget = WEIGHTS.navRequestsPerTick;

    for (const actor of this.world.actors.values()) {
      if (actor.kind !== 'critter') continue;
      const action = actor.action;
      if (!action) continue;

      const target = this.targetInfoOf(action);
      if (target.gone) {
        this.abandon(actor);
        continue;
      }

      if (target.pos) {
        const d = distance(actor.pos, target.pos);
        if (d > WEIGHTS.actRange) {
          // 移動中
          const m = memoOf(actor);
          if (m.arrived) {
            // 対象が動いた（交流相手など）。着き直す
            m.arrived = false;
            action.startedAtTick = tick;
          }
          if (actor.anim === 'sleep' || actor.anim === 'act' || actor.anim === 'talk') actor.anim = 'idle';
          if (tick - m.issuedAtTick > WEIGHTS.travelTimeoutTicks) {
            this.abandon(actor);
            continue;
          }
          if (!actor.path && navBudget > 0 && tick - m.lastNavTick >= WEIGHTS.navRetryTicks) {
            this.nav.request(actor.id, target.pos);
            m.lastNavTick = tick;
            navBudget--;
          }
          continue;
        }
      }

      // 到着している = 行動中
      const m = memoOf(actor);
      if (!m.arrived) {
        m.arrived = true;
        action.startedAtTick = tick; // durationTicks は「到着してからの時間」を数える
        actor.path = null;
        this.nav.clear(actor.id);
      }
      const anim = animFor(action.kind);
      if (anim) actor.anim = anim;

      if (tick - action.startedAtTick >= action.durationTicks) this.complete(actor, action, tick);
    }
  }

  /** 目的地。targetEntity が消えていたら gone=true */
  private targetInfoOf(action: ActiveAction): TargetInfo {
    if (action.targetEntity !== undefined) {
      const r = this.world.resources.get(action.targetEntity);
      if (r) return { pos: r.pos, gone: false };
      const p = this.world.placeables.get(action.targetEntity);
      if (p) return { pos: p.pos, gone: false };
      const a = this.world.actor(action.targetEntity);
      if (a) return { pos: a.pos, gone: false };
      return { pos: null, gone: true };
    }
    return { pos: action.targetTile ?? null, gone: false };
  }

  private abandon(actor: Actor): void {
    actor.action = null;
    actor.path = null;
    if (actor.anim === 'sleep' || actor.anim === 'act' || actor.anim === 'talk') actor.anim = 'idle';
    this.nav.clear(actor.id);
    const m = memoOf(actor);
    m.arrived = false;
  }

  /** 行動の効果を適用して終了する */
  private complete(actor: Actor, action: ActiveAction, tick: number): void {
    const world = this.world;
    switch (action.kind) {
      case 'eat': {
        const node = action.targetEntity !== undefined ? world.resources.get(action.targetEntity) : undefined;
        if (node && deps.isAvailable(node)) {
          const got = deps.harvest(world, node, WEIGHTS.eatPortion, tick);
          if (got > 0) {
            deps.relieveNeed(actor, 'hunger', NEEDS.eatRelief * Math.min(1, got / WEIGHTS.eatPortion));
          }
        }
        break;
      }
      case 'drink': {
        const node = action.targetEntity !== undefined ? world.resources.get(action.targetEntity) : undefined;
        if (node && deps.isAvailable(node)) {
          const got = deps.harvest(world, node, WEIGHTS.drinkPortion, tick);
          if (got > 0) deps.relieveNeed(actor, 'hunger', NEEDS.drinkRelief);
        }
        break;
      }
      case 'sleep': {
        const hours = action.durationTicks / TICKS_PER_ISLAND_HOUR;
        deps.relieveNeed(actor, 'sleep', NEEDS.sleepReliefPerIslandHour * hours);
        // 眠れたなら安全欲も少し収まる
        deps.relieveNeed(actor, 'safety', 10);
        break;
      }
      case 'socialize': {
        // 相手がまだ近くにいるときだけ満たされる（好感度は relation.ts が見る）
        const other = action.targetEntity !== undefined ? world.actor(action.targetEntity) : undefined;
        if (other && distance(actor.pos, other.pos) <= WEIGHTS.actRange * 2) {
          deps.relieveNeed(actor, 'social', NEEDS.socializeRelief);
        }
        break;
      }
      case 'nest': {
        // 巣ができた。次からここで眠る。
        // `Actor.nest` に持たせるのでスナップショットに乗り、再起動しても同じ場所に残る（C-3）
        if (action.targetTile) setNest(world, actor, action.targetTile, tick);
        deps.relieveNeed(actor, 'safety', 40);
        deps.relieveNeed(actor, 'sleep', 5);
        break;
      }
      case 'wander':
      case 'goto': {
        deps.relieveNeed(actor, 'curiosity', 20);
        break;
      }
      default:
        break;
    }
    this.abandon(actor);
  }

  /** メトリクス用 */
  stats(): {
    evaluated: number;
    switched: number;
    byAction: Record<string, number>;
    nestAdded: number;
    nestRemoved: number;
  } {
    return {
      evaluated: this.evaluated,
      switched: this.switched,
      byAction: { ...this.byAction },
      nestAdded: this.nestAdded,
      nestRemoved: this.nestRemoved,
    };
  }
}

/** テストとデバッグから重みを覗けるようにする（実体は constants.ts。再exportだけ残す） */
export { CRITTER_WEIGHTS };
