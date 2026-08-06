/**
 * 経路探索（docs/02_ゲーム実装プラン/04_サーバ設計.md §4 移動と経路探索）
 *
 * 方針:
 * - タイルグリッド上の 8方向 A*。斜めは角抜けを禁止する
 * - 距離12タイル以内で直進できるなら A* を走らせない（NavService 側で判定）
 * - A* は 1tick あたり最大8件だけ処理する（キュー）
 * - 展開ノードが maxNodes を超えたら諦めて null（無限ループ・スパイク防止）
 *
 * 制約: Math.random() 禁止 / parameter property 禁止 / enum 禁止
 */
import { ACTOR_RADIUS, MAP_H, MAP_W, type EntityId, type Vec2 } from '@ai-pet/shared';
import { inBounds, tileIndex, type IslandWorld } from './world.ts';

/** 直進最適化を試す最大距離（タイル） */
export const STRAIGHT_MAX_TILES = 12;
/** A* の展開ノード上限の既定値 */
export const DEFAULT_MAX_NODES = 4000;
/** 1tick に処理する経路探索リクエストの上限 */
export const NAV_REQUESTS_PER_TICK = 8;

const SQRT2 = Math.SQRT2;
const TILE_COUNT = MAP_W * MAP_H;

// ---------- A* の作業領域（毎回確保すると重いので使い回す） ----------
// 世代スタンプ方式：generation を進めるだけで配列のクリアを省く。
const gScore = new Float64Array(TILE_COUNT);
const fScore = new Float64Array(TILE_COUNT);
const cameFrom = new Int32Array(TILE_COUNT);
const seenGen = new Int32Array(TILE_COUNT);
const closedGen = new Int32Array(TILE_COUNT);
let generation = 0;

/** 最小ヒープ（f値の小さい順）。ノード番号とコストを並列配列で持つ */
class MinHeap {
  private nodes: number[];
  private costs: number[];

  constructor() {
    this.nodes = [];
    this.costs = [];
  }

  get size(): number {
    return this.nodes.length;
  }

  clear(): void {
    this.nodes.length = 0;
    this.costs.length = 0;
  }

  push(node: number, cost: number): void {
    const nodes = this.nodes;
    const costs = this.costs;
    nodes.push(node);
    costs.push(cost);
    let i = nodes.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((costs[p] as number) <= (costs[i] as number)) break;
      const tn = nodes[p] as number;
      const tc = costs[p] as number;
      nodes[p] = nodes[i] as number;
      costs[p] = costs[i] as number;
      nodes[i] = tn;
      costs[i] = tc;
      i = p;
    }
  }

  /** 空なら -1 */
  pop(): number {
    const nodes = this.nodes;
    const costs = this.costs;
    const n = nodes.length;
    if (n === 0) return -1;
    const top = nodes[0] as number;
    const lastNode = nodes.pop() as number;
    const lastCost = costs.pop() as number;
    if (n > 1) {
      nodes[0] = lastNode;
      costs[0] = lastCost;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < nodes.length && (costs[l] as number) < (costs[m] as number)) m = l;
        if (r < nodes.length && (costs[r] as number) < (costs[m] as number)) m = r;
        if (m === i) break;
        const tn = nodes[m] as number;
        const tc = costs[m] as number;
        nodes[m] = nodes[i] as number;
        costs[m] = costs[i] as number;
        nodes[i] = tn;
        costs[i] = tc;
        i = m;
      }
    }
    return top;
  }
}

const heap = new MinHeap();

/** octile 距離（8方向移動の下限コスト） */
function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx < dy ? dx * (SQRT2 - 1) + dy : dy * (SQRT2 - 1) + dx;
}

function tileCenter(x: number, y: number): Vec2 {
  return { x: x + 0.5, y: y + 0.5 };
}

/** 8近傍のオフセット（斜めは後半） */
const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

/**
 * A*。到達不能なら null。経路はタイル中心座標の配列（from は含まない）。
 * from と to が同じタイルなら空配列を返す。
 */
export function findPath(world: IslandWorld, from: Vec2, to: Vec2, opts?: { maxNodes?: number }): Vec2[] | null {
  const maxNodes = opts?.maxNodes ?? DEFAULT_MAX_NODES;
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  const gx = Math.floor(to.x);
  const gy = Math.floor(to.y);

  if (!inBounds(sx, sy) || !inBounds(gx, gy)) return null;
  // 目的地が歩けないなら諦める（呼び出し側が nearestWalkable でずらす）
  if (!world.isWalkableTile(gx, gy)) return null;
  if (sx === gx && sy === gy) return [];

  generation++;
  const gen = generation;
  heap.clear();

  const start = tileIndex(sx, sy);
  const goal = tileIndex(gx, gy);
  gScore[start] = 0;
  fScore[start] = heuristic(sx, sy, gx, gy);
  cameFrom[start] = -1;
  seenGen[start] = gen;
  heap.push(start, fScore[start] as number);

  let expanded = 0;

  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur < 0) break;
    if (closedGen[cur] === gen) continue;
    closedGen[cur] = gen;

    if (cur === goal) return reconstruct(cur, start);

    expanded++;
    if (expanded > maxNodes) return null;

    const cx = cur % MAP_W;
    const cy = (cur - cx) / MAP_W;
    const cg = gScore[cur] as number;

    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!world.isWalkableTile(nx, ny)) continue;
      // 斜めの角抜けを禁止（隣接する2つの直交タイル両方が歩けること）
      if (dx !== 0 && dy !== 0) {
        if (!world.isWalkableTile(cx + dx, cy)) continue;
        if (!world.isWalkableTile(cx, cy + dy)) continue;
      }
      const ni = tileIndex(nx, ny);
      if (closedGen[ni] === gen) continue;
      const ng = cg + cost;
      if (seenGen[ni] === gen && ng >= (gScore[ni] as number)) continue;
      seenGen[ni] = gen;
      gScore[ni] = ng;
      cameFrom[ni] = cur;
      const nf = ng + heuristic(nx, ny, gx, gy);
      fScore[ni] = nf;
      heap.push(ni, nf);
    }
  }
  return null;
}

