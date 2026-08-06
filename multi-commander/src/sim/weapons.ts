import { Quaternion, Vector3 } from 'three';
import { AIM_PITCH_OFFSET } from '../core/aim';
import { bus } from '../core/events';
import { clamp01, forwardOf, leadPoint, LOCAL_FORWARD, LOCAL_RIGHT } from '../core/math';
import { isHostile } from '../content/factions';
import { rng } from '../core/rng';
import { gunDef, missileDef, missilePresentation } from '../content/weapons';
import type { Entity } from '../world/entity';
import { spawnFlare, spawnMissile, spawnProjectile, type World } from '../world/world';
import { gunOperational } from './subsystems';

const _muzzle = new Vector3();
const _dir = new Vector3();
const _fwd = new Vector3();
const _reticleQ = new Quaternion();

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
  playerAimPitchOffset = 0,
): void {
  const ship = e.ship;
  const input = e.input;
  if (!ship || !input) return;

  // 反動はシミュレーション上の短い残量として保持し、RenderSync が機体を後退させる。
  // 古いランタイムを受けても描画だけで壊れないよう遅延初期化する。
  if (!ship.gunRecoil) ship.gunRecoil = ship.gunCooldown.map(() => 0);
  ship.weaponDeniedCooldown = Math.max(0, (ship.weaponDeniedCooldown ?? 0) - dt);
  for (let i = 0; i < ship.gunRecoil.length; i++) ship.gunRecoil[i] = Math.max(0, ship.gunRecoil[i] - dt * 1.8);
  if (!input.firePrimary) return;

  const def = ship.def;
  forwardOf(e.quat, _fwd);

  // 照準アシストの寄せ先を求めておく
  const assistTarget = assist && assist.strength > 0 ? world.byId(assist.targetId) : undefined;

  let fired = 0;
  let denied: 'energy' | 'damaged' | undefined;
  for (let i = 0; i < def.guns.length; i++) {
    if (ship.gunCooldown[i] > 0) continue;
    const hp = def.guns[i];
    const gun = gunDef(hp.gunId);
    if (ship.energy < gun.energyCost) {
      denied ??= 'energy';
      continue;
    }
    // 損傷した砲は沈黙する / 渋る
    if (!gunOperational(ship, hp.offset[0])) {
      ship.gunCooldown[i] = gun.refire;
      denied ??= 'damaged';
      continue;
    }

    ship.energy -= gun.energyCost;
    ship.gunCooldown[i] = gun.refire;
    ship.gunRecoil[i] = Math.max(ship.gunRecoil[i] ?? 0, gun.presentation?.recoil ?? 0);
    fired += 1;

    _muzzle
      .set(hp.offset[0], hp.offset[1], hp.offset[2])
      .multiplyScalar(def.hardpointScale)
      .applyQuaternion(e.quat)
      .add(e.pos);
    _dir.copy(_fwd);
    // プレイヤーの固定照準は画面中央より上にあるので、主砲も同じ
    // スクリーン座標へ射出する。敵機の射線は機首正面のままにする。
    if (e.id === world.playerId && playerAimPitchOffset !== 0) {
      _dir
        .copy(LOCAL_FORWARD)
        .applyQuaternion(_reticleQ.setFromAxisAngle(LOCAL_RIGHT, playerAimPitchOffset))
        .applyQuaternion(e.quat);
    }

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
      profile: gun.presentation?.audioProfile,
      recoil: gun.presentation?.recoil,
    });
  }
  if (fired === 0 && denied && e.id === world.playerId && ship.weaponDeniedCooldown <= 0) {
    ship.weaponDeniedCooldown = 0.35;
    bus.emit('weaponDenied', {
      shooter: e,
      weaponKind: 'gun',
      weaponId: def.guns[0]?.gunId,
      reason: denied,
      isPlayer: true,
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
    // 旗艦の段階目標「砲塔を無力化」を実際の対空火力にも反映する。
    // damaged は gunOperational 内で不発を混ぜ、dead は完全停止させる。
    if (!gunOperational(ship, hp.offset[0])) continue;
    const gun = gunDef(hp.gunId);
    if (!ship.gunRecoil) ship.gunRecoil = ship.gunCooldown.map(() => 0);
    ship.gunRecoil[i] = Math.max(ship.gunRecoil[i] ?? 0, gun.presentation?.recoil ?? 0);
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
      profile: gun.presentation?.audioProfile,
      recoil: gun.presentation?.recoil,
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

  const before = ship.lockedId;
  const target = world.byId(ship.targetId);
  if (!target || target.kind !== 'ship') {
    ship.lockProgress = Math.max(0, ship.lockProgress - dt / Math.max(0.2, def.lockTime));
    ship.lockedId = undefined;
    if (before !== ship.lockedId) {
      bus.emit('lockChanged', {
        locked: false,
        progress: ship.lockProgress,
        missileId: def.id,
        reason: 'target-lost',
      });
    }
    return;
  }

  _dir.copy(target.pos).sub(e.pos);
  const distance = _dir.length();
  _dir.divideScalar(Math.max(1e-6, distance));
  const cone = _dir.dot(forwardOf(e.quat, _fwd));

  const inLock = distance < LOCK_RANGE && cone > LOCK_CONE;
  if (inLock) {
    ship.lockProgress = clamp01(ship.lockProgress + dt / def.lockTime);
    if (ship.lockProgress >= 1) ship.lockedId = target.id;
  } else {
    ship.lockProgress = Math.max(0, ship.lockProgress - (dt / def.lockTime) * 1.5);
    ship.lockedId = undefined;
  }
  if (before !== ship.lockedId) {
    bus.emit('lockChanged', {
      locked: !!ship.lockedId,
      target: ship.lockedId ? target : undefined,
      progress: ship.lockProgress,
      missileId: def.id,
      reason: ship.lockedId ? 'complete' : distance >= LOCK_RANGE ? 'out-of-range' : 'out-of-cone',
    });
  }
}

export interface FireMissileResult {
  fired: boolean;
  reason?: 'no-ammo' | 'no-lock' | 'invalid-target';
}

/** 副兵装の発射 */
export function fireMissile(world: World, e: Entity): FireMissileResult {
  const ship = e.ship;
  if (!ship) return { fired: false, reason: 'no-ammo' };
  const slot = activeMissileSlot(e);
  if (!slot) {
    if (e.id === world.playerId) {
      bus.emit('weaponDenied', {
        shooter: e,
        weaponKind: 'missile',
        reason: 'no-ammo',
        isPlayer: true,
      });
    }
    return { fired: false, reason: 'no-ammo' };
  }
  const def = missileDef(slot.missileId);
  const presentation = missilePresentation(def);

  if (def.seeker !== 'none' && !ship.lockedId) {
    if (e.id === world.playerId) {
      bus.emit('weaponDenied', {
        shooter: e,
        weaponKind: 'missile',
        weaponId: def.id,
        reason: 'no-lock',
        isPlayer: true,
      });
    }
    return { fired: false, reason: 'no-lock' };
  }
  const target = ship.lockedId ? world.byId(ship.lockedId) : undefined;
  if (
    target?.ship &&
    presentation.targetRole === 'capital' &&
    target.ship.def.role !== 'capital' &&
    target.ship.def.role !== 'transport'
  ) {
    if (e.id === world.playerId) {
      bus.emit('weaponDenied', {
        shooter: e,
        weaponKind: 'missile',
        weaponId: def.id,
        reason: 'invalid-target',
        isPlayer: true,
      });
    }
    return { fired: false, reason: 'invalid-target' };
  }

  ship.missiles[slot.index].count -= 1;
  if (ship.activeMissile !== slot.index) ship.activeMissile = slot.index;

  // 画面上の固定照準は画面中央より上にあるため、プレイヤーのミサイルも
  // 主砲と同じ照準線へ射出する。AI／僚機は機首正面から発射する。
  if (e.id === world.playerId) {
    _fwd
      .copy(LOCAL_FORWARD)
      .applyQuaternion(_reticleQ.setFromAxisAngle(LOCAL_RIGHT, AIM_PITCH_OFFSET))
      .applyQuaternion(e.quat);
  } else {
    forwardOf(e.quat, _fwd);
  }
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
    profile: presentation.audioProfile,
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
