/**
 * 島の状態を保持する器（docs/02_ゲーム実装プラン/03_データモデル.md）
 *
 * ここは「データとその素朴なアクセサ」だけを持つ。
 * 生成は worldgen.ts、判断は critter.ts、移動は movement.ts が担当する。
 *
 * 制約:
 * - Math.random() 禁止（rng を使う）
 * - parameter property 禁止（Node の type-stripping で動かすため）
 */
import {
  ACTOR_RADIUS,
  CHUNK,
  CHUNKS_X,
  CHUNKS_Y,
  MAP_H,
  MAP_W,
  RESOURCE,
  Rng,
  TERRAINS,
  rleEncode,
  type Actor,
  type EntityId,
  type Placeable,
  type ResourceNode,
  type ResourceType,
  type Terrain,
  type Vec2,
} from '@ai-pet/shared';

/** 歩けない地形 */
const BLOCKED: ReadonlySet<Terrain> = new Set<Terrain>(['water']);

export function terrainIndex(t: Terrain): number {
  const i = TERRAINS.indexOf(t);
  return i < 0 ? 0 : i;
}

export function terrainFromIndex(i: number): Terrain {
  return TERRAINS[i] ?? 'grass';
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
}

export function tileIndex(x: number, y: number): number {
  return y * MAP_W + x;
}