function reconstruct(goal: number, start: number): Vec2[] {
  const rev: number[] = [];
  let cur = goal;
  while (cur !== start && cur >= 0) {
    rev.push(cur);
    cur = cameFrom[cur] as number;
  }
  const out: Vec2[] = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const t = rev[i] as number;
    const x = t % MAP_W;
    out.push(tileCenter(x, (t - x) / MAP_W));
  }
  return out;
}

/**
 * 近距離（既定 STRAIGHT_MAX_TILES 以内）の直進可否。
 * アクター半径ぶんの余裕を見るため world.canStandAt でサンプリングする。
 */
export function hasLineOfWalk(world: IslandWorld, from: Vec2, to: Vec2): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist > STRAIGHT_MAX_TILES) return false;
  if (!world.canStandAt(to)) return false;
  if (dist < 1e-6) return true;

  // 半径より細かい刻みで見る（薄い壁をすり抜けないように）
  const step = ACTOR_RADIUS * 0.5;
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (!world.canStandAt({ x: from.x + dx * t, y: from.y + dy * t })) return false;
  }
  return true;
}

/**
 * 目的地が歩けない場合に、最も近い歩けるタイル（の中心）を探す。
 * 半径0（目的地そのもの）から外側へリング状に広げる。
 */
export function nearestWalkable(world: IslandWorld, target: Vec2, maxRadius = 12): Vec2 | null {
  const tx = Math.floor(target.x);
  const ty = Math.floor(target.y);
  if (inBounds(tx, ty) && world.isWalkableTile(tx, ty)) return tileCenter(tx, ty);

  for (let r = 1; r <= maxRadius; r++) {
    let best: Vec2 | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // リングの外周のみ
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (!world.isWalkableTile(x, y)) continue;
        const c = tileCenter(x, y);
        const d = (c.x - target.x) * (c.x - target.x) + (c.y - target.y) * (c.y - target.y);
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

interface NavRequest {
  actorId: EntityId;
  to: Vec2;
}

/**
 * 経路探索リクエストのキュー。1tick に最大 NAV_REQUESTS_PER_TICK 件だけ処理する。
 * 同じアクターの重複リクエストは最新のものだけを残す（連続クリック対策）。
 */
export class NavService {
  private world: IslandWorld;
  private queue: NavRequest[];
  private index: Map<EntityId, NavRequest>;
  /** 直進最適化で済んだ件数（メトリクス用） */
  straightCount = 0;
  /** A* を走らせた件数（メトリクス用） */
  astarCount = 0;
  /** 経路が見つからなかった件数（メトリクス用） */
  failCount = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(world: IslandWorld) {
    this.world = world;
    this.queue = [];
    this.index = new Map();
  }

  request(actorId: EntityId, to: Vec2): void {
    const existing = this.index.get(actorId);
    if (existing) {
      existing.to = { x: to.x, y: to.y };
      return;
    }
    const req: NavRequest = { actorId, to: { x: to.x, y: to.y } };
    this.queue.push(req);
    this.index.set(actorId, req);
  }

  pending(): number {
    return this.queue.length;
  }

  clear(actorId: EntityId): void {
    const req = this.index.get(actorId);
    if (!req) return;
    this.index.delete(actorId);
    const i = this.queue.indexOf(req);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /** 処理した件数を返す。結果は actor.path に直接設定する */
  update(): number {
    let processed = 0;
    while (processed < NAV_REQUESTS_PER_TICK && this.queue.length > 0) {
      const req = this.queue.shift() as NavRequest;
      this.index.delete(req.actorId);
      const actor = this.world.actor(req.actorId);
      // 退場したアクターのリクエストは件数に数えない
      if (!actor) continue;
      processed++;
      actor.path = this.solve(actor.pos, req.to);
      if (actor.path === null) this.failCount++;
    }
    return processed;
  }

  /** 直進で足りるなら A* を省く。テストとデバッグ用に公開する */
  solve(from: Vec2, to: Vec2): Vec2[] | null {
    const world = this.world;
    // 1) 近距離かつ直進可能なら経路探索しない
    if (hasLineOfWalk(world, from, to)) {
      this.straightCount++;
      return [{ x: to.x, y: to.y }];
    }
    // 2) 目的地が歩けないなら、先に近傍の歩けるタイルへ寄せる
    //    （A*を空振りさせてから寄せると同じ探索を2回走らせることになり、
    //     到達不能な地形で1tickの予算を倍使ってしまう）
    let goal = to;
    if (!world.isWalkableTile(Math.floor(to.x), Math.floor(to.y))) {
      const alt = nearestWalkable(world, to);
      if (!alt) return null;
      goal = alt;
    }
    this.astarCount++;
    return findPath(world, from, goal);
  }
}

/** マップ範囲内へ丸める（アクター半径ぶん内側） */
export function clampToMap(pos: Vec2): Vec2 {
  const min = ACTOR_RADIUS;
  pos.x = Math.min(MAP_W - min, Math.max(min, pos.x));
  pos.y = Math.min(MAP_H - min, Math.max(min, pos.y));
  return pos;
}
