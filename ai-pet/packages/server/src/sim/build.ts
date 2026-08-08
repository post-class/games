/**
 * 設置物と共同建設（docs/02_ゲーム実装プラン/09_マイルストーン計画.md M7）
 *
 * 宣伝資料の2つの体験を担当する:
 *   1. 「ベンチや花壇をひとつ。住民の集まる場所が変わっていく」
 *      → Placeable の attract が critter.ts の goto 候補に効く
 *   2. 「橋づくりなど、みんなで少しずつ進める建設」
 *      → Construction の progress を全員で 0→100 まで押し上げる
 *
 * 原則:
 * - place / contribute はプレイヤー操作なので軽く保つ（走査は近傍だけ）
 * - seedConstructions は島の生成時に1回だけなので重くてよい（BFSを何度も回す）
 * - Math.random() 禁止（world.rng を使う）。同じseedなら同じ場所に建設予定地ができる
 * - parameter property 禁止 / enum 禁止（Node の type-stripping で動かすため）
 */
import {
  MAP_H,
  MAP_W,
  RESOURCE,
  type Construction,
  type ConstructionType,
  type EntityId,
  type Placeable,
  type PlaceableType,
  type PlayerId,
  type Vec2,
} from '@ai-pet/shared';
import { distance, inBounds, tileIndex, type IslandWorld } from './world.ts';

// ---------- 定数 ----------
// TODO: バランス調整のフェーズで shared/constants.ts へ移す（並列作業中は constants.ts を触れないためここに置く）

/**
 * 設置物の attract。critter.ts の `WEIGHTS.attractRef` = 5 が基準で、
 * スコアには `min(attractMax=2.5, attract/5)` 倍として効く。
 * ベンチは「置くと動物が集まる」のが M7 の完了条件なので基準より高くしている。
 */
export const PLACE_ATTRACT: Record<PlaceableType, number> = {
  bench: 6,
  flowerbed: 4,
  lantern: 3,
  signboard: 1,
  // 共同建設の完成物。プレイヤーは置けないので、ここの値は使われない
  // （`applyEffect` が attract を直接指定して addPlaceable する）。
  // Record を全部埋めないと型が通らないので入れてある
  well: 0,
  observatory: 0,
  // 島の生成時に worldgen が置く建物（C-1 / C-2）。プレイヤーは置けないので値は使われないが、
  // `worldgen.ts` はここを参照して attract を決めている。
  // すべて 0。人工物に動物が群がると、餌の無い村へ通い続けて餓死する
  // （M3の長期シミュレーションで「ほぼ空の資源に通い続けて餓死する」を踏んでいる）。
  // 島の生成物は「風景」であって、動物を集めるのはプレイヤーが置くベンチの役目にする。
  house_a: 0,
  house_b: 0,
  house_c: 0,
  windmill: 0,
  fountain: 0,
  fence_h: 0,
  fence_v: 0,
};

/** プレイヤーから設置できる距離（タイル） */
const PLACE_RANGE_TILES = 3;
/** 他の設置物と保つ間隔（中心間の距離）。2 = 隣のタイルには置けない */
const PLACE_MIN_GAP_TILES = 2;
/** 1プレイヤーが同時に持てる設置物の数 */
const MAX_PLACEABLES_PER_PLAYER = 8;

/** 貢献できる距離（タイル） */
const CONTRIBUTE_RANGE_TILES = 3;
/** 1回の貢献で進む量 */
const CONTRIBUTE_STEP = 5;
/** 同じプレイヤーの連続貢献のクールダウン（8tick = 2秒） */
const CONTRIBUTE_COOLDOWN_TICKS = 8;
/** 完成に必要な progress */
const CONSTRUCTION_GOAL = 100;

/** 橋にできる水の帯の最大幅（タイル） */
const BRIDGE_MAX_SPAN = 4;
/**
 * 橋の候補としてBFSで迂回距離を測る最大件数。
 * 実測では1島あたり候補は2〜32件（幅5以上の水はほぼ外洋なので候補にならない）。
 * 起動時1回・1件あたりBFS 1回なので64件でも数十msで済む。
 */
