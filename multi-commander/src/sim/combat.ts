import { Quaternion, Vector3 } from 'three';
import { bus } from '../core/events';
import { forwardOf, leadPoint } from '../core/math';
import { rng } from '../core/rng';
import { isHostile } from '../content/factions';
import type { Entity } from '../world/entity';
import type { World } from '../world/world';
import { pointOnSegment, spheresOverlap, sweepSphere } from './collision';
import { applyDamage, applySplashDamage, type DamageResult } from './damage';
import { rollSubsystemDamage } from './subsystems';
import { classifyDestruction, type DestructionCause } from '../core/destruction';

const _hit = new Vector3();
const _to = new Vector3();
const _lead = new Vector3();
const _dir = new Vector3();
const _fwd = new Vector3();
const _q = new Quaternion();
const _axis = new Vector3();
const _sep = new Vector3();

export interface CombatOptions {
  /** プレイヤーが受けるダメージ倍率 */
  playerDamageTaken: number;
  /** プレイヤーが与えるダメージ倍率 */
  playerDamageDealt: number;
  /** プレイヤー機の部位故障の発生率倍率 */
  playerSubsystemRate?: number;
}

const DEFAULT_OPTS: CombatOptions = {
  playerDamageTaken: 1,
  playerDamageDealt: 1,
  playerSubsystemRate: 1,
};

/**
 * 衝突時の被害倍率。
 * 相手が自分より大きいほど痛い。艦艇 (radius 80+) への激突はほぼ致命傷になる。
 */
function collisionRatio(self: Entity, other: Entity): number {
  const massRatio = other.radius / Math.max(1, self.radius);
  return Math.min(14, 0.6 + massRatio * 1.6);
}

/** 撃墜処理。イベントを飛ばして撃墜数を加算する。 */
export function destroyEntity(
  world: World,
  e: Entity,
  source?: Entity,
  cause: DestructionCause = 'unknown',
): void {
  const ship = e.ship;
  if (ship?.dying) return;
  if (ship) ship.dying = true;
  const killedByPlayer = !!source && source.id === world.playerId;
  if (source?.ship) source.ship.kills += 1;
  bus.emit('destroyed', {
    target: e,
    source,
    killedByPlayer,
    reason: classifyDestruction(cause, source?.faction, e.faction),
  });
  world.kill(e);
}

/** 弾・ミサイル・フレアの移動と寿命 */
export function updateOrdnance(world: World, dt: number): void {
  for (const e of world.entities) {
    if (!e.alive) continue;

    if (e.kind === 'projectile' || e.kind === 'flare') {
      const p = e.projectile!;
      p.life -= dt;
      if (p.life <= 0) {
        world.kill(e);
        continue;
      }
      e.prevPos.copy(e.pos);
      e.pos.addScaledVector(e.vel, dt);
      continue;
    }

    if (e.kind === 'missile') {
      updateMissile(world, e, dt);
    }
  }
}

