import { Vector3 } from 'three';
import { bus } from '../core/events';
import { integrateRotation } from '../core/math';
import type { Entity } from '../world/entity';
import { spawnRock, type World } from '../world/world';
import { pointOnSegment, spheresOverlap, sweepSphere } from './collision';
import { applyDamage } from './damage';
import { destroyEntity } from './combat';

/**
 * 小惑星と機雷。
 *
 * 何も無い空間では回避に意味が無いので、「そこを通ると危ない場所」を作る。
 * 岩は撃って壊せるが、避けた方が速い。機雷は近づくと起爆する。
 */

const _hit = new Vector3();
const _sep = new Vector3();

/**
 * 岩にぶつかったときのダメージ係数 (相対速度に対して)。
 * 全速で突っ込めば致命傷になるが、一撃で死なない程度に抑える。
 * これより大きいと、岩が見えた瞬間には手遅れになってしまう。
 */
const ROCK_IMPACT = 0.28;
/** 岩の接触ダメージを再判定する間隔 */
const ROCK_DAMAGE_INTERVAL = 0.5;

/** 岩の漂流と自転、機雷の起爆判定 */
export function updateObstacles(world: World, dt: number): void {
  for (const e of world.entities) {
    if (!e.alive) continue;

    if (e.kind === 'rock') {
      e.prevPos.copy(e.pos);
      e.pos.addScaledVector(e.vel, dt);
      integrateRotation(e.quat, e.rock!.spin, dt);
      continue;
    }

    if (e.kind === 'mine') {
      updateMine(world, e, dt);
    }
  }
}

function updateMine(world: World, e: Entity, dt: number): void {
  const m = e.mine!;
  e.prevPos.copy(e.pos);
  e.pos.addScaledVector(e.vel, dt);

  if (m.armed) {
    m.fuse -= dt;
    if (m.fuse <= 0) detonateMine(world, e);
    return;
  }

  // 敷設側以外の機体が近づくと起爆シーケンスに入る
  for (const s of world.entities) {
    if (!s.alive || s.kind !== 'ship' || !s.ship) continue;
    if (s.faction === m.ownerFaction) continue;
    if (s.ship.def.role === 'capital') continue;
    if (s.pos.distanceTo(e.pos) > m.triggerRadius + s.radius) continue;
    m.armed = true;
    if (s.id === world.playerId) {
      bus.emit('announce', { text: '機雷 — 起爆する', kind: 'bad', durationMs: 1400 });
    }
    return;
  }
}

function detonateMine(world: World, e: Entity): void {
  const m = e.mine!;
  for (const s of world.entities) {
    if (!s.alive || s.kind !== 'ship' || !s.ship) continue;
    const d = s.pos.distanceTo(e.pos) - s.radius;
    if (d > m.blastRadius) continue;
    const falloff = 1 - Math.max(0, d) / m.blastRadius;
    const res = applyDamage(s, m.damage * (0.3 + 0.7 * falloff), e.pos);
    if (res.shieldAbsorbed > 0) {
      bus.emit('shieldHit', {
        target: s,
        point: e.pos.clone(),
        amount: res.shieldAbsorbed,
        isPlayer: s.id === world.playerId,
      });
    }
    if (res.armorAbsorbed > 0) {
      bus.emit('armorHit', {
        target: s,
        point: e.pos.clone(),
        amount: res.armorAbsorbed,
        layer: 'armor',
        isPlayer: s.id === world.playerId,
      });
    }
    if (res.hullDamage > 0) {
      bus.emit('armorHit', {
        target: s,
        point: e.pos.clone(),
        amount: res.hullDamage,
        layer: 'hull',
        isPlayer: s.id === world.playerId,
      });
    }
    if (res.destroyed) destroyEntity(world, s);
  }
  bus.emit('explosion', { pos: e.pos.clone(), radius: m.blastRadius * 0.5, kind: 'missile' });
  world.kill(e);
}

/**
 * 弾が岩や機雷に当たる判定。
 * 岩に隠れて撃ち合える (弾が遮られる) ことで、戦域に地形としての意味が出る。
 */
export function resolveObstacleHits(world: World): void {
  for (const p of world.entities) {
    if (!p.alive || p.kind !== 'projectile') continue;
    const pr = p.projectile!;
    if (pr.damage <= 0) continue;

    let bestT = Infinity;
    let target: Entity | undefined;
    for (const o of world.entities) {
      if (!o.alive || (o.kind !== 'rock' && o.kind !== 'mine')) continue;
      const t = sweepSphere(p.prevPos, p.pos, o.pos, o.radius);
      if (t !== null && t < bestT) {
        bestT = t;
        target = o;
      }
    }
    if (!target) continue;

    pointOnSegment(p.prevPos, p.pos, bestT, _hit);
    if (target.kind === 'mine') {
      // 機雷は撃てば安全に処理できる
      target.mine!.hull -= pr.damage;
      bus.emit('explosion', { pos: _hit.clone(), radius: 12, kind: 'small' });
      if (target.mine!.hull <= 0) {
        bus.emit('explosion', {
          pos: target.pos.clone(),
          radius: target.mine!.blastRadius * 0.4,
          kind: 'missile',
        });
        world.kill(target);
      }
    } else {
      target.rock!.hull -= pr.damage;
      bus.emit('armorHit', {
        target,
        point: _hit.clone(),
        amount: pr.damage,
        layer: 'armor',
        isPlayer: false,
      });
      if (target.rock!.hull <= 0) breakRock(world, target);
    }
    world.kill(p);
  }
}