const BRIDGE_MAX_CANDIDATES = 64;
/**
 * 橋を架ける価値があると見なす迂回距離（歩数）。
 * これ未満は「4歩まわればいい水たまり」なので橋を置かない（置いても嬉しくない）。
 */
const BRIDGE_MIN_DETOUR = 12;
/** 迂回距離が「橋を渡る歩数」の何倍以上あれば近道として意味があるか */
const BRIDGE_MIN_DETOUR_RATIO = 2.5;

/** 井戸は広場からこのくらい離れた場所に置く（タイル） */
const WELL_DIST_MIN = 5;
const WELL_DIST_MAX = 10;

/** 天文台は島の端に近いところ（中心からの距離がこれ以上） */
const OBSERVATORY_MIN_DIST_FROM_CENTER = 20;
/** 完成した天文台の attract（ベンチより強く、島の名所として振る舞う） */
const OBSERVATORY_ATTRACT = 10;
/**
 * 島が所有する設置物の ownerId（プレイヤーは撤去できない）。
 * worldgen が置く家・風車・柵・噴水（C-1 / C-2）でも使うので export している。
 */
export const ISLAND_OWNER: PlayerId = '__island__';

const TILE_COUNT = MAP_W * MAP_H;

// ---------- 表示名 ----------

const PLACEABLE_LABEL: Record<PlaceableType, string> = {
  bench: 'ベンチ',
  flowerbed: '花壇',
  lantern: 'ランタン',
  signboard: '看板',
  well: '井戸',
  observatory: '天文台',
  house_a: '家',
  house_b: '家',
  house_c: '家',
  windmill: '風車',
  fountain: '噴水',
  fence_h: '柵',
  fence_v: '柵',
};

const CONSTRUCTION_LABEL: Record<ConstructionType, string> = {
  bridge: '橋',
  well: '井戸',
  observatory: '天文台',
};

// ---------- 結果型 ----------

export type PlaceRejectReason =
  | 'not_walkable'
  | 'occupied'
  | 'too_close'
  | 'too_many'
  | 'out_of_range'
  | 'unknown_type';

export type PlaceResult = { ok: true; placeable: Placeable } | { ok: false; reason: PlaceRejectReason };

export type ContributeRejectReason = 'not_found' | 'too_far' | 'already_done' | 'rate';

export type ContributeResult =
  | { ok: true; construction: Construction; progress: number; completed: boolean }
  | { ok: false; reason: ContributeRejectReason };

export interface BuildDeps {
  /** 建設・設置のイベントを島の出来事として残す */
  emitEvent: (input: { kind: 'build'; text: string; pos?: Vec2; actorId?: EntityId; importance?: number }) => void;
  /** 橋の完成などで地形が変わったことを知らせる（経路キャッシュとクライアントの再描画に使う） */
  onTerrainChanged: (tiles: Vec2[]) => void;
  /**
   * playerId → 表示名。イベントの文面に使う。
   * 省略すると playerId がそのまま文面に出る（テストや単体利用のため任意）。
   */
  nameOf?: (playerId: PlayerId) => string;
}

// ---------- BFS の作業領域 ----------
// seedConstructions からしか使わないが、候補ごとに確保すると無駄なので使い回す。
const bfsGen = new Int32Array(TILE_COUNT);
const bfsDist = new Int32Array(TILE_COUNT);
let bfsGeneration = 0;

const NEIGHBORS4: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 歩けるタイルだけを辿った歩数（4近傍）。到達できない・上限を超えたら null。
 * 「橋がないと何歩まわり込むことになるか」を測るために使う。
 */
function walkSteps(world: IslandWorld, from: Vec2, to: Vec2, maxSteps: number): number | null {
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  const gx = Math.floor(to.x);
  const gy = Math.floor(to.y);
  if (!world.isWalkableTile(sx, sy) || !world.isWalkableTile(gx, gy)) return null;
  if (sx === gx && sy === gy) return 0;

  bfsGeneration++;
  const gen = bfsGeneration;
  const start = tileIndex(sx, sy);
  const goal = tileIndex(gx, gy);
  bfsGen[start] = gen;
  bfsDist[start] = 0;

  // 配列をキューとして使う（shift は O(n) なので読み出し位置を持つ）
  const queue: number[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head] as number;
    const d = bfsDist[cur] as number;
    if (d >= maxSteps) continue;
    const x = cur % MAP_W;
    const y = (cur - x) / MAP_W;
    for (const [dx, dy] of NEIGHBORS4) {
      const nx = x + dx;
      const ny = y + dy;
      if (!world.isWalkableTile(nx, ny)) continue;
      const ni = tileIndex(nx, ny);
      if (bfsGen[ni] === gen) continue;
      bfsGen[ni] = gen;
      bfsDist[ni] = d + 1;
      if (ni === goal) return d + 1;
      queue.push(ni);
    }
  }
  return null;
}