function updateMissile(world: World, e: Entity, dt: number): void {
  const m = e.missile!;
  m.life -= dt;
  if (m.life <= 0) {
    detonate(world, e, undefined);
    return;
  }
  if (m.armTime > 0) m.armTime -= dt;

  const def = m.def;
  // 推進: 巡航速度まで加速
  const speed = e.vel.length();
  if (speed < def.speed) {
    forwardOf(e.quat, _fwd);
    e.vel.addScaledVector(_fwd, Math.min(def.speed - speed, def.speed * 1.6 * dt));
  }

  if (m.seeker !== 'none' && m.armTime <= 0) {
    // フレアへの吸着判定
    if (def.flareSusceptibility > 0 && !m.decoyId) {
      for (const f of world.entities) {
        if (!f.alive || f.kind !== 'flare') continue;
        if (!isHostile(m.ownerFaction, f.faction)) continue;
        const d = f.pos.distanceTo(e.pos);
        if (d > 700) continue;
        // 距離が近いほど騙されやすい。難易度ではなくミサイル種で決まる。
        const p = def.flareSusceptibility * (1 - d / 700) * 2.2 * dt;
        if (rng.chance(p)) {
          m.decoyId = f.id;
          m.targetId = undefined;
          break;
        }
      }
    }

    const target = world.byId(m.decoyId ?? m.targetId);
    if (target) {
      _to.copy(target.pos).sub(e.pos);
      const distance = _to.length();
      // ヒートシーカーは後方からの方が追尾しやすく、正面からは外れやすい
      let turn = def.turnRate;
      if (m.seeker === 'heat' && target.ship) {
        forwardOf(target.quat, _fwd);
        const aspect = _to.clone().normalize().dot(_fwd); // +1 = 真後ろから追う
        turn *= 0.55 + 0.65 * Math.max(0, aspect);
        if (target.input?.afterburner) turn *= 1.25;
      }
      if (m.seeker === 'aspect' && distance > 9000) {
        // 遠すぎるとロストする
        m.targetId = undefined;
      } else {
        leadPoint(e.pos, target.pos, target.vel, Math.max(1, e.vel.length()), _lead);
        _dir.copy(_lead).sub(e.pos).normalize();
        steerToward(e, _dir, turn, dt);
      }
    }
  }

  e.prevPos.copy(e.pos);
  e.pos.addScaledVector(e.vel, dt);

  // 近接信管
  for (const s of world.entities) {
    if (!s.alive || s.kind !== 'ship' || !s.ship) continue;
    if (s.id === m.ownerId) continue;
    if (!isHostile(m.ownerFaction, s.faction) && s.id !== m.targetId) continue;
    const trigger = def.blastRadius * 0.55 + s.radius;
    const t = sweepSphere(e.prevPos, e.pos, s.pos, trigger);
    if (t !== null) {
      pointOnSegment(e.prevPos, e.pos, t, _hit);
      detonate(world, e, _hit);
      return;
    }
  }
}

/** 速度ベクトルを目標方向へ turnRate で曲げ、機首を速度方向に合わせる */
function steerToward(e: Entity, desiredDir: Vector3, turnRate: number, dt: number): void {
  const speed = e.vel.length();
  if (speed < 1e-4) {
    e.vel.copy(desiredDir).multiplyScalar(1);
    return;
  }
  _fwd.copy(e.vel).divideScalar(speed);
  const dot = Math.max(-1, Math.min(1, _fwd.dot(desiredDir)));
  const angle = Math.acos(dot);
  const maxStep = turnRate * dt;
  if (angle < 1e-4) return;
  const step = Math.min(angle, maxStep);
  _axis.copy(_fwd).cross(desiredDir);
  if (_axis.lengthSq() < 1e-10) return;
  _axis.normalize();
  _q.setFromAxisAngle(_axis, step);
  e.vel.applyQuaternion(_q);
  e.quat.setFromUnitVectors(new Vector3(0, 0, -1), e.vel.clone().divideScalar(e.vel.length()));
}

/** ミサイル爆発。範囲内の機体に減衰付きダメージを与える。 */
function detonate(world: World, e: Entity, at: Vector3 | undefined): void {
  const m = e.missile!;
  const center = at ?? e.pos;
  const def = m.def;
  for (const s of world.entities) {
    if (!s.alive || s.kind !== 'ship' || !s.ship) continue;
    const d = s.pos.distanceTo(center) - s.radius;
    if (d > def.blastRadius) continue;
    const falloff = 1 - Math.max(0, d) / def.blastRadius;
    const dmg = def.damage * (0.35 + 0.65 * falloff);
    const scaled = scaleDamage(world, dmg, m.fromPlayer, s.id === world.playerId);
    const res = applySplashDamage(s, scaled, center);
    emitHit(world, s, center, res);
    applySubsystemDamage(world, s, res.hullDamage, res.armorFace);
    if (res.destroyed) destroyEntity(world, s, world.byId(m.ownerId), 'missile');
  }
  bus.emit('explosion', { pos: center.clone(), radius: def.blastRadius, kind: 'missile' });
  world.kill(e);
}

