/**
 * 状態同期（docs/02_ゲーム実装プラン/05_通信プロトコル.md §4 ワイヤ形式 / §5 興味管理）
 *
 * 方針:
 * - 視界（view）を VIEW_MARGIN ぶん広げた矩形内のアクターだけを配信する
 * - 自分のアクターと自分のペットは範囲外でも常に送る（ミニマップ表示のため）
 * - クライアントごとに「前回送った ActorWire」を持ち、add / rm / upd を作る
 * - 位置は q2() で小数2桁。0.02タイル以上変化したときだけ upd に含める
 * - 資源は在庫が変化したものだけ res に含める
 *
 * 制約: Math.random() 禁止 / parameter property 禁止 / enum 禁止
 */
import {
  MAP_H,
  MAP_W,
  VIEW_MARGIN,
  VIEW_MAX_H,
  VIEW_MAX_W,
  encodeAnim,
  encodeFacing,
  q2,
  type Actor,
  type ActorDelta,
  type ActorWire,
  type ClockWire,
  type EntityId,
  type PlaceableWire,
  type ResourceNode,
  type ResourceWire,
  type ServerMsg,
} from '@ai-pet/shared';
import { actorToWire } from '../sim/actors.ts';
import type { IslandWorld } from '../sim/world.ts';

/** 位置差分をdeltaに載せる閾値（タイル） */
const POS_EPS = 0.02;
/** 浮動小数の丸め誤差ぶんの余裕 */
const POS_EPS_TOL = 1e-9;

/** ServerMsg のうち delta メッセージだけを取り出した型（組み立て時に union を絞るため） */
type DeltaMsg = Extract<ServerMsg, { t: 'delta' }>;

export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SyncClient {
  clientId: string;
  actorId: EntityId;
  /** 自分のペット（範囲外でも常に送る）。未作成なら null */
  petId: EntityId | null;
  view: ViewRect;
}

interface ClientState {
  c: SyncClient;
  /** 前回送った状態（i をキーにする） */
  sent: Map<EntityId, ActorWire>;
  /** 前回送った資源の在庫 */
  sentRes: Map<EntityId, number>;
}

/** view をマップ内・上限サイズに収める（クライアント発の値を信用しない） */
function sanitizeView(v: ViewRect): ViewRect {
  const x0 = Number.isFinite(v.x0) ? v.x0 : 0;
  const y0 = Number.isFinite(v.y0) ? v.y0 : 0;
  const x1 = Number.isFinite(v.x1) ? v.x1 : 0;
  const y1 = Number.isFinite(v.y1) ? v.y1 : 0;
  const lx = Math.min(x0, x1);
  const ly = Math.min(y0, y1);
  const hx = Math.min(lx + VIEW_MAX_W, Math.max(x0, x1));
  const hy = Math.min(ly + VIEW_MAX_H, Math.max(y0, y1));
  return {
    x0: Math.max(0, lx),
    y0: Math.max(0, ly),
    x1: Math.min(MAP_W, hx),
    y1: Math.min(MAP_H, hy),
  };
}

/** 配信範囲 = 視界 + VIEW_MARGIN */
function interestRect(v: ViewRect): ViewRect {
  return {
    x0: v.x0 - VIEW_MARGIN,
    y0: v.y0 - VIEW_MARGIN,
    x1: v.x1 + VIEW_MARGIN,
    y1: v.y1 + VIEW_MARGIN,
  };
}

function inRect(r: ViewRect, x: number, y: number): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

function resourceToWire(r: ResourceNode): ResourceWire {
  return { i: r.id, ty: r.type, x: q2(r.pos.x), y: q2(r.pos.y), amt: r.amount, max: r.max };
}

function byteLen(msg: ServerMsg): number {
  return Buffer.byteLength(JSON.stringify(msg), 'utf8');
}

export class SyncService {
  private world: IslandWorld;
  private states: Map<string, ClientState>;
  private lastDeltaBytes = 0;
  private totalBytes = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(world: IslandWorld) {
    this.world = world;
    this.states = new Map();
  }

  addClient(c: SyncClient): void {
    this.states.set(c.clientId, {
      c: { clientId: c.clientId, actorId: c.actorId, petId: c.petId, view: sanitizeView(c.view) },
      sent: new Map(),
      sentRes: new Map(),
    });
  }

  removeClient(clientId: string): void {
    this.states.delete(clientId);
  }

  updateView(clientId: string, view: ViewRect): void {
    const st = this.states.get(clientId);
    if (!st) return;
    st.c.view = sanitizeView(view);
  }

  /** ペット作成後に呼ぶ（範囲外でも常に送る対象を更新する） */
  setPetId(clientId: string, petId: EntityId | null): void {
    const st = this.states.get(clientId);
    if (!st) return;
    st.c.petId = petId;
  }

  /** チャンク配信メッセージを作る */
  chunkMessage(cx: number, cy: number): ServerMsg {
    const msg: ServerMsg = {
      t: 'chunk',
      cx,
      cy,
      terrain: this.world.terrainRleForChunk(cx, cy),
      resources: this.world.resourcesInChunk(cx, cy).map(resourceToWire),
    };
    this.totalBytes += byteLen(msg);
    return msg;
  }

