import { Quaternion, Vector3 } from 'three';
import { bus } from '../core/events';
import { clamp01, forwardOf, leadPoint } from '../core/math';
import { isHostile } from '../content/factions';
import { rng } from '../core/rng';
import { gunDef, missileDef } from '../content/weapons';
import type { Entity } from '../world/entity';
import { spawnFlare, spawnMissile, spawnProjectile, type World } from '../world/world';
import { gunOperational } from './subsystems';

const _muzzle = new Vector3();
const _dir = new Vector3();
const _fwd = new Vector3();

/** ミサイルロックに必要な最大角度 (機首から) */
const LOCK_CONE = Math.cos(0.35);
/** ロック可能な最大距離 */
export const LOCK_RANGE = 6000;

export interface AimAssist {
  /** 照準補正を掛ける対象の entity id (通常はプレイヤーのターゲット) */
  targetId?: number;
  /**
   * 補正の強さ 0..1。
   * 1 でも「機首の向きを無視して必ず当たる」ようにはしない。
   * 照準がほぼ合っているときに、わずかに射線を引き寄せるだけ。
   */
  strength: number;
}

/** 補正が効く最大の角度 (これより外れていれば一切補正しない) */
const AIM_ASSIST_CONE = 0.075;
/** 補正で寄せられる最大角度 */
const AIM_ASSIST_MAX = 0.05;

/**
 * 砲の発射。押しっぱなしで、各砲口が自分の連射間隔で順に撃つ。
 * エネルギーが足りない砲口は撃たない (WC のリソース管理)。
 *
 * assist を渡すと、射線をターゲットの予測点へわずかに寄せる (初心者補助)。
 */
export function fireGuns(
  world: World,
  e: Entity,
  dt: number,
  damageScale = 1,
  assist?: AimAssist,
): void {
  const ship = e.ship;
  const input = e.input;
  if (!ship || !input) return;
  void dt;
  if (!input.firePrimary) return;

  const def = ship.def;
  forwardOf(e.quat, _fwd);

  // 照準アシストの寄せ先を求めておく
  const assistTarget = assist && assist.strength > 0 ? world.byId(assist.targetId) : undefined;

  for (let i = 0; i < def.guns.length; i++) {
    if (ship.gunCooldown[i] > 0) continue;
    const hp = def.guns[i];
    const gun = gunDef(hp.gunId);
    if (ship.energy < gun.energyCost) continue;
    // 損傷した砲は沈黙する / 渋る
    if (!gunOperational(ship, hp.offset[0])) {
      ship.gunCooldown[i] = gun.refire;
      continue;
    }

    ship.energy -= gun.energyCost;
    ship.gunCooldown[i] = gun.refire;

    _muzzle
      .set(hp.offset[0], hp.offset[1], hp.offset[2])
      .multiplyScalar(def.hardpointScale)
      .applyQuaternion(e.quat)
      .add(e.pos);
    _dir.copy(_fwd);

    if (assistTarget) {
      applyAimAssist(_muzzle, _dir, assistTarget, gun.speed, assist!.strength);
    }

    spawnProjectile(world, {
      gunId: hp.gunId,
      pos: _muzzle,
      dir: _dir,
      inheritVel: e.vel,
      ownerId: e.id,
      ownerFaction: e.faction,
      fromPlayer: e.id === world.playerId,
      damageScale,
    });

    bus.emit('weaponFired', {
      shooter: e,
      muzzle: _muzzle.clone(),
      direction: _dir.clone(),
      weaponKind: 'gun',
      weaponId: hp.gunId,
      isPlayer: e.id === world.playerId,
    });
  }
}

const _aimTo = new Vector3();
const _aimLead = new Vector3();
const _aimAxis = new Vector3();
const _aimQ = new Quaternion();

/**
 * 射線をターゲットの予測点へわずかに回す。
 * ほぼ狙えているときだけ効くので、「勝手に当たる」感覚にはならない。
 */
function applyAimAssist(
  muzzle: Vector3,
  dir: Vector3,
  target: Entity,
  bulletSpeed: number,
  strength: number,
): void {
  leadPoint(muzzle, target.pos, target.vel, bulletSpeed, _aimLead);
  _aimTo.copy(_aimLead).sub(muzzle);
  const len = _aimTo.length();
  if (len < 1e-4) return;
  _aimTo.divideScalar(len);
  const dot = Math.max(-1, Math.min(1, dir.dot(_aimTo)));
  const angle = Math.acos(dot);
  if (angle > AIM_ASSIST_CONE || angle < 1e-5) return;
  _aimAxis.copy(dir).cross(_aimTo);
  if (_aimAxis.lengthSq() < 1e-12) return;
  _aimAxis.normalize();
  const step = Math.min(angle, AIM_ASSIST_MAX * strength);
  _aimQ.setFromAxisAngle(_aimAxis, step);
  dir.applyQuaternion(_aimQ).normalize();
}