let combatOpts: CombatOptions = DEFAULT_OPTS;

export function setCombatOptions(o: CombatOptions): void {
  combatOpts = o;
}

function scaleDamage(world: World, dmg: number, fromPlayer: boolean, toPlayer: boolean): number {
  void world;
  let d = dmg;
  if (fromPlayer) d *= combatOpts.playerDamageDealt;
  if (toPlayer) d *= combatOpts.playerDamageTaken;
  return d;
}

/**
 * 被弾の演出イベントを流し、ハルに通った分から部位故障を判定する。
 * 「HP が減る」だけでなく「何が壊れたか」を作るための入口。
 */
function emitHit(
  world: World,
  target: Entity,
  point: Vector3,
  result: DamageResult,
): void {
  const isPlayer = target.id === world.playerId;
  if (result.shieldAbsorbed > 0) {
    bus.emit('shieldHit', {
      target,
      point: point.clone(),
      amount: result.shieldAbsorbed,
      isPlayer,
    });
  }
  if (result.armorAbsorbed > 0) {
    bus.emit('armorHit', {
      target,
      point: point.clone(),
      amount: result.armorAbsorbed,
      layer: 'armor',
      isPlayer,
    });
  }
  if (result.hullDamage > 0) {
    bus.emit('armorHit', {
      target,
      point: point.clone(),
      amount: result.hullDamage,
      layer: 'hull',
      isPlayer,
    });
  }
}

/** ハルに通ったダメージから部位故障を判定し、プレイヤーには通知する */
function applySubsystemDamage(
  world: World,
  target: Entity,
  hullDamage: number,
  armorFace: 'front' | 'rear' | 'left' | 'right',
): void {
  if (hullDamage <= 0) return;
  const isPlayer = target.id === world.playerId;
  const rate = isPlayer ? (combatOpts.playerSubsystemRate ?? 1) : 1;
  const broken = rollSubsystemDamage(target, hullDamage, armorFace, rate);
  if (!broken) return;
  if (isPlayer) {
    const state = target.ship!.subsystems![broken];
    const label = SUBSYSTEM_LABELS[broken] ?? broken;
    bus.emit('announce', {
      text: state === 'dead' ? `${label} 損失` : `${label} 損傷`,
      kind: state === 'dead' ? 'bad' : 'warn',
      durationMs: 2400,
    });
  }
}

const SUBSYSTEM_LABELS: Record<string, string> = {
  radar: 'レーダー',
  gunsLeft: '左舷砲',
  gunsRight: '右舷砲',
  engine: 'エンジン',
  shieldGen: 'シールド発生器',
  comms: '通信機',
  thrusters: '姿勢制御',
};

/** 弾と機体の当たり判定 (線分-球スイープ) */
export function resolveProjectileHits(world: World): void {
  for (const p of world.entities) {
    if (!p.alive || p.kind !== 'projectile') continue;
    const pr = p.projectile!;
    if (pr.damage <= 0) continue;

    let bestT = Infinity;
    let bestShip: Entity | undefined;
    for (const s of world.entities) {
      if (!s.alive || s.kind !== 'ship' || !s.ship) continue;
      if (s.id === pr.ownerId) continue;
      const t = sweepSphere(p.prevPos, p.pos, s.pos, s.radius);
      if (t !== null && t < bestT) {
        bestT = t;
        bestShip = s;
      }
    }
    if (!bestShip) continue;

    pointOnSegment(p.prevPos, p.pos, bestT, _hit);
    const dmg = scaleDamage(world, pr.damage, pr.fromPlayer, bestShip.id === world.playerId);
    const res = applyDamage(bestShip, dmg, _hit);
    emitHit(world, bestShip, _hit, res);
    applySubsystemDamage(world, bestShip, res.hullDamage, res.armorFace);
    if (res.destroyed) destroyEntity(world, bestShip, world.byId(pr.ownerId), 'gun');
    world.kill(p);
  }
}