  /** 初回・再同期用のフルスナップショット。前回送信状態をリセットする */
  snapshotMessage(clientId: string, clock: ClockWire): ServerMsg {
    const st = this.states.get(clientId);
    const actors: ActorWire[] = [];
    const resources: ResourceWire[] = [];
    const placeables: PlaceableWire[] = [];

    if (st) {
      st.sent.clear();
      st.sentRes.clear();
      const rect = interestRect(st.c.view);
      for (const a of this.visibleActors(st, rect)) {
        const w = actorToWire(a);
        st.sent.set(a.id, w);
        actors.push(w);
      }
      for (const r of this.world.resources.values()) {
        if (!inRect(rect, r.pos.x, r.pos.y)) continue;
        st.sentRes.set(r.id, r.amount);
        resources.push(resourceToWire(r));
      }
      for (const p of this.world.placeables.values()) {
        if (!inRect(rect, p.pos.x, p.pos.y)) continue;
        placeables.push({ i: p.id, ty: p.type, x: q2(p.pos.x), y: q2(p.pos.y), o: p.ownerId });
      }
    }

    const msg: ServerMsg = { t: 'snapshot', tick: clock.tick, clock, actors, resources, placeables };
    this.totalBytes += byteLen(msg);
    return msg;
  }

  /** 差分。変化がなければ null を返す（送らない） */
  deltaMessage(clientId: string, tick: number, clock?: ClockWire): ServerMsg | null {
    const st = this.states.get(clientId);
    if (!st) return null;
    const rect = interestRect(st.c.view);

    const add: ActorWire[] = [];
    const upd: ActorDelta[] = [];
    const rm: number[] = [];
    const res: { i: number; amt: number }[] = [];

    const seen = new Set<EntityId>();
    for (const a of this.visibleActors(st, rect)) {
      seen.add(a.id);
      const prev = st.sent.get(a.id);
      if (!prev) {
        const w = actorToWire(a);
        st.sent.set(a.id, w);
        add.push(w);
        continue;
      }
      const d = diffActor(prev, a);
      if (d) upd.push(d);
    }

    // 範囲から出た / 退場した
    for (const id of st.sent.keys()) {
      if (seen.has(id)) continue;
      rm.push(id);
    }
    for (const id of rm) st.sent.delete(id);

    // 資源は範囲内で在庫が変化したものだけ
    for (const r of this.world.resources.values()) {
      if (!inRect(rect, r.pos.x, r.pos.y)) continue;
      if (st.sentRes.get(r.id) === r.amount) continue;
      st.sentRes.set(r.id, r.amount);
      res.push({ i: r.id, amt: r.amount });
    }

    const changed = add.length > 0 || upd.length > 0 || rm.length > 0 || res.length > 0;
    // clock は「島時間が変わった」という変化なので、渡された場合は送る
    if (!changed && !clock) return null;

    const msg: DeltaMsg = { t: 'delta', tick };
    if (upd.length > 0) msg.upd = upd;
    if (add.length > 0) msg.add = add;
    if (rm.length > 0) msg.rm = rm;
    if (res.length > 0) msg.res = res;
    if (clock) msg.clock = clock;

    this.lastDeltaBytes = byteLen(msg);
    this.totalBytes += this.lastDeltaBytes;
    return msg;
  }

  /** 送信量の統計（メトリクス用） */
  stats(): { clients: number; lastDeltaBytes: number; totalBytes: number } {
    return { clients: this.states.size, lastDeltaBytes: this.lastDeltaBytes, totalBytes: this.totalBytes };
  }

  /** 配信対象のアクター。範囲内 ＋ 自分 ＋ 自分のペット */
  private visibleActors(st: ClientState, rect: ViewRect): Actor[] {
    const out: Actor[] = [];
    const forced = new Set<EntityId>();
    forced.add(st.c.actorId);
    if (st.c.petId !== null) forced.add(st.c.petId);

    for (const a of this.world.actors.values()) {
      if (forced.has(a.id) || inRect(rect, a.pos.x, a.pos.y)) out.push(a);
    }
    return out;
  }
}

/**
 * 前回送った値との差分。位置は0.02タイル以上、facing/animは変化時のみ。
 * 変化がなければ null。prev は送った値で上書きする。
 */
function diffActor(prev: ActorWire, a: Actor): ActorDelta | null {
  const d: ActorDelta = { i: a.id };
  let has = false;

  const x = q2(a.pos.x);
  if (Math.abs(x - prev.x) >= POS_EPS - POS_EPS_TOL) {
    d.x = x;
    prev.x = x;
    has = true;
  }
  const y = q2(a.pos.y);
  if (Math.abs(y - prev.y) >= POS_EPS - POS_EPS_TOL) {
    d.y = y;
    prev.y = y;
    has = true;
  }
  const f = encodeFacing(a.facing);
  if (f !== prev.f) {
    d.f = f;
    prev.f = f;
    has = true;
  }
  const an = encodeAnim(a.anim);
  if (an !== prev.a) {
    d.a = an;
    prev.a = an;
    has = true;
  }
  return has ? d : null;
}