/** 岩を砕く。大きい岩は小さい破片に分裂する */
function breakRock(world: World, rock: Entity): void {
  bus.emit('explosion', { pos: rock.pos.clone(), radius: rock.radius * 1.2, kind: 'missile' });
  world.kill(rock);

  const r = rock.radius * 0.42;
  if (r < 7) return;
  for (let i = 0; i < 3; i++) {
    const dir = new Vector3(
      Math.sin(i * 2.1 + rock.pos.x),
      Math.sin(i * 1.7 + rock.pos.y),
      Math.cos(i * 2.4 + rock.pos.z),
    );
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const child = spawnRock(world, {
      pos: rock.pos.clone().addScaledVector(dir, rock.radius * 0.6),
      radius: r,
      vel: rock.vel.clone().addScaledVector(dir, 26),
      variant: (rock.rock!.variant + i + 1) % 4,
      seed: rock.pos.x + i * 7.3,
    });
    child.label = '岩塊';
    child.rock!.spin.copy(rock.rock!.spin).multiplyScalar(1.8);
  }
}

/**
 * 機体が岩に接触したときの処理。
 * 相対速度が高いほど痛い。艦艇は岩を押し退ける。
 */
export function resolveObstacleCollisions(world: World): void {
  for (const o of world.entities) {
    if (!o.alive || o.kind !== 'rock') continue;
    for (const s of world.entities) {
      if (!s.alive || s.kind !== 'ship' || !s.ship) continue;
      if (!spheresOverlap(s.pos, s.radius, o.pos, o.radius)) continue;

      const rel = _sep.copy(s.vel).sub(o.vel).length();
      if (s.ship.collisionCooldown <= 0) {
        if (s.id === world.playerId) {
          bus.emit('announce', { text: '岩に接触', kind: 'bad', durationMs: 1200 });
          bus.emit('cameraShake', { strength: 0.5 });
        }
        s.ship.collisionCooldown = ROCK_DAMAGE_INTERVAL;
        const mid = _hit.copy(s.pos).add(o.pos).multiplyScalar(0.5);
        const impact = Math.max(0, rel - 30);
        const dmg = 5 + impact * ROCK_IMPACT;
        const res = applyDamage(s, dmg, mid);
        if (res.shieldAbsorbed > 0) {
          bus.emit('shieldHit', {
            target: s,
            point: mid.clone(),
            amount: res.shieldAbsorbed,
            isPlayer: s.id === world.playerId,
          });
        }
        if (res.armorAbsorbed > 0) {
          bus.emit('armorHit', {
            target: s,
            point: mid.clone(),
            amount: res.armorAbsorbed,
            layer: 'armor',
            isPlayer: s.id === world.playerId,
          });
        }
        if (res.hullDamage > 0) {
          bus.emit('armorHit', {
            target: s,
            point: mid.clone(),
            amount: res.hullDamage,
            layer: 'hull',
            isPlayer: s.id === world.playerId,
          });
        }
        if (res.destroyed) destroyEntity(world, s);
        // 小さい岩は機体に砕かれる
        if (o.radius < s.radius * 0.8) {
          breakRock(world, o);
          continue;
        }
      }

      // 押し戻し。岩の方が軽ければ岩が動く
      _sep.copy(o.pos).sub(s.pos);
      const d = _sep.length();
      if (d < 1e-4) _sep.set(1, 0, 0);
      else _sep.divideScalar(d);
      const overlap = s.radius + o.radius - d;
      if (o.radius < s.radius) {
        o.pos.addScaledVector(_sep, overlap);
        o.vel.addScaledVector(_sep, 24);
      } else {
        s.pos.addScaledVector(_sep, -overlap);
        s.vel.addScaledVector(_sep, -18);
      }
    }
  }
}

/** ミサイルが岩に当たる (誘導兵器が地形に吸われる) */
export function resolveObstacleMissileHits(world: World): void {
  for (const m of world.entities) {
    if (!m.alive || m.kind !== 'missile') continue;
    for (const o of world.entities) {
      if (!o.alive || o.kind !== 'rock') continue;
      const t = sweepSphere(m.prevPos, m.pos, o.pos, o.radius);
      if (t === null) continue;
      pointOnSegment(m.prevPos, m.pos, t, _hit);
      o.rock!.hull -= m.missile!.def.damage * 0.5;
      bus.emit('explosion', {
        pos: _hit.clone(),
        radius: m.missile!.def.blastRadius * 0.7,
        kind: 'missile',
      });
      if (o.rock!.hull <= 0) breakRock(world, o);
      world.kill(m);
      break;
    }
  }
}

/** 障害物が近くにあるか (AI の回避と HUD 警告に使う) */
export function nearestObstacle(world: World, pos: Vector3, range: number): Entity | undefined {
  let best: Entity | undefined;
  let bestD = range;
  for (const o of world.entities) {
    if (!o.alive || (o.kind !== 'rock' && o.kind !== 'mine')) continue;
    const d = o.pos.distanceTo(pos) - o.radius;
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}