/**
 * 機体同士の接触 (体当たり)。
 *
 * 質量差を「半径の比」で表し、同格同士の擦れは軽傷、
 * 艦艇への激突はほぼ致命傷になるようにしている。
 * 相対速度が低い接触 (編隊飛行中の軽い接触など) は擦り傷で済む。
 */
export function resolveShipCollisions(world: World): void {
  const ships = world.entities.filter((e) => e.alive && e.kind === 'ship' && e.ship);
  for (let i = 0; i < ships.length; i++) {
    for (let j = i + 1; j < ships.length; j++) {
      const a = ships[i];
      const b = ships[j];
      if (!a.alive || !b.alive) continue;
      if (!spheresOverlap(a.pos, a.radius, b.pos, b.radius)) continue;

      const mid = _hit.copy(a.pos).add(b.pos).multiplyScalar(0.5);
      // 押し戻しは毎フレーム行うが、ダメージは接触ごとに1回だけ
      const cooled = a.ship!.collisionCooldown <= 0 && b.ship!.collisionCooldown <= 0;
      if (cooled) {
        a.ship!.collisionCooldown = COLLISION_DAMAGE_INTERVAL;
        b.ship!.collisionCooldown = COLLISION_DAMAGE_INTERVAL;
        applyCollisionDamage(world, a, b, mid);
      }
      separate(a, b);
    }
  }
}

/** 接触ダメージを再判定するまでの間隔 (秒) */
const COLLISION_DAMAGE_INTERVAL = 0.5;

/** 1回の接触ぶんのダメージを両者に与える */
function applyCollisionDamage(world: World, a: Entity, b: Entity, mid: Vector3): void {
  const rel = _sep.copy(a.vel).sub(b.vel).length();
  // 低速の接触は擦り傷。相対速度が上がると急に危険になる
  const impact = Math.max(0, rel - 40);
  const base = 6 + impact * impact * 0.0016;
  // 質量比: 小さい方が大きく損傷する
  const ratioA = collisionRatio(a, b);
  const ratioB = collisionRatio(b, a);

  const ra = applyDamage(a, scaleDamage(world, base * ratioA, false, a.id === world.playerId), mid);
  const rb = applyDamage(b, scaleDamage(world, base * ratioB, false, b.id === world.playerId), mid);
  emitHit(world, a, mid, ra);
  emitHit(world, b, mid, rb);
  applySubsystemDamage(world, a, ra.hullDamage, ra.armorFace);
  applySubsystemDamage(world, b, rb.hullDamage, rb.armorFace);
  if (ra.destroyed) destroyEntity(world, a, b, 'collision');
  if (rb.destroyed) destroyEntity(world, b, a, 'collision');

  if (ra.hullDamage > 0 || rb.hullDamage > 0) {
    bus.emit('explosion', {
      pos: mid.clone(),
      radius: Math.min(a.radius, b.radius) * 0.8,
      kind: 'small',
    });
  }
}

/** 食い込みを解消して押し戻す */
function separate(a: Entity, b: Entity): void {
  _sep.copy(b.pos).sub(a.pos);
  const d = _sep.length();
  if (d < 1e-4) _sep.set(1, 0, 0);
  else _sep.divideScalar(d);
  const overlap = a.radius + b.radius - d;
  const push = Math.max(1, overlap) * 0.5;
  a.pos.addScaledVector(_sep, -push);
  b.pos.addScaledVector(_sep, push);
  // 大質量側は動かないように、小さい方を強く弾く
  const lighter = a.radius >= b.radius ? b : a;
  lighter.vel.addScaledVector(_sep, (lighter === b ? 1 : -1) * 40);
}