/**
 * 対空砲火の射程。
 * 遠距離から一方的に削られると手が無くなるので、
 * 「懐に入るまでは安全、入ってからが危険」という距離感にしている。
 */
const TURRET_RANGE = 1800;
/** 砲塔は連射間隔をこの倍数だけ空ける (機体の砲より遅い) */
const TURRET_REFIRE_SCALE = 3;
/** 砲塔の散布 (rad)。近接防御なので当たりすぎないようにする */
const TURRET_SPREAD = 0.03;

/**
 * 艦艇の対空砲火。
 * 艦は機動しないので、砲塔が旋回して最も近い敵機を狙う扱いにする。
 */
export function fireTurrets(world: World, e: Entity, damageScale = 1): void {
  const ship = e.ship;
  if (!ship) return;
  const def = ship.def;

  let target: Entity | undefined;
  let bestD = Infinity;
  for (const t of world.entities) {
    if (!t.alive || t.kind !== 'ship' || !t.ship) continue;
    if (!isHostile(e.faction, t.faction)) continue;
    if (t.ship.def.role === 'capital') continue;
    const d = t.pos.distanceTo(e.pos);
    if (d > TURRET_RANGE + e.radius || d >= bestD) continue;
    bestD = d;
    target = t;
  }
  if (!target) return;

  for (let i = 0; i < def.guns.length; i++) {
    if (ship.gunCooldown[i] > 0) continue;
    const hp = def.guns[i];
    const gun = gunDef(hp.gunId);
    if (ship.energy < gun.energyCost) continue;
    ship.energy -= gun.energyCost;
    ship.gunCooldown[i] = gun.refire * TURRET_REFIRE_SCALE;

    _muzzle
      .set(hp.offset[0], hp.offset[1], hp.offset[2])
      .multiplyScalar(def.hardpointScale)
      .applyQuaternion(e.quat)
      .add(e.pos);
    leadPoint(_muzzle, target.pos, target.vel, gun.speed, _dir);
    _dir.sub(_muzzle).normalize();
    _dir.x += rng.signed(TURRET_SPREAD);
    _dir.y += rng.signed(TURRET_SPREAD);
    _dir.z += rng.signed(TURRET_SPREAD);
    _dir.normalize();

    spawnProjectile(world, {
      gunId: hp.gunId,
      pos: _muzzle,
      dir: _dir,
      ownerId: e.id,
      ownerFaction: e.faction,
      fromPlayer: false,
      damageScale,
    });
    bus.emit('weaponFired', {
      shooter: e,
      muzzle: _muzzle.clone(),
      direction: _dir.clone(),
      weaponKind: 'gun',
      weaponId: hp.gunId,
      isPlayer: false,
    });
  }
}

/**
 * 目標に合った副兵装を選ぶ。
 * 艦艇には魚雷、戦闘機には誘導ミサイルを回す。
 */
export function selectMissileFor(e: Entity, target: Entity): void {
  const ship = e.ship;
  if (!ship) return;
  const wantsTorpedo =
    target.ship?.def.role === 'capital' || target.ship?.def.role === 'transport';
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < ship.missiles.length; i++) {
    const slot = ship.missiles[i];
    if (slot.count <= 0) continue;
    const def = missileDef(slot.missileId);
    const isTorpedo = def.id === 'torpedo';
    // 目標に合っていれば加点。合っていなければ大きく減点する。
    let score = def.damage * 0.01;
    if (wantsTorpedo === isTorpedo) score += 100;
    else score -= 100;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best >= 0 && best !== ship.activeMissile) {
    ship.activeMissile = best;
    ship.lockProgress = 0;
    ship.lockedId = undefined;
  }
}

/** 現在選択中の副兵装スロット (弾切れスロットは飛ばす) */
export function activeMissileSlot(e: Entity): { index: number; missileId: string; count: number } | undefined {
  const ship = e.ship;
  if (!ship || ship.missiles.length === 0) return undefined;
  const n = ship.missiles.length;
  for (let k = 0; k < n; k++) {
    const i = (ship.activeMissile + k) % n;
    if (ship.missiles[i].count > 0) {
      return { index: i, missileId: ship.missiles[i].missileId, count: ship.missiles[i].count };
    }
  }
  return undefined;
}

