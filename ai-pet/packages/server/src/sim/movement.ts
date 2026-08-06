/**
 * 移動と衝突解決（docs/02_ゲーム実装プラン/04_サーバ設計.md §4）
 *
 * 方針:
 * - 物理エンジンは入れない。円半径 ACTOR_RADIUS の押し出しだけで解決する
 * - 歩けないタイルへは入らない。斜め入力で壁に当たったら軸ごとに分解して滑らせる
 * - 押し出しの反復は同一tickで最大2回（見た目が十分で、負荷が読める）
 * - 軸入力は Actor 型に無い情報なので、このモジュール内の Map で保持する
 *
 * 制約: Math.random() 禁止 / parameter property 禁止 / enum 禁止
 */
import { ACTOR_RADIUS, MAP_W, type Actor, type AnimName, type Facing, type Vec2 } from '@ai-pet/shared';
import { clampToMap } from './nav.ts';
import type { IslandWorld } from './world.ts';

/** 経路の点に「着いた」とみなす距離 */
const ARRIVE_EPS = 0.08;
/** 動いたと判定する最小移動量（anim切り替えのちらつき防止） */
const MOVED_EPS = 1e-4;
/** 押し出しの反復回数 */
const SEPARATION_ITERATIONS = 2;
/** 押し出し対象の最小距離 */
const MIN_SEPARATION = ACTOR_RADIUS * 2;
/** anim を上書きしてはいけない状態 */
const ANIM_LOCKED: ReadonlySet<AnimName> = new Set<AnimName>(['sleep', 'act']);

interface AxisInput {
  dx: number;
  dy: number;
}

/**
 * プレイヤーのキー入力。Actor 型を変えられないのでモジュール内に持つ。
 * アクターの退場時に消えないので、EntityId ではなく Actor を弱参照する WeakMap を使う。
 */
const axisInputs = new WeakMap<Actor, AxisInput>();

export function setAxisInput(actor: Actor, dx: number, dy: number): void {
  const cx = clampAxis(dx);
  const cy = clampAxis(dy);
  if (cx === 0 && cy === 0) {
    axisInputs.delete(actor);
    return;
  }
  axisInputs.set(actor, { dx: cx, dy: cy });
  // 軸入力は経路より優先する（クリック移動をキャンセルする）
  actor.path = null;
}

export function clearAxisInput(actor: Actor): void {
  axisInputs.delete(actor);
}

/** テストとデバッグ用 */
export function getAxisInput(actor: Actor): AxisInput | null {
  return axisInputs.get(actor) ?? null;
}

function clampAxis(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(-1, v));
}

/** 全アクターを経路に沿って動かす。facing と anim も更新する */
export function updateMovement(world: IslandWorld, tickSec: number): void {
  for (const actor of world.actors.values()) {
    const before = { x: actor.pos.x, y: actor.pos.y };
    const axis = axisInputs.get(actor);
    if (axis) {
      stepByAxis(world, actor, axis, tickSec);
    } else if (actor.path && actor.path.length > 0) {
      stepByPath(world, actor, tickSec);
    }
    const dx = actor.pos.x - before.x;
    const dy = actor.pos.y - before.y;
    const moved = Math.abs(dx) > MOVED_EPS || Math.abs(dy) > MOVED_EPS;
    if (moved) actor.facing = facingOf(dx, dy, actor.facing);
    if (!ANIM_LOCKED.has(actor.anim)) actor.anim = moved ? 'walk' : 'idle';
  }

  for (let i = 0; i < SEPARATION_ITERATIONS; i++) separate(world);
}

/** キー入力による移動。経路は無視する */
function stepByAxis(world: IslandWorld, actor: Actor, axis: AxisInput, tickSec: number): void {
  const len = Math.hypot(axis.dx, axis.dy);
  if (len < 1e-6) return;
  const dist = actor.speed * tickSec;
  tryStep(world, actor.pos, (axis.dx / len) * dist, (axis.dy / len) * dist);
}

