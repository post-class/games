import { Vector3 } from 'three';
import { clamp, clamp01, dampVec, forwardOf, integrateRotation } from '../core/math';
import type { Entity } from '../world/entity';
import { gravityMassFactor } from './obstacles';
import { afterburnerAvailable, engineOutput, shieldRegenScale, thrusterOutput } from './subsystems';

export type FlightMode = 'wc' | 'newton';

const _desired = new Vector3();
const _delta = new Vector3();
const _cmd = new Vector3();
const _fwd = new Vector3();
const _axis = new Vector3();
const _lat = new Vector3();

/** アフターバーナー中の加速倍率 */
const AB_ACCEL_BOOST = 1.7;
/** アフターバーナー中は旋回が鈍る (WC の手触り) */
const AB_TURN_PENALTY = 0.72;
/** 燃料の自然回復 (毎秒, def.fuel に対する割合) */
const FUEL_RECOVER_RATE = 0.09;
/**
 * 旋回で進行方向を付け替えるときだけ使える推力の倍率 (T2-⑤)。
 *
 * ■ なぜ必要か
 * `wc` モードの速度は「機首方向の目標速度へ `accel` で追従する」だけなので、
 * 全速で旋回すると釣り合いの速度が `accel / 旋回角速度` に落ちる。
 * ホーネット (accel 320 / yaw 1.7) では 400 → 約190 kps まで落ち、
 * **旋回した時点で追撃が成立しない**（第1章の実プレイで確認）。
 *
 * ■ どう直したか
 * 速度差 (前後方向) と進行方向の付け替え (横方向) を別の予算にし、
 * 横方向にだけこの倍率を掛ける。釣り合いの速度が
 * `accel * TURN_ALIGN_BOOST / 旋回角速度` になるので、
 * ホーネットは約 265 kps を保てる（変更前 約190 kps）。

 * ■ 値の決め方
 * 1.4 は「全速の横旋回で最高速の 2/3 前後を保つ」水準。
 * これより大きくすると被弾しない旋回戦が増え、AI の技量差が
 * 結果に出にくくなる（`tests/ut/ai.test.ts` の 1v1 決着で確認）ため、
 * 既存の技量差・機体差のテストが通る範囲でいちばん大きい値を採った。
 *
 * ■ 壊していないこと
 * - 直線加速・減速は前後方向の予算のみを使うので数値が変わらない。
 * - `handling.turnSpeedPenalty`（最高速では曲がらない）と
 *   `handling.drift`（速度が機首に追いつかない）はそのまま効くので、
 *   重い機体は依然「曲がりたければ絞る」判断が要る。
 * - 難易度に関わる項はこの関数に無い（速度差は `speedScale` 側）。
 */
const TURN_ALIGN_BOOST = 1.4;

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
  // 局所重力による実効質量 (第4章 T6-4)。
  // 重力井戸の宣言が無い作戦では `gravityMassFactor()` が必ず 1 を返すので、
  // ここは従来の式と完全に一致する。井戸の中では数秒周期で
  // 「重くて曲がらない / 軽くて効きすぎる」が入れ替わり、機動の前提が崩れる。
  const massScale = 1 / gravityMassFactor(e.pos);
  // 姿勢制御が壊れていれば旋回が鈍る
  const turnScale = (ab ? AB_TURN_PENALTY : 1) * speedTurnScale * thrusterOutput(ship) * massScale;
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
    const maxDelta = def.accel * driftScale * (ab ? AB_ACCEL_BOOST : 1) * massScale * dt;
    const speedLen = e.vel.length();
    if (speedLen > 1e-4) {
      // 前後方向 (速度そのものの増減) と横方向 (進行方向の付け替え) を別の予算で扱う。
      // 横方向だけ TURN_ALIGN_BOOST ぶん多く使えるので、旋回で速度が半分以下に
      // 落ちなくなる。予算内に収まっている間は従来と完全に同じ値になる。
      _axis.copy(e.vel).divideScalar(speedLen);
      const along = _delta.dot(_axis);
      _lat.copy(_delta).addScaledVector(_axis, -along);
      const latLen = _lat.length();
      const latBudget = maxDelta * TURN_ALIGN_BOOST;
      if (latLen > latBudget && latLen > 1e-6) _lat.multiplyScalar(latBudget / latLen);
      _delta.copy(_lat).addScaledVector(_axis, clamp(along, -maxDelta, maxDelta));
    } else {
      const len = _delta.length();
      if (len > maxDelta && len > 1e-6) _delta.multiplyScalar(maxDelta / len);
    }
    e.vel.add(_delta);
  } else {
    // 純慣性: 推力は機首方向にしか出ない
    const thrust =
      def.accel * engineOutput(ship) * (ab ? AB_ACCEL_BOOST : 1) * throttle * massScale * dt;
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
