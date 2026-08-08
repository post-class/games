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
 * critter.ts 固有のバランス値。
 * TODO(M3 バランス調整): ここは最終的に shared/constants.ts の `CRITTER` へ移す。
 *   いまは constants.ts を別の作業者が編集中なので、衝突を避けてこのファイルに置いている。
 *
 * base の値は「その行動が最も切迫したときのスコアの上限」の目安。
 *   flee 220  … 生命の危機。ほぼ何にでも勝つ
 *   eat/sleep 100 … 生活の主軸。この2つが日中/夜で入れ替わるのが「昼は働き夜は寝る」の核
 *   drink 78 / socialize 72 / nest 62 … 主軸の隙間に入る行動
 *   rainShelter 62 … 平常時のeat(数点)には勝ち、切迫した空腹(50点前後)には負ける強さ。
 *                    「雨でも腹が減れば出ていく」ようにしたいのでこの位置
 *   wander 14 … 何もないときの基礎値。他が0に近いときだけ勝つ
 */
const WEIGHTS = {
  base: {
    eat: 100,
    /** 78だと水飲みが交流を押しのけて群れができなかったので下げた */
    drink: 62,
    sleep: 100,
    /** 交流は「群れが生まれる」ための行動。水飲みより優先されるべき */
    socialize: 84,
    flee: 220,
    nest: 62,
    wander: 14,
    goto: 58,
    /** 雨のときだけ出る「森へ避難」候補（kindは goto） */
    rainShelter: 62,
  },
  /** 距離の減衰スケール（このタイル数離れるとスコアが半分になる） */
  distScale: {
    /** 食料は遠くても行く価値がある */
    eat: 20,
    drink: 16,
    /** 寝床は近いところで済ませたい */
    sleep: 10,
    socialize: 12,
    nest: 14,
    goto: 18,
    shelter: 20,
  },
  /** 現在の行動への継続ボーナス（docs 04章 §4 の +15） */
  hysteresis: 15,

  /** 探索半径。curiosity で ±20%、霧の日は狭くなる */
  searchRadiusBase: 22,
  fogSearchScale: 0.6,
  /** 空腹が切迫すると食料の探索半径がこの倍率ぶん広がる（1.5 → 最大2.5倍） */
  hungerSearchSpan: 1.5,
  /** 交流相手・脅威を探す半径（全アクター走査を1回で済ませるため共通化する） */
  nearRadius: 14,

  /** traits の効き方。いずれも base + trait * span 倍 */
  trait: {
    gluttonyBase: 0.6,
    gluttonySpan: 0.8,
    /** energy が高い個体は夜更かしする（= sleep が上がりにくい） */
    sleepEnergyBase: 1.3,
    sleepEnergySpan: -0.6,
    sociabilityBase: 0.5,
    sociabilitySpan: 1.0,
    cautionBase: 0.4,
    cautionSpan: 1.0,
    curiosityBase: 0.6,
    curiositySpan: 0.8,
  },

  /** 時間帯 */
  time: {
    sleepNight: 1.6,
    sleepEvening: 1.0,
    sleepDay: 0.45,
    /**
     * 夜だけ加える下駄。
     * 掛け算だけだと「眠気がまだ低い夜」に eat/wander が勝ってしまい、
     * 「夜間睡眠率6割」の不変条件を満たせない。夜に限って sleep に床を作る。
     */
    sleepNightFloor: 26,
    eatDay: 1.15,
    eatNight: 0.6,
    socialDay: 1.15,
    socialNight: 0.35,
    wanderNight: 0.4,
  },

  /** 天気 */
  weather: {
    /** 雨の屋外行動は -30%（docs 04章 §2） */
    rainOutdoor: 0.7,
    /** 霧は見通しが悪いだけなので減衰は軽い */
    fogOutdoor: 0.9,
    /** 水を飲むのは雨でも苦にならない */
    rainDrink: 0.85,
    /** 雨は巣づくり・木の下が有利 */
    rainNest: 1.3,
    /** 夜は避難より睡眠を優先させる */
    rainShelterNight: 0.6,
    /** 空腹が切迫すると避難の魅力がこの割合まで下がる（雨でも食べに出る） */
    rainShelterHungerRelief: 0.85,
  },

  /** 季節。冬は巣ごもり、春は巣づくり（繁殖準備）、夏は水場 */
  season: {
    nest: { spring: 1.4, summer: 0.9, autumn: 1.0, winter: 1.6 },
    thirst: { spring: 1.0, summer: 1.4, autumn: 1.0, winter: 0.8 },
  },

  /** 荒廃度100のタイルはスコアがこの割合だけ下がる（荒れた場所を避ける） */
  decayAversion: 0.4,

  /** 設置物の attract の基準値。attract/attractRef 倍（上限 attractMax） */
  attractRef: 5,
  attractMax: 2.5,

  /** 脅威 */
  threat: {
    /** プレイヤーはこの距離まで近づくと怖い */
    playerRadius: 7,
    /**
     * 大型個体（いのしし）はこの距離。
     * 5だと100体の島で逃走が常時発生し（評価の8%）夜も眠れなかったため 3.5 に下げた。
     */
    bigRadius: 3.5,
    /** 寝ている個体が起きて逃げ出す距離 */
    wakeRadius: 1.8,
    /** 逃げる距離 */
    fleeDistance: 6,
  },

  /** 行動の所要tick。250ms/tick */
  duration: {
    eat: 12,
    /** 8tickだと水飲みが毎秒切り替わって行動ログが埋まったので伸ばした */
    drink: 24,
    /** 1.5島時間ぶん眠る。夜（15分=3600tick）で2〜3回に分かれる */
    sleep: Math.round(TICKS_PER_ISLAND_HOUR * 1.5),
    /** 交流は好感度が育つのに時間が要る（1回20tickだと友達ができなかった） */
    socialize: 60,
    nest: 40,
    wander: 24,
    goto: 16,
    flee: 12,
    other: 8,
  },

  /** 目的地に「着いた」とみなす距離 */
  actRange: 1.2,
  /** 1tickに発行する経路探索リクエストの上限（nav は1tick8件処理） */
  navRequestsPerTick: 6,
  /** 経路が引けなかったときの再要求間隔 */
  navRetryTicks: 8,
  /** これだけ移動しても着かない目的地は諦める（到達不能な島の向こう側など） */
  travelTimeoutTicks: 320,
  /** 1回の採食で取る量 */
  eatPortion: 1.5,
  /** 1回の水飲みで取る量 */
  drinkPortion: 1,
  /** 森タイル探索の結果をキャッシュするtick数（毎回リング探索すると重い） */
  shelterCacheTicks: 80,
  /** 森タイルを探す最大半径 */
  shelterMaxRadius: 12,
  /** 徘徊の目標距離 */
  wanderRadius: 8,
  wanderMinRadius: 3,
  /** 徘徊先を選び直す間隔（ヒステリシスを壊さないよう目標を固定する） */
  wanderBlockTicks: 24,
  /**
   * 巣の設置物を掃除・補充する間隔（C-3）。
   * 死んだ個体の巣を消さないと設置物が無限に増える。
   * 毎tick走らせても O(設置物数) だが、見た目の反映は数秒遅れて構わないので10秒に1回にした。
   */
  nestSyncTicks: 40,
  /** 巣タイルが他個体の巣で埋まっていたときに、代わりの空きタイルを探す半径 */
  nestSpreadRadius: 3,
  /** time slicing の分割数 */
  sliceMod: 8,
} as const;

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
      targetTile: fleeTileFrom(actor.pos, other.pos),
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
  const water = world.findNearestResource(actor.pos, WATER_TYPES, radius);
  if (water && deps.isAvailable(water)) {
    const d = distance(actor.pos, water.pos);
    // 空腹0でも少しは水を飲みに行く（+0.15）
    const need = u(needs.hunger) * 0.5 + 0.15;
    const wMul = weather === 'rain' ? W.weather.rainDrink : outdoor;
    const score = W.base.drink * need * falloff(d, W.distScale.drink) * W.season.thirst[season] * wMul;
    out.push({ kind: 'drink', targetEntity: water.id, score, why: `drink need=${need.toFixed(2)} d=${d.toFixed(1)}` });
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
    let partner: Actor | null = null;
    for (const other of near) {
      if (other.kind === 'player') continue;
      if (other.anim === 'sleep') continue;
      partner = other;
      break;
    }
    if (partner) {
      const d = distance(actor.pos, partner.pos);
      const need = u(needs.social);
      const soc = W.trait.sociabilityBase + traits.sociability * W.trait.sociabilitySpan;
      const timeMul = isNight ? W.time.socialNight : tod === 'day' || tod === 'morning' ? W.time.socialDay : 1;
      // 広場は社交の場（ベンチの加点は goto 側で効く）
      const placeMul = world.terrainAt(Math.floor(actor.pos.x), Math.floor(actor.pos.y)) === 'plaza' ? 1.25 : 1;
      const score = W.base.socialize * need * falloff(d, W.distScale.socialize) * soc * timeMul * outdoor * placeMul;
      out.push({
        kind: 'socialize',
        targetEntity: partner.id,
        score,
        why: `socialize need=${need.toFixed(2)} d=${d.toFixed(1)} soc=${soc.toFixed(2)}`,
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
    const score = W.base.nest * need * caution * seasonMul * rainMul * distMul * decayFactor(world, target);
    out.push({
      kind: 'nest',
      targetTile: target,
      score,
      why: `nest need=${need.toFixed(2)} season=${season} rain=${rainMul}`,
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
      const score = W.base.goto * attract * falloff(d, W.distScale.goto) * cur * outdoor * timeMul;
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
      const score = W.base.rainShelter * falloff(d, W.distScale.shelter) * nightMul * hungerMul;
      out.push({
        kind: 'goto',
        targetTile: shelter,
        score,
        why: `rain shelter d=${d.toFixed(1)} hungerMul=${hungerMul.toFixed(2)}`,
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

/** 脅威から離れる方向のタイル */
function fleeTileFrom(pos: Vec2, threat: Vec2): Vec2 {
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
  const d = WEIGHTS.threat.fleeDistance;
  return {
    x: Math.min(MAP_W - 1.5, Math.max(1.5, pos.x + dx * d)),
    y: Math.min(MAP_H - 1.5, Math.max(1.5, pos.y + dy * d)),
  };
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

/** テストとデバッグから重みを覗けるようにする（変更不可） */
export const CRITTER_WEIGHTS = WEIGHTS;
