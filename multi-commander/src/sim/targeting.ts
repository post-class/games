import { Vector3 } from 'three';
import { forwardOf, leadPoint } from '../core/math';
import { isHostile } from '../content/factions';
import { gunDef } from '../content/weapons';
import type { Entity } from '../world/entity';
import type { World } from '../world/world';

const _fwd = new Vector3();
const _to = new Vector3();

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

export function setTarget(self: Entity, target: Entity | undefined): void {
  const ship = self.ship;
  if (!ship) return;
  if (ship.targetId !== target?.id) {
    ship.lockProgress = 0;
    ship.lockedId = undefined;
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
  }
}

/** 主砲の代表弾速 (ITTS のリード計算に使う) */
export function primaryGunSpeed(self: Entity): number {
  const ship = self.ship;
  if (!ship || ship.def.guns.length === 0) return 1200;
  let sum = 0;
  for (const g of ship.def.guns) sum += gunDef(g.gunId).speed;
  return sum / ship.def.guns.length;
}

/** ITTS: 現在の主砲でターゲットに当たる射点 */
export function ittsPoint(self: Entity, target: Entity, out = new Vector3()): Vector3 {
  return leadPoint(self.pos, target.pos, target.vel, primaryGunSpeed(self), out);
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