// ---------- 橋の予定地 ----------

interface BridgeSpan {
  /** 水の帯（橋になるタイル）。整数タイル座標 */
  tiles: Vec2[];
  /** 帯の両端の陸（橋のたもと） */
  shoreA: Vec2;
  shoreB: Vec2;
}

/**
 * (x,y) を含む「陸→水…水→陸」の帯を1軸ぶん探す。
 * 幅が BRIDGE_MAX_SPAN を超える／片側が陸でないなら null。
 */
function spanAt(world: IslandWorld, x: number, y: number, axis: 'h' | 'v'): BridgeSpan | null {
  if (!inBounds(x, y) || world.terrainAt(x, y) !== 'water') return null;
  const dx = axis === 'h' ? 1 : 0;
  const dy = axis === 'h' ? 0 : 1;

  let x0 = x;
  let y0 = y;
  while (world.terrainAt(x0 - dx, y0 - dy) === 'water') {
    x0 -= dx;
    y0 -= dy;
    if (!inBounds(x0, y0)) return null;
  }
  let x1 = x;
  let y1 = y;
  while (world.terrainAt(x1 + dx, y1 + dy) === 'water') {
    x1 += dx;
    y1 += dy;
    if (!inBounds(x1, y1)) return null;
  }

  const width = axis === 'h' ? x1 - x0 + 1 : y1 - y0 + 1;
  if (width < 1 || width > BRIDGE_MAX_SPAN) return null;

  const ax = x0 - dx;
  const ay = y0 - dy;
  const bx = x1 + dx;
  const by = y1 + dy;
  if (!world.isWalkableTile(ax, ay) || !world.isWalkableTile(bx, by)) return null;

  const tiles: Vec2[] = [];
  for (let i = 0; i < width; i++) tiles.push({ x: x0 + dx * i, y: y0 + dy * i });
  return { tiles, shoreA: { x: ax, y: ay }, shoreB: { x: bx, y: by } };
}

/**
 * 位置から橋になるタイルを引き直す。
 *
 * Construction は pos しか持たないので、完成処理と復元では毎回ここで帯を求める。
 * 横方向を先に見て、無ければ縦方向。すでに陸なら空配列（＝地形を変える必要がない）。
 */
function bridgeTilesAt(world: IslandWorld, pos: Vec2): Vec2[] {
  const x = Math.floor(pos.x);
  const y = Math.floor(pos.y);
  const h = spanAt(world, x, y, 'h');
  if (h) return h.tiles;
  const v = spanAt(world, x, y, 'v');
  if (v) return v.tiles;
  return [];
}

/** 帯の中央（タイル中心座標） */
function spanCenter(span: BridgeSpan): Vec2 {
  const t = span.tiles[Math.floor(span.tiles.length / 2)] as Vec2;
  return { x: t.x + 0.5, y: t.y + 0.5 };
}

/**
 * 島を分断している（＝渡るのに大回りが必要な）水の帯を探す。
 *
 * worldgen は到達不能な陸を沈めてしまうので「完全に分断された島」は存在しない。
 * そこで「橋がないと何歩まわり込むか（迂回距離）」で価値を測り、
 * 一番効く1本だけを予定地にする。BRIDGE_MIN_DETOUR に届かなければ橋は置かない。
 */