export function cycleMissile(e: Entity): void {
  const ship = e.ship;
  if (!ship || ship.missiles.length === 0) return;
  const n = ship.missiles.length;
  for (let k = 1; k <= n; k++) {
    const i = (ship.activeMissile + k) % n;
    if (ship.missiles[i].count > 0) {
      ship.activeMissile = i;
      ship.lockProgress = 0;
      ship.lockedId = undefined;
      return;
    }
  }
}

/**
 * ミサイルロックの進行。
 * 誘導ミサイル選択中に、ターゲットが機首正面かつ射程内にいる時間でロックが進む。
 */
export function updateMissileLock(world: World, e: Entity, dt: number): void {
  const ship = e.ship;
  if (!ship) return;
  const slot = activeMissileSlot(e);
  if (!slot) {
    ship.lockProgress = 0;
    ship.lockedId = undefined;
    return;
  }
  const def = missileDef(slot.missileId);
  if (def.seeker === 'none' || def.lockTime <= 0) {
    // 無誘導は常に「ロック済み」扱い
    ship.lockProgress = 1;
    ship.lockedId = ship.targetId;
    return;
  }

  const target = world.byId(ship.targetId);
  if (!target || target.kind !== 'ship') {
    ship.lockProgress = Math.max(0, ship.lockProgress - dt / Math.max(0.2, def.lockTime));
    ship.lockedId = undefined;
    return;
  }

  _dir.copy(target.pos).sub(e.pos);
  const distance = _dir.length();
  _dir.divideScalar(Math.max(1e-6, distance));
  const cone = _dir.dot(forwardOf(e.quat, _fwd));

  const inLock = distance < LOCK_RANGE && cone > LOCK_CONE;
  const before = ship.lockedId;
  if (inLock) {
    ship.lockProgress = clamp01(ship.lockProgress + dt / def.lockTime);
    if (ship.lockProgress >= 1) ship.lockedId = target.id;
  } else {
    ship.lockProgress = Math.max(0, ship.lockProgress - (dt / def.lockTime) * 1.5);
    ship.lockedId = undefined;
  }
  if (before !== ship.lockedId) {
    bus.emit('lockChanged', { locked: !!ship.lockedId, target: ship.lockedId ? target : undefined });
  }
}

export interface FireMissileResult {
  fired: boolean;
  reason?: 'no-ammo' | 'no-lock';
}

/** 副兵装の発射 */
export function fireMissile(world: World, e: Entity): FireMissileResult {
  const ship = e.ship;
  if (!ship) return { fired: false, reason: 'no-ammo' };
  const slot = activeMissileSlot(e);
  if (!slot) return { fired: false, reason: 'no-ammo' };
  const def = missileDef(slot.missileId);

  if (def.seeker !== 'none' && !ship.lockedId) return { fired: false, reason: 'no-lock' };

  ship.missiles[slot.index].count -= 1;
  if (ship.activeMissile !== slot.index) ship.activeMissile = slot.index;

  forwardOf(e.quat, _fwd);
  // 機体下面から交互に射出する
  const side = ship.missiles[slot.index].count % 2 === 0 ? -1 : 1;
  _muzzle
    .set(side * e.radius * 0.35, -e.radius * 0.2, -e.radius * 0.3)
    .applyQuaternion(e.quat)
    .add(e.pos);

  spawnMissile(world, {
    missileId: slot.missileId,
    pos: _muzzle,
    dir: _fwd,
    inheritVel: e.vel,
    ownerId: e.id,
    ownerFaction: e.faction,
    fromPlayer: e.id === world.playerId,
    targetId: def.seeker === 'none' ? undefined : ship.lockedId,
  });

  bus.emit('weaponFired', {
    shooter: e,
    muzzle: _muzzle.clone(),
    direction: _fwd.clone(),
    weaponKind: 'missile',
    weaponId: slot.missileId,
    isPlayer: e.id === world.playerId,
  });

  if (def.seeker !== 'none') {
    ship.lockProgress = 0;
    ship.lockedId = undefined;
  }
  return { fired: true };
}

/** フレア (デコイ) の投下 */
export function dropFlare(world: World, e: Entity): boolean {
  const ship = e.ship;
  if (!ship || ship.flares <= 0 || ship.flareCooldown > 0) return false;
  ship.flares -= 1;
  ship.flareCooldown = 0.6;
  forwardOf(e.quat, _fwd);
  _muzzle.copy(e.pos).addScaledVector(_fwd, -e.radius * 1.2);
  const vel = _fwd.clone().multiplyScalar(-60).add(e.vel);
  spawnFlare(world, { pos: _muzzle, vel, faction: e.faction });
  return true;
}
