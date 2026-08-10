import { Quaternion, Vector3 } from 'three';
import { AIM_PITCH_OFFSET } from '../core/aim';
import { forwardOf, leadPoint, LOCAL_FORWARD, LOCAL_RIGHT } from '../core/math';
import { isHostile } from '../content/factions';
import { gunDef } from '../content/weapons';
import type { Entity } from '../world/entity';
import type { World } from '../world/world';

const _fwd = new Vector3();
const _to = new Vector3();
const _aim = new Vector3();
const _aimQ = new Quaternion();

/** ターゲットにできる機体 (敵味方問わず。HUD は色で区別する) */
function selectable(world: World, self: Entity): Entity[] {
  const out: Entity[] = [];
  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'ship' || !e.ship) continue;
    if (e.id === self.id) continue;
    out.push(e);
  }
  return out;
}

function hostiles(world: World, self: Entity): Entity[] {
  return selectable(world, self).filter((e) => isHostile(self.faction, e.faction));
}

/** T キー: 敵を距離順に巡回する */
export function targetNext(world: World, self: Entity): Entity | undefined {
  const ship = self.ship;
  if (!ship) return undefined;
  const list = hostiles(world, self).sort(
    (a, b) => a.pos.distanceToSquared(self.pos) - b.pos.distanceToSquared(self.pos),
  );
  if (list.length === 0) return undefined;
  const cur = list.findIndex((e) => e.id === ship.targetId);
  const next = list[(cur + 1) % list.length];
  setTarget(self, next);
  return next;
}

/** R キー: 最も近い敵 */
export function targetNearest(world: World, self: Entity): Entity | undefined {
  let best: Entity | undefined;
  let bestD = Infinity;
  for (const e of hostiles(world, self)) {
    const d = e.pos.distanceToSquared(self.pos);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (best) setTarget(self, best);
  return best;
}

/** Y キー: 機首方向に最も近い敵 (交戦中に狙いたい相手を掴む) */
export function targetFront(world: World, self: Entity): Entity | undefined {
  forwardOf(self.quat, _fwd);
  let best: Entity | undefined;
  let bestScore = -Infinity;
  for (const e of hostiles(world, self)) {
    _to.copy(e.pos).sub(self.pos);
    const d = _to.length();
    if (d < 1e-3) continue;
    const cos = _to.divideScalar(d).dot(_fwd);
    if (cos < 0.75) continue;
    // 正面度を優先しつつ、近い方を選ぶ
    const score = cos * 2 - d / 20000;
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  if (best) setTarget(self, best);
  return best;
}

/** `targetUnderReticle` の許容角 (cos)。0.985 ≒ 約 10 度。 */
const RETICLE_COS = 0.985;

/**
 * I キー: 照準の射線に最も近い相手を選ぶ。
 *
 * `targetFront`（Y）との役割の違い:
 * - Y = 前方の広い円錐（cos > 0.75、約 41 度）から「正面度 × 近さ」で選ぶ。
 *   まだ狙っていない交戦相手を**探す**操作。敵のみを対象にする。
 * - I = 照準の射線ほぼ真上（cos > 0.985、約 10 度）にいる相手を選ぶ。
 *   いま撃っている相手を**掴む**操作。敵だけでなく非敵対も選べる
 *   （第2章の識別で中立船を掴む用途がある）。同程度の角度なら敵を優先する。
 *
 * 判定に使う向きは**機首前方ではなく照準の射線**（機首前方を機体右軸まわりに
 * `aimPitchOffset` だけ回した向き）。画面上の固定照準は機首より上を向くことが
 * あるので、ここを機首前方（`forwardOf`）で代用すると
 * 「照準に入れているのに掴めない」が起きる。
 *
 * @param aimPitchOffset 照準の仰角 (rad)。既定は照準定数の出所である
 *   `src/core/aim.ts` の `AIM_PITCH_OFFSET`（数値は写さない）。
 * @returns 選べた機体。許容角の中に誰もいなければ `undefined`
 *   （呼び出し側が「照準下に目標なし」を案内する）。
 */
export function targetUnderReticle(
  world: World,
  self: Entity,
  aimPitchOffset: number = AIM_PITCH_OFFSET,
): Entity | undefined {
  if (!self.ship) return undefined;
  // 照準の射線: 機体ローカルの前方を右軸まわりに回してから機体姿勢へ移す
  _aim
    .copy(LOCAL_FORWARD)
    .applyQuaternion(_aimQ.setFromAxisAngle(LOCAL_RIGHT, aimPitchOffset))
    .applyQuaternion(self.quat)
    .normalize();

  let best: Entity | undefined;
  let bestScore = -Infinity;
  for (const e of selectable(world, self)) {
    _to.copy(e.pos).sub(self.pos);
    const d = _to.length();
    if (d < 1e-3) continue;
    const cos = _to.divideScalar(d).dot(_aim);
    if (cos < RETICLE_COS) continue;
    // 敵優先は微差の加点で表現する（角度がほぼ同じなら敵、明確に近ければ非敵対でも選ぶ）
    const score = cos + (isHostile(self.faction, e.faction) ? 0.01 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  if (best) setTarget(self, best);
  return best;
}

export function setTarget(self: Entity, target: Entity | undefined): void {
  const ship = self.ship;
  if (!ship) return;
  if (ship.targetId !== target?.id) {
    ship.lockProgress = 0;
    ship.lockedId = undefined;
    // 手動ロック (W7-3) は目標を変えたら押し直しを要求する。
    // 前の目標に付けたロックを新しい目標へ引き継がせない。
    ship.lockArmed = false;
  }
  ship.targetId = target?.id;
}

/** ターゲットが死んだら自動で外す */
export function pruneTarget(world: World, self: Entity): void {
  const ship = self.ship;
  if (!ship) return;
  if (ship.targetId !== undefined && !world.byId(ship.targetId)) {
    ship.targetId = undefined;
    ship.lockProgress = 0;
    ship.lockedId = undefined;
    ship.lockArmed = false;
  }
}

/** 主砲の代表弾速 (ITTS のリード計算に使う) */
export function primaryGunSpeed(self: Entity, speedScale = 1): number {
  const ship = self.ship;
  if (!ship || ship.def.guns.length === 0) return 1200 * speedScale;
  let sum = 0;
  for (const g of ship.def.guns) sum += gunDef(g.gunId).speed;
  return (sum / ship.def.guns.length) * speedScale;
}

/** ITTS: 現在の主砲でターゲットに当たる射点 */
export function ittsPoint(
  self: Entity,
  target: Entity,
  out = new Vector3(),
  speedScale = 1,
): Vector3 {
  return leadPoint(self.pos, target.pos, target.vel, primaryGunSpeed(self, speedScale), out);
}

/** 自機を狙っているミサイルを探して警告に使う */
export function findIncomingMissile(world: World, self: Entity): Entity | undefined {
  let best: Entity | undefined;
  let bestD = Infinity;
  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'missile' || !e.missile) continue;
    if (e.missile.targetId !== self.id) continue;
    const d = e.pos.distanceToSquared(self.pos);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** 敵にロックされているかを更新する (被ロック警報用) */
export function updateLockedByEnemy(world: World, self: Entity): void {
  const ship = self.ship;
  if (!ship) return;
  let locked = false;
  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'ship' || !e.ship) continue;
    if (!isHostile(self.faction, e.faction)) continue;
    if (e.ship.lockedId === self.id) {
      locked = true;
      break;
    }
  }
  ship.lockedByEnemy = locked;
}