export function chunkKey(cx: number, cy: number): number {
  return cy * CHUNKS_X + cx;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export class IslandWorld {
  readonly rng: Rng;
  /** 地形（TERRAINS のindex）。長さ MAP_W*MAP_H */
  readonly terrain: Uint8Array;
  /** 荒廃度 0..100 */
  readonly decay: Uint8Array;
  /** タイルに紐づく資源ID（0 = なし） */
  readonly resourceAt: Int32Array;

  readonly actors = new Map<EntityId, Actor>();
  readonly resources = new Map<EntityId, ResourceNode>();
  readonly placeables = new Map<EntityId, Placeable>();

  /** プレイヤーのスポーン地点（広場の中心） */
  spawn: Vec2 = { x: MAP_W / 2, y: MAP_H / 2 };

  private nextId = 1;

  constructor(rng: Rng) {
    this.rng = rng;
    this.terrain = new Uint8Array(MAP_W * MAP_H);
    this.decay = new Uint8Array(MAP_W * MAP_H);
    this.resourceAt = new Int32Array(MAP_W * MAP_H);
  }

  // ---------- ID ----------
  allocId(): EntityId {
    return this.nextId++;
  }

  /** スナップショット復元時に使う */
  setNextId(id: number): void {
    this.nextId = Math.max(this.nextId, id);
  }

  peekNextId(): number {
    return this.nextId;
  }

  // ---------- 地形 ----------
  terrainAt(x: number, y: number): Terrain {
    if (!inBounds(x, y)) return 'water';
    return terrainFromIndex(this.terrain[tileIndex(x, y)] as number);
  }

  setTerrain(x: number, y: number, t: Terrain): void {
    if (!inBounds(x, y)) return;
    this.terrain[tileIndex(x, y)] = terrainIndex(t);
  }

  /** タイル座標（整数）が歩けるか */
  isWalkableTile(x: number, y: number): boolean {
    if (!inBounds(x, y)) return false;
    return !BLOCKED.has(this.terrainAt(x, y));
  }

  /** 連続座標が歩けるか（アクターの半径を考慮） */
  canStandAt(pos: Vec2): boolean {
    const r = ACTOR_RADIUS;
    for (const [dx, dy] of [
      [-r, -r],
      [r, -r],
      [-r, r],
      [r, r],
    ] as const) {
      if (!this.isWalkableTile(Math.floor(pos.x + dx), Math.floor(pos.y + dy))) return false;
    }
    return true;
  }

  decayAt(x: number, y: number): number {
    if (!inBounds(x, y)) return 0;
    return this.decay[tileIndex(x, y)] as number;
  }

  addDecay(x: number, y: number, amount: number): void {
    if (!inBounds(x, y)) return;
    const i = tileIndex(x, y);
    const v = (this.decay[i] as number) + amount;
    this.decay[i] = Math.max(0, Math.min(RESOURCE.maxDecay, Math.round(v)));
  }

  /** チャンク内の地形をRLEで返す（プロトコルのchunkメッセージ用） */
  terrainRleForChunk(cx: number, cy: number): number[] {
    const values: number[] = [];
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    for (let y = y0; y < y0 + CHUNK; y++) {
      for (let x = x0; x < x0 + CHUNK; x++) {
        values.push(this.terrain[tileIndex(x, y)] as number);
      }
    }
    return rleEncode(values);
  }

  static chunkCount(): number {
    return CHUNKS_X * CHUNKS_Y;
  }

  static chunkOf(pos: Vec2): { cx: number; cy: number } {
    return { cx: Math.floor(pos.x / CHUNK), cy: Math.floor(pos.y / CHUNK) };
  }

  // ---------- アクター ----------
  addActor(actor: Actor): Actor {
    this.actors.set(actor.id, actor);
    return actor;
  }

  removeActor(id: EntityId): void {
    this.actors.delete(id);
  }

  actor(id: EntityId): Actor | undefined {
    return this.actors.get(id);
  }

  /** 半径内のアクター（自分を除く）。距離の近い順 */
  actorsNear(pos: Vec2, radius: number, exclude?: EntityId): Actor[] {
    const r2 = radius * radius;
    const out: Actor[] = [];
    for (const a of this.actors.values()) {
      if (a.id === exclude) continue;
      if (distanceSq(a.pos, pos) <= r2) out.push(a);
    }
    out.sort((p, q) => distanceSq(p.pos, pos) - distanceSq(q.pos, pos));
    return out;
  }

  // ---------- 資源 ----------
  addResource(node: ResourceNode): ResourceNode {
    this.resources.set(node.id, node);
    const x = Math.floor(node.pos.x);
    const y = Math.floor(node.pos.y);
    if (inBounds(x, y)) this.resourceAt[tileIndex(x, y)] = node.id;
    return node;
  }

  resourceOnTile(x: number, y: number): ResourceNode | undefined {
    if (!inBounds(x, y)) return undefined;
    const id = this.resourceAt[tileIndex(x, y)] as number;
    return id > 0 ? this.resources.get(id) : undefined;
  }

  /**
   * 指定種別のうち、半径内で最も近く在庫のあるもの。
   *
   * `minAmount` は「1回ぶん食べられる量が残っているか」の判定に使う。
   * これが無いと、ほぼ空（0.1しかない）の一番近い木を選び続けて、
   * 少し離れた満タンの木に行かずに餓死する（冬の大量死の原因だった）。
   */
  findNearestResource(
    pos: Vec2,
    types: readonly ResourceType[],
    radius: number,
    minAmount = 0,
  ): ResourceNode | null {
    let best: ResourceNode | null = null;
    let bestD = radius * radius;
    for (const r of this.resources.values()) {
      if (!types.includes(r.type)) continue;
      if (r.amount <= 0 || r.amount < minAmount) continue;
      const d = distanceSq(r.pos, pos);
      if (d <= bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  resourcesInChunk(cx: number, cy: number): ResourceNode[] {
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const out: ResourceNode[] = [];
    for (const r of this.resources.values()) {
      if (r.pos.x >= x0 && r.pos.x < x0 + CHUNK && r.pos.y >= y0 && r.pos.y < y0 + CHUNK) out.push(r);
    }
    return out;
  }

  // ---------- 設置物 ----------
  addPlaceable(p: Placeable): Placeable {
    this.placeables.set(p.id, p);
    return p;
  }

  placeablesNear(pos: Vec2, radius: number): Placeable[] {
    const r2 = radius * radius;
    const out: Placeable[] = [];
    for (const p of this.placeables.values()) {
      if (distanceSq(p.pos, pos) <= r2) out.push(p);
    }
    return out;
  }

  // ---------- 集計（テストとメトリクス用） ----------
  totalResourceAmount(): number {
    let sum = 0;
    for (const r of this.resources.values()) sum += r.amount;
    return sum;
  }

  decayedTileRatio(threshold = 50): number {
    let n = 0;
    for (let i = 0; i < this.decay.length; i++) if ((this.decay[i] as number) >= threshold) n++;
    return n / this.decay.length;
  }

  countActors(kind?: Actor['kind']): number {
    if (!kind) return this.actors.size;
    let n = 0;
    for (const a of this.actors.values()) if (a.kind === kind) n++;
    return n;
  }
}