/** 経路の次の点へ向かって進む。残り予算があれば次の点へ続ける */
function stepByPath(world: IslandWorld, actor: Actor, tickSec: number): void {
  let budget = actor.speed * tickSec;
  const path = actor.path;
  if (!path) return;

  while (budget > 1e-6 && path.length > 0) {
    const target = path[0] as Vec2;
    const dx = target.x - actor.pos.x;
    const dy = target.y - actor.pos.y;
    const d = Math.hypot(dx, dy);

    if (d <= Math.max(budget, ARRIVE_EPS)) {
      // 点に着いた。届かなければ（壁など）経路を捨てて上位に再計画させる
      if (!tryStep(world, actor.pos, dx, dy)) {
        actor.path = null;
        return;
      }
      path.shift();
      budget -= Math.min(budget, d);
      continue;
    }

    const nx = (dx / d) * budget;
    const ny = (dy / d) * budget;
    if (!tryStep(world, actor.pos, nx, ny)) {
      actor.path = null;
      return;
    }
    budget = 0;
  }
  if (path.length === 0) actor.path = null;
}

/**
 * pos を (dx,dy) だけ動かす。歩けないなら軸ごとに分解して滑らせる。
 * 少しでも動けたら true。
 */
function tryStep(world: IslandWorld, pos: Vec2, dx: number, dy: number): boolean {
  const cand = clampToMap({ x: pos.x + dx, y: pos.y + dy });
  if (world.canStandAt(cand)) {
    pos.x = cand.x;
    pos.y = cand.y;
    return true;
  }
  let moved = false;
  if (dx !== 0) {
    const c = clampToMap({ x: pos.x + dx, y: pos.y });
    if (world.canStandAt(c)) {
      pos.x = c.x;
      moved = true;
    }
  }
  if (dy !== 0) {
    const c = clampToMap({ x: pos.x, y: pos.y + dy });
    if (world.canStandAt(c)) {
      pos.y = c.y;
      moved = true;
    }
  }
  return moved;
}

/** 画面はy下向き。移動量の大きい軸で向きを決める */
function facingOf(dx: number, dy: number, current: Facing): Facing {
  if (Math.abs(dx) < MOVED_EPS && Math.abs(dy) < MOVED_EPS) return current;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'e' : 'w';
  return dy > 0 ? 's' : 'n';
}

// ---------- 押し出し ----------

/** 近傍探索用のバケット（1タイル1セル）。毎tick使い回す */
const buckets = new Map<number, Actor[]>();

function separate(world: IslandWorld): void {
  buckets.clear();
  for (const a of world.actors.values()) {
    const key = cellKey(a.pos);
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(a);
  }

  for (const a of world.actors.values()) {
    const cx = Math.floor(a.pos.x);
    const cy = Math.floor(a.pos.y);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const list = buckets.get((cy + oy) * MAP_W + (cx + ox));
        if (!list) continue;
        for (const b of list) {
          // 同じペアを2回処理しないよう id の小さい側だけが解決する
          if (b.id <= a.id) continue;
          resolvePair(world, a, b);
        }
      }
    }
  }
}

function cellKey(pos: Vec2): number {
  return Math.floor(pos.y) * MAP_W + Math.floor(pos.x);
}

function resolvePair(world: IslandWorld, a: Actor, b: Actor): void {
  let dx = b.pos.x - a.pos.x;
  let dy = b.pos.y - a.pos.y;
  let d = Math.hypot(dx, dy);
  if (d >= MIN_SEPARATION) return;

  if (d < 1e-6) {
    // 完全に重なった場合は id から決まる向きへ逃がす（乱数を使わず決定論を保つ）
    const angle = ((a.id * 0.6180339887 + b.id * 0.1) % 1) * Math.PI * 2;
    dx = Math.cos(angle);
    dy = Math.sin(angle);
    d = 1;
  }
  const push = (MIN_SEPARATION - d) / 2;
  const nx = (dx / d) * push;
  const ny = (dy / d) * push;
  nudge(world, a.pos, -nx, -ny);
  nudge(world, b.pos, nx, ny);
}

/** 歩ける範囲でだけずらす（水へ押し出さない） */
function nudge(world: IslandWorld, pos: Vec2, dx: number, dy: number): void {
  const cand = clampToMap({ x: pos.x + dx, y: pos.y + dy });
  if (world.canStandAt(cand)) {
    pos.x = cand.x;
    pos.y = cand.y;
    return;
  }
  const cx = clampToMap({ x: pos.x + dx, y: pos.y });
  if (world.canStandAt(cx)) pos.x = cx.x;
  const cy = clampToMap({ x: pos.x, y: pos.y + dy });
  if (world.canStandAt(cy)) pos.y = cy.y;
}

/** アクター退場時に呼ぶ（WeakMap なので必須ではないが、明示できるように） */
export function forgetActor(actor: Actor): void {
  axisInputs.delete(actor);
}