function findBridgeSpan(world: IslandWorld): BridgeSpan | null {
  const candidates: BridgeSpan[] = [];
  const seen = new Set<number>();

  // 幅の狭い帯だけを拾いたいので、陸の隣の水タイルから両軸を試す
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (world.terrainAt(x, y) !== 'water') continue;
      for (const axis of ['h', 'v'] as const) {
        const span = spanAt(world, x, y, axis);
        if (!span) continue;
        const first = span.tiles[0] as Vec2;
        // 同じ帯を帯の幅ぶん重複して拾わないための鍵（先頭タイル＋向き）
        const key = tileIndex(first.x, first.y) * 2 + (axis === 'h' ? 0 : 1);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(span);
      }
    }
  }
  if (candidates.length === 0) return null;

  // BFS の回数を抑えるため、候補を決定論的にシャッフルして先頭だけ調べる
  world.rng.shuffle(candidates);
  const limited = candidates.slice(0, BRIDGE_MAX_CANDIDATES);

  let best: BridgeSpan | null = null;
  let bestScore = -Infinity;
  const cap = 512;
  for (const span of limited) {
    const steps = walkSteps(world, span.shoreA, span.shoreB, cap);
    // null = 上限内で回り込めない。ほぼ分断なので最優先
    const detour = steps === null ? cap : steps;
    if (detour < BRIDGE_MIN_DETOUR) continue;
    // 橋を渡る歩数（幅＋1）に対して十分な近道になっているか
    if (detour < (span.tiles.length + 1) * BRIDGE_MIN_DETOUR_RATIO) continue;
    // 迂回が長く、橋が短いほど良い
    const score = detour - span.tiles.length * 2;
    if (score > bestScore) {
      bestScore = score;
      best = span;
    }
  }
  return best;
}

// ---------- 井戸・天文台の予定地 ----------

/** 設置・建設に使えるタイルか（歩けて、資源も設置物も無い） */
function isFreeTile(world: IslandWorld, x: number, y: number): boolean {
  if (!world.isWalkableTile(x, y)) return false;
  if (world.resourceOnTile(x, y)) return false;
  for (const p of world.placeables.values()) {
    if (Math.floor(p.pos.x) === x && Math.floor(p.pos.y) === y) return false;
  }
  return true;
}

/** 広場の近く（WELL_DIST_MIN..MAX）で、広場中心にいちばん近い空きタイル */
function findWellTile(world: IslandWorld): Vec2 | null {
  const sx = Math.floor(world.spawn.x);
  const sy = Math.floor(world.spawn.y);
  const r = WELL_DIST_MAX;
  const found: Vec2[] = [];
  for (let y = sy - r; y <= sy + r; y++) {
    for (let x = sx - r; x <= sx + r; x++) {
      const d = Math.hypot(x - sx, y - sy);
      if (d < WELL_DIST_MIN || d > WELL_DIST_MAX) continue;
      if (!isFreeTile(world, x, y)) continue;
      found.push({ x, y });
    }
  }
  if (found.length === 0) return null;
  // 距離 → x → y の順で並べて先頭を取る（seedに依らず安定）
  found.sort(
    (a, b) =>
      Math.hypot(a.x - sx, a.y - sy) - Math.hypot(b.x - sx, b.y - sy) || a.x - b.x || a.y - b.y,
  );
  const near = found.slice(0, 8);
  return near[world.rng.int(0, near.length - 1)] as Vec2;
}

/**
 * 天文台の予定地。森ではない歩ける場所で、島の中心から遠い（＝端に近い高台）ところ。
 * 広場と橋から離れているほうが「わざわざ行く場所」になるので距離で加点する。
 */
