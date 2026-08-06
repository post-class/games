/**
 * 受信状態の保持（docs/02_ゲーム実装プラン/06_クライアント設計.md §1）
 *
 * snapshot / delta / chunk を適用して「地形」と「Map<EntityId, ActorView>」を更新するだけの層。
 * テストしやすいように **Pixi には一切依存しない**。描画は render/ 側が本モジュールを読むだけ。
 *
 * 制約:
 * - parameter property 禁止
 * - enum / namespace 禁止
 */
import {
  CHUNK,
  CHUNKS_X,
  INTERP_DELAY_MS,
  MAP_H,
  MAP_W,
  decodeAnim,
  decodeFacing,
  rleDecode,
  type ActorDelta,
  type ActorKind,
  type ActorWire,
  type AnimName,
  type EntityId,
  type Facing,
  type PlaceableWire,
  type ResourceWire,
  type Vec2,
} from '@ai-pet/shared';

/** 補間バッファの1点 */
export interface PosSample {
  /** 受信時刻（performance.now 相当のms） */
  t: number;
  x: number;
  y: number;
}

/** 描画側が参照するアクターの状態 */
export interface ActorView {
  id: EntityId;
  kind: ActorKind;
  species: string;
  name: string;
  ownerId?: string;
  /** 最後に受信した位置（予測・補正の基準） */
  x: number;
  y: number;
  facing: Facing;
  anim: AnimName;
  /** 補間用の位置バッファ（時刻昇順） */
  buf: PosSample[];
  /** 最後に何らかの更新を受けた時刻（ms） */
  lastRecvAt: number;
}

export interface ResourceView {
  id: EntityId;
  type: string;
  x: number;
  y: number;
  amount: number;
  max: number;
}

export interface PlaceableView {
  id: EntityId;
  type: string;
  x: number;
  y: number;
  ownerId: string;
}

/** ワイヤの k を ActorKind に戻す */
export function kindFromWire(k: number): ActorKind {
  return k === 2 ? 'player' : k === 1 ? 'pet' : 'critter';
}

/** 補間バッファに残す長さ（ms）。遅延ぶん＋余裕 */
const BUFFER_KEEP_MS = INTERP_DELAY_MS + 850;

/** チャンク座標 → キー */
export function chunkKey(cx: number, cy: number): number {
  return cy * CHUNKS_X + cx;
}

/**
 * chunkメッセージの地形RLEをタイル配列（CHUNK*CHUNK, 行優先）に戻す。
 * tilemap の焼成と、テストの両方から使う。
 */
export function decodeChunkTerrain(rle: readonly number[]): number[] {
  return rleDecode(rle, CHUNK * CHUNK);
}

export interface ChunkMsgLike {
  cx: number;
  cy: number;
  terrain: number[];
  resources?: ResourceWire[];
}

export interface SnapshotMsgLike {
  tick: number;
  actors: ActorWire[];
  resources?: ResourceWire[];
  placeables?: PlaceableWire[];
}

export interface DeltaMsgLike {
  tick: number;
  upd?: ActorDelta[];
  add?: ActorWire[];
  rm?: number[];
  res?: { i: number; amt: number }[];
}

/** chunk適用の結果（tilemapが焼成に使う） */
export interface AppliedChunk {
  cx: number;
  cy: number;
  tiles: number[];
}

/**
 * クライアント側の世界状態。
 * すべての適用メソッドは「受信時刻 nowMs」を引数で受け取る（テストで時刻を固定するため）。
 */
export class WorldState {
  readonly actors = new Map<EntityId, ActorView>();
  readonly resources = new Map<EntityId, ResourceView>();
  readonly placeables = new Map<EntityId, PlaceableView>();

  /** 地形（TERRAINSのindex）。未受信チャンクは -1 のまま＝描かない */
  readonly terrain: Int8Array;
  /** 受信済みチャンクのキー集合 */
  readonly loadedChunks = new Set<number>();

  /** 自分のアバターのentityId（welcomeで設定） */
  selfId: EntityId | null = null;
  /** 自ペットのentityId */
  petId: EntityId | null = null;
  /** 最後にsnapshot/deltaを受けたtick */
  tick = 0;
  /** 最後にsnapshot/deltaを受けた時刻（ms）。接続不安定の判定に使う */
  lastSyncAt = 0;

  constructor() {
    this.terrain = new Int8Array(MAP_W * MAP_H).fill(-1);
  }

  // ---------- 地形 ----------

  terrainAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return -1;
    return this.terrain[y * MAP_W + x] as number;
  }

  hasChunk(cx: number, cy: number): boolean {
    return this.loadedChunks.has(chunkKey(cx, cy));
  }

  /** chunkメッセージを適用する。未受信チャンクは描かないので、ここで初めて地形が入る */
  applyChunk(msg: ChunkMsgLike): AppliedChunk {
    const tiles = decodeChunkTerrain(msg.terrain);
    const x0 = msg.cx * CHUNK;
    const y0 = msg.cy * CHUNK;
    for (let ty = 0; ty < CHUNK; ty++) {
      for (let tx = 0; tx < CHUNK; tx++) {
        const x = x0 + tx;
        const y = y0 + ty;
        if (x >= MAP_W || y >= MAP_H) continue;
        this.terrain[y * MAP_W + x] = tiles[ty * CHUNK + tx] as number;
      }
    }
    this.loadedChunks.add(chunkKey(msg.cx, msg.cy));
    for (const r of msg.resources ?? []) this.putResource(r);
    return { cx: msg.cx, cy: msg.cy, tiles };
  }

  // ---------- アクター ----------

  private putActorWire(w: ActorWire, nowMs: number): ActorView {
    const existing = this.actors.get(w.i);
    if (existing) {
      existing.species = w.s;
      existing.name = w.n;
      existing.facing = decodeFacing(w.f);
      existing.anim = decodeAnim(w.a);
      if (w.o !== undefined) existing.ownerId = w.o;
      this.pushSample(existing, w.x, w.y, nowMs);
      return existing;
    }
    const view: ActorView = {
      id: w.i,
      kind: kindFromWire(w.k),
      species: w.s,
      name: w.n,
      x: w.x,
      y: w.y,
      facing: decodeFacing(w.f),
      anim: decodeAnim(w.a),
      buf: [{ t: nowMs, x: w.x, y: w.y }],
      lastRecvAt: nowMs,
    };
    if (w.o !== undefined) view.ownerId = w.o;
    this.actors.set(w.i, view);
    return view;
  }

  /** 位置サンプルを積む（時刻昇順を保ち、古いものを捨てる） */
  private pushSample(view: ActorView, x: number, y: number, nowMs: number): void {
    view.x = x;
    view.y = y;
    view.lastRecvAt = nowMs;
    const last = view.buf[view.buf.length - 1];
    if (last && nowMs <= last.t) {
      // 同時刻に複数届いたら最後の値で上書きする（順序の逆転を作らない）
      last.x = x;
      last.y = y;
      return;
    }
    view.buf.push({ t: nowMs, x, y });
    // 補間に必要な区間だけ残す（先頭は now-遅延 より前の1点を必ず残す）
    while (view.buf.length > 2) {
      const second = view.buf[1] as PosSample;
      if (second.t >= nowMs - BUFFER_KEEP_MS) break;
      view.buf.shift();
    }
  }

  applySnapshot(msg: SnapshotMsgLike, nowMs: number): void {
    this.tick = msg.tick;
    this.lastSyncAt = nowMs;
    const seen = new Set<EntityId>();
    for (const w of msg.actors) {
      this.putActorWire(w, nowMs);
      seen.add(w.i);
    }
    // snapshotはフル同期なので、含まれないアクターは消す
    for (const id of [...this.actors.keys()]) {
      if (!seen.has(id)) this.actors.delete(id);
    }
    if (msg.resources) {
      this.resources.clear();
      for (const r of msg.resources) this.putResource(r);
    }
    if (msg.placeables) {
      this.placeables.clear();
      for (const p of msg.placeables) {
        this.placeables.set(p.i, { id: p.i, type: p.ty, x: p.x, y: p.y, ownerId: p.o });
      }
    }
  }

  applyDelta(msg: DeltaMsgLike, nowMs: number): void {
    this.tick = msg.tick;
    this.lastSyncAt = nowMs;
    for (const w of msg.add ?? []) this.putActorWire(w, nowMs);
    for (const d of msg.upd ?? []) {
      const v = this.actors.get(d.i);
      if (!v) continue; // 未知のIDは無視（addが届く前のupd）
      if (d.f !== undefined) v.facing = decodeFacing(d.f);
      if (d.a !== undefined) v.anim = decodeAnim(d.a);
      const nx = d.x ?? v.x;
      const ny = d.y ?? v.y;
      this.pushSample(v, nx, ny, nowMs);
    }
    for (const id of msg.rm ?? []) this.actors.delete(id);
    for (const r of msg.res ?? []) {
      const node = this.resources.get(r.i);
      if (node) node.amount = r.amt;
    }
  }

  private putResource(r: ResourceWire): void {
    this.resources.set(r.i, { id: r.i, type: r.ty, x: r.x, y: r.y, amount: r.amt, max: r.max });
  }

  /** 自ペットを探す（ownerIdが一致するpet） */
  findPet(ownerId: string): ActorView | null {
    for (const v of this.actors.values()) {
      if (v.kind === 'pet' && v.ownerId === ownerId) return v;
    }
    return null;
  }
}

/**
 * 補間バッファから指定時刻の位置を線形補間で求める（docs 05章 §6）。
 * - バッファが空なら null
 * - 指定時刻が先頭より前なら先頭の位置
 * - 指定時刻が末尾より後なら **末尾の位置で止まる**（受信が途切れたときの挙動）
 */
export function sampleAt(buf: readonly PosSample[], timeMs: number): Vec2 | null {
  if (buf.length === 0) return null;
  const first = buf[0] as PosSample;
  if (buf.length === 1 || timeMs <= first.t) return { x: first.x, y: first.y };
  const last = buf[buf.length - 1] as PosSample;
  if (timeMs >= last.t) return { x: last.x, y: last.y };
  for (let i = 1; i < buf.length; i++) {
    const b = buf[i] as PosSample;
    if (b.t < timeMs) continue;
    const a = buf[i - 1] as PosSample;
    const span = b.t - a.t;
    const k = span <= 0 ? 1 : (timeMs - a.t) / span;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }
  return { x: last.x, y: last.y };
}

/** 描画に使う時刻（now - 150ms） */
export function renderTime(nowMs: number): number {
  return nowMs - INTERP_DELAY_MS;
}

/** アクターの描画位置。バッファが空なら最後の受信値を使う */
export function interpolatedPos(view: ActorView, nowMs: number): Vec2 {
  return sampleAt(view.buf, renderTime(nowMs)) ?? { x: view.x, y: view.y };
}
