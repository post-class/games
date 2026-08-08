import { Vector3 } from 'three';
import { clamp, clamp01, dampVec, forwardOf, integrateRotation } from '../core/math';
import type { Entity } from '../world/entity';
import { afterburnerAvailable, engineOutput, shieldRegenScale, thrusterOutput } from './subsystems';

export type FlightMode = 'wc' | 'newton';

const _desired = new Vector3();
const _delta = new Vector3();
const _cmd = new Vector3();
const _fwd = new Vector3();

/** アフターバーナー中の加速倍率 */
const AB_ACCEL_BOOST = 1.7;
/** アフターバーナー中は旋回が鈍る (WC の手触り) */
const AB_TURN_PENALTY = 0.72;
/** 燃料の自然回復 (毎秒, def.fuel に対する割合) */
const FUEL_RECOVER_RATE = 0.09;

/**
 * 1機の飛行を1ステップ進める。プレイヤー・AI・僚機で共通。
 * ロジックのみ (Three.js の Object3D には触らない)。
 */
export function updateFlight(e: Entity, dt: number, mode: FlightMode = 'wc'): void {
  const ship = e.ship;
  const input = e.input;
  if (!ship || !input) return;
  const def = ship.def;
  const speedScale = Math.max(0.01, ship.speedScale);
  const maxSpeed = def.maxSpeed * speedScale;
  const afterburnerSpeed = def.abSpeed * speedScale;

  // ── アフターバーナー & 燃料 ──
  const wantsAb = input.afterburner && ship.fuelMax > 0 && afterburnerAvailable(ship);
  const ab = wantsAb && ship.fuel > 0;
  if (ab) {
    ship.fuel = Math.max(0, ship.fuel - def.fuelBurn * dt);
  } else if (!wantsAb && ship.fuelMax > 0) {
    // キーを押し続けている間は回復しない (枯渇後にガクガク再点火しないように)
    ship.fuel = Math.min(ship.fuelMax, ship.fuel + ship.fuelMax * FUEL_RECOVER_RATE * dt);
  }

  // ── 角速度 ──
  // 規約: pitch+ = 機首上げ (ωx+), yaw+ = 右 (ωy-), roll+ = 右ロール (ωz-)
  //
  // 機体の癖: 最高速付近では旋回性能が落ちる。
  // 重い機体は penalty が大きいので「曲がりたければ絞る」判断が要る。
  const speedNow = e.vel.length();
  const speedRatio = clamp01(speedNow / Math.max(1, maxSpeed));
  const speedTurnScale = 1 - def.handling.turnSpeedPenalty * speedRatio * speedRatio;
  // 姿勢制御が壊れていれば旋回が鈍る
  const turnScale = (ab ? AB_TURN_PENALTY : 1) * speedTurnScale * thrusterOutput(ship);
  _cmd.set(
    clamp(input.pitch, -1, 1) * def.turn[0] * turnScale,
    -clamp(input.yaw, -1, 1) * def.turn[1] * turnScale,
    -clamp(input.roll, -1, 1) * def.turn[2] * turnScale,
  );
  // agility が大きいほど短い halfLife で指令角速度に追従する
  dampVec(e.angVel, _cmd, 0.7 / Math.max(0.5, def.agility), dt);
  integrateRotation(e.quat, e.angVel, dt);

  // ── 速度 ──
  forwardOf(e.quat, _fwd);
  const throttle = clamp01(input.throttle);
  if (mode === 'wc') {
    // アーケード飛行: 速度ベクトルが機首方向へ追従する
    // エンジン損傷で最高速が落ちる
    const power = engineOutput(ship);
    const targetSpeed = (ab ? afterburnerSpeed : throttle * maxSpeed) * power;
    _desired.copy(_fwd).multiplyScalar(targetSpeed);
    _delta.copy(_desired).sub(e.vel);
    // drift が大きい機体は速度が機首に追いつくのが遅く、旋回中に流れる
    const driftScale = 1 - def.handling.drift * 0.75;
    const maxDelta = def.accel * driftScale * (ab ? AB_ACCEL_BOOST : 1) * dt;
    const len = _delta.length();
    if (len > maxDelta && len > 1e-6) _delta.multiplyScalar(maxDelta / len);
    e.vel.add(_delta);
  } else {
    // 純慣性: 推力は機首方向にしか出ない
    const thrust = def.accel * engineOutput(ship) * (ab ? AB_ACCEL_BOOST : 1) * throttle * dt;
    e.vel.addScaledVector(_fwd, thrust);
    if (throttle <= 0.01) {
      // 逆噴射による減速
      const brake = def.accel * 0.35 * dt;
      const sp = e.vel.length();
      if (sp > 1e-4) e.vel.multiplyScalar(Math.max(0, sp - brake) / sp);
    }
    const cap = ab ? afterburnerSpeed : maxSpeed * 1.25;
    const sp = e.vel.length();
    if (sp > cap) e.vel.multiplyScalar(cap / sp);
  }

  // ── 位置 ──
  e.prevPos.copy(e.pos);
  e.pos.addScaledVector(e.vel, dt);
}

/**
 * エネルギー / シールド再生。
 * 砲とシールド発生器が同じエネルギーを分け合う (WC のリソース管理)。
 * 撃ち続けるとシールドが戻らない、というトレードオフを作る。
 */
export function updateShipPower(e: Entity, dt: number): void {
  const ship = e.ship;
  if (!ship) return;
  const def = ship.def;

  ship.energy = Math.min(def.energy, ship.energy + def.energyRegen * dt);

  for (let i = 0; i < ship.gunCooldown.length; i++) {
    if (ship.gunCooldown[i] > 0) ship.gunCooldown[i] -= dt;
  }
  if (ship.flareCooldown > 0) ship.flareCooldown -= dt;
  if (ship.collisionCooldown > 0) ship.collisionCooldown -= dt;
  if (ship.shieldDelay > 0) {
    // 被弾直後は再生しない。撃たれ続けている間はシールドが戻らない。
    ship.shieldDelay -= dt;
    return;
  }

  // シールド再生はエネルギーを消費する
  const need =
    def.shield.front - ship.shield.front + (def.shield.rear - ship.shield.rear);
  if (need <= 0.001) return;

  // エネルギー残量が少ないと再生も遅くなる。発生器が壊れていれば止まる
  const genScale = shieldRegenScale(ship);
  if (genScale <= 0) return;
  const energyRatio = clamp01(ship.energy / Math.max(1, def.energy));
  const rate = def.shield.regen * (0.35 + 0.65 * energyRatio) * genScale;
  let budget = Math.min(rate * dt, ship.energy * 0.6);
  if (budget <= 0) return;

  // 薄い方を優先して回復
  const faces: Array<'front' | 'rear'> =
    def.shield.front - ship.shield.front >= def.shield.rear - ship.shield.rear
      ? ['front', 'rear']
      : ['rear', 'front'];
  for (const f of faces) {
    const room = def.shield[f] - ship.shield[f];
    if (room <= 0) continue;
    const give = Math.min(room, budget);
    ship.shield[f] += give;
    budget -= give;
    ship.energy = Math.max(0, ship.energy - give * 0.5);
    if (budget <= 0) break;
  }
}

/** HUD 表示用の現在速度 */
export function speedOf(e: Entity): number {
  return e.vel.length();
}