function findObservatoryTile(world: IslandWorld, avoid: readonly Vec2[]): Vec2 | null {
  const ccx = MAP_W / 2;
  const ccy = MAP_H / 2;
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let y = 2; y < MAP_H - 2; y++) {
    for (let x = 2; x < MAP_W - 2; x++) {
      const t = world.terrainAt(x, y);
      if (t === 'water' || t === 'forest') continue;
      if (!isFreeTile(world, x, y)) continue;
      const fromCenter = Math.hypot(x + 0.5 - ccx, y + 0.5 - ccy);
      if (fromCenter < OBSERVATORY_MIN_DIST_FROM_CENTER) continue;
      let nearest = Infinity;
      for (const a of avoid) nearest = Math.min(nearest, Math.hypot(x - a.x, y - a.y));
      const score = fromCenter + (nearest === Infinity ? 0 : Math.min(20, nearest));
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best;
}

// ---------- 本体 ----------

export class BuildSystem {
  private world: IslandWorld;
  private deps: BuildDeps;
  private map = new Map<EntityId, Construction>();
  /** playerId → 最後に貢献したtick（クールダウン判定） */
  private lastContribTick = new Map<PlayerId, number>();
  private placed = 0;
  private removed = 0;
  private completed = 0;
  private contributed = 0;
  private rejects = new Map<string, number>();

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(world: IslandWorld, deps: BuildDeps) {
    this.world = world;
    this.deps = deps;
  }

  private nameOf(playerId: PlayerId): string {
    return this.deps.nameOf?.(playerId) ?? playerId;
  }

  private reject(reason: string): void {
    this.rejects.set(reason, (this.rejects.get(reason) ?? 0) + 1);
  }

  // ---------- 設置物 ----------

  /** プレイヤーが設置物を置く。位置はタイル座標 */
  place(opts: {
    playerId: PlayerId;
    type: PlaceableType;
    pos: Vec2;
    playerPos: Vec2;
    tick: number;
  }): PlaceResult {
    // zod で検証済みの経路以外（テストや将来の呼び出し元）から来た未知の種別も弾く
    const attract = (PLACE_ATTRACT as Record<string, number | undefined>)[opts.type];
    if (attract === undefined) {
      this.reject('unknown_type');
      return { ok: false, reason: 'unknown_type' };
    }

    const x = Math.floor(opts.pos.x);
    const y = Math.floor(opts.pos.y);
    const center: Vec2 = { x: x + 0.5, y: y + 0.5 };

    // 持ち物の上限は位置に関係なく効く（先に弾いて走査を省く）
    let mine = 0;
    for (const p of this.world.placeables.values()) if (p.ownerId === opts.playerId) mine++;
    if (mine >= MAX_PLACEABLES_PER_PLAYER) {
      this.reject('too_many');
      return { ok: false, reason: 'too_many' };
    }

    if (distance(opts.playerPos, center) > PLACE_RANGE_TILES) {
      this.reject('out_of_range');
      return { ok: false, reason: 'out_of_range' };
    }
    // 水の上・島の外は不可。resourceOnTile とは別に木の実の木などとも重ねない
    if (!this.world.isWalkableTile(x, y)) {
      this.reject('not_walkable');
      return { ok: false, reason: 'not_walkable' };
    }
    if (this.world.resourceOnTile(x, y)) {
      this.reject('occupied');
      return { ok: false, reason: 'occupied' };
    }

    // 近傍だけ見る（placeablesNear は全走査だが件数が小さいので許容）
    for (const p of this.world.placeablesNear(center, PLACE_MIN_GAP_TILES)) {
      const same = Math.floor(p.pos.x) === x && Math.floor(p.pos.y) === y;
      if (same) {
        this.reject('occupied');
        return { ok: false, reason: 'occupied' };
      }
      if (distance(p.pos, center) < PLACE_MIN_GAP_TILES) {
        this.reject('too_close');
        return { ok: false, reason: 'too_close' };
      }
    }
    // 建設予定地にも重ねない
    for (const c of this.map.values()) {
      if (Math.floor(c.pos.x) === x && Math.floor(c.pos.y) === y) {
        this.reject('occupied');
        return { ok: false, reason: 'occupied' };
      }
    }

    const placeable: Placeable = {
      id: this.world.allocId(),
      type: opts.type,
      pos: center,
      ownerId: opts.playerId,
      attract,
    };
    this.world.addPlaceable(placeable);
    this.placed++;
    this.deps.emitEvent({
      kind: 'build',
      text: `${this.nameOf(opts.playerId)}が${PLACEABLE_LABEL[opts.type]}を置いた`,
      pos: center,
    });
    return { ok: true, placeable };
  }

  /** 設置物を撤去する（自分が置いたものだけ） */
  remove(opts: { playerId: PlayerId; placeableId: EntityId }): boolean {
    const p = this.world.placeables.get(opts.placeableId);
    if (!p || p.ownerId !== opts.playerId) return false;
    this.world.placeables.delete(p.id);
    this.removed++;
    this.deps.emitEvent({
      kind: 'build',
      text: `${this.nameOf(opts.playerId)}が${PLACEABLE_LABEL[p.type]}を片付けた`,
      pos: p.pos,
      importance: 3,
    });
    return true;
  }

  // ---------- 共同建設 ----------

  /** 建設予定地を島に用意する（新規島の生成時に呼ぶ。seedで決定論的に置く） */
  seedConstructions(): Construction[] {
    // 二重呼び出しで予定地が増えないようにする（復元経路と併用されても安全に）
    if (this.map.size > 0) return this.constructions();

    const avoid: Vec2[] = [{ x: Math.floor(this.world.spawn.x), y: Math.floor(this.world.spawn.y) }];

    const span = findBridgeSpan(this.world);
    if (span) {
      this.add('bridge', spanCenter(span));
      avoid.push(span.shoreA);
    }

    const well = findWellTile(this.world);
    if (well) {
      this.add('well', { x: well.x + 0.5, y: well.y + 0.5 });
      avoid.push(well);
    }

    const obs = findObservatoryTile(this.world, avoid);
    if (obs) this.add('observatory', { x: obs.x + 0.5, y: obs.y + 0.5 });

    return this.constructions();
  }

  private add(type: ConstructionType, pos: Vec2): Construction {
    const c: Construction = {
      id: this.world.allocId(),
      type,
      pos,
      progress: 0,
      contributions: {},
    };
    this.map.set(c.id, c);
    return c;
  }

  /** 共同建設に貢献する。progressは0..100 */
  contribute(opts: {
    playerId: PlayerId;
    constructionId: EntityId;
    playerPos: Vec2;
    tick: number;
  }): ContributeResult {
    const c = this.map.get(opts.constructionId);
    if (!c) {
      this.reject('not_found');
      return { ok: false, reason: 'not_found' };
    }
    if (c.completedAtTick !== undefined) {
      this.reject('already_done');
      return { ok: false, reason: 'already_done' };
    }
    if (distance(opts.playerPos, c.pos) > CONTRIBUTE_RANGE_TILES) {
      this.reject('too_far');
      return { ok: false, reason: 'too_far' };
    }
    const last = this.lastContribTick.get(opts.playerId);
    if (last !== undefined && opts.tick - last < CONTRIBUTE_COOLDOWN_TICKS) {
      this.reject('rate');
      return { ok: false, reason: 'rate' };
    }

    this.lastContribTick.set(opts.playerId, opts.tick);
    c.progress = Math.min(CONSTRUCTION_GOAL, c.progress + CONTRIBUTE_STEP);
    c.contributions[opts.playerId] = (c.contributions[opts.playerId] ?? 0) + CONTRIBUTE_STEP;
    this.contributed++;

    let completed = false;
    if (c.progress >= CONSTRUCTION_GOAL) {
      this.complete(c, opts.tick);
      completed = true;
    }
    return { ok: true, construction: c, progress: c.progress, completed };
  }

  /** 完成の効果を適用する（地形・資源・設置物）。復元時にも使う */
  private complete(c: Construction, tick: number): void {
    c.completedAtTick = tick;
    c.progress = CONSTRUCTION_GOAL;
    this.applyEffect(c);
    this.completed++;
    this.deps.emitEvent({
      kind: 'build',
      text: `${CONSTRUCTION_LABEL[c.type]}が完成した`,
      pos: c.pos,
      importance: 8,
    });
  }

  /**
   * 完成した建設物が島に及ぼす効果。
   *
   * 地形（橋）はスナップショットに入らない（terrain は seed から作り直される）ので、
   * 復元時にもう一度呼ぶ必要がある。資源と設置物は永続化されるので `withPersisted`
   * が true のときだけ足す。
   */
  private applyEffect(c: Construction, withPersisted = true): void {
    if (c.type === 'bridge') {
      const tiles = bridgeTilesAt(this.world, c.pos);
      if (tiles.length === 0) return; // すでに陸（復元で二重に適用されたときなど）
      for (const t of tiles) this.world.setTerrain(t.x, t.y, 'dirt');
      this.deps.onTerrainChanged(tiles.map((t) => ({ x: t.x, y: t.y })));
      return;
    }
    if (!withPersisted) return;
    if (c.type === 'well') {
      // 広場の近くに水場が増える（動物の水飲み場になる）
      this.world.addResource({
        id: this.world.allocId(),
        type: 'water',
        pos: { x: c.pos.x, y: c.pos.y },
        amount: RESOURCE.waterSourceMax,
        max: RESOURCE.waterSourceMax,
        regenPerIslandHour: RESOURCE.waterRegenPerIslandHour,
      });
      // 水場の資源は地形で表現するのでクライアントが絵を出さない（objects.ts が water を飛ばす）。
      // それだけだと**完成した井戸が画面に何も現れない**ので、見た目の設置物も置く（G-2）。
      this.world.addPlaceable({
        id: this.world.allocId(),
        type: 'well',
        pos: { x: c.pos.x, y: c.pos.y },
        ownerId: ISLAND_OWNER,
        attract: 0,
      });
      return;
    }
    // 天文台は地形を変えない。attract の高い設置物として島の名所になる。
    // 以前は絵が無いのでランタンで代用していたが、それでは天文台に見えない（G-2）
    this.world.addPlaceable({
      id: this.world.allocId(),
      type: 'observatory',
      pos: { x: c.pos.x, y: c.pos.y },
      ownerId: ISLAND_OWNER,
      attract: OBSERVATORY_ATTRACT,
    });
  }

  /** 建設中・完成済みの一覧（クライアントへの配信用） */
  constructions(): Construction[] {
    return [...this.map.values()];
  }

  construction(id: EntityId): Construction | undefined {
    return this.map.get(id);
  }

  /**
   * スナップショット復元用。
   *
   * 地形は seed から作り直されるため、**完成済みの橋はここで地形を張り直す**
   * （張り直さないと再起動で橋が水に戻り、通れなくなる）。
   * 井戸の水場と天文台の設置物は資源・設置物として永続化されているので足さない。
   */
  restore(constructions: readonly Construction[]): void {
    this.map.clear();
    this.lastContribTick.clear();
    for (const src of constructions) {
      const c: Construction = {
        id: src.id,
        type: src.type,
        pos: { x: src.pos.x, y: src.pos.y },
        progress: src.progress,
        contributions: { ...src.contributions },
        ...(src.completedAtTick !== undefined ? { completedAtTick: src.completedAtTick } : {}),
      };
      this.map.set(c.id, c);
      this.world.setNextId(c.id + 1);
      if (c.completedAtTick !== undefined) this.applyEffect(c, false);
    }
  }

  stats(): Record<string, unknown> {
    const byType: Record<string, number> = {};
    for (const p of this.world.placeables.values()) byType[p.type] = (byType[p.type] ?? 0) + 1;
    const progress: Record<string, number> = {};
    for (const c of this.map.values()) progress[`${c.type}#${c.id}`] = c.progress;
    const rejects: Record<string, number> = {};
    for (const [k, v] of this.rejects) rejects[k] = v;
    return {
      placeables: this.world.placeables.size,
      placeablesByType: byType,
      placed: this.placed,
      removed: this.removed,
      constructions: this.map.size,
      completed: this.completed,
      contributions: this.contributed,
      progress,
      rejects,
    };
  }
}

/** テストと配線から参照するための公開（TODO: constants.ts へ移すときに整理する） */
export const BUILD_TUNING = {
  attract: PLACE_ATTRACT,
  placeRangeTiles: PLACE_RANGE_TILES,
  placeMinGapTiles: PLACE_MIN_GAP_TILES,
  maxPlaceablesPerPlayer: MAX_PLACEABLES_PER_PLAYER,
  contributeRangeTiles: CONTRIBUTE_RANGE_TILES,
  contributeStep: CONTRIBUTE_STEP,
  contributeCooldownTicks: CONTRIBUTE_COOLDOWN_TICKS,
  constructionGoal: CONSTRUCTION_GOAL,
  bridgeMaxSpan: BRIDGE_MAX_SPAN,
  bridgeMinDetour: BRIDGE_MIN_DETOUR,
  observatoryAttract: OBSERVATORY_ATTRACT,
  islandOwner: ISLAND_OWNER,
} as const;
