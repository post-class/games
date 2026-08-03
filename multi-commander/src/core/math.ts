import { Quaternion, Vector3 } from 'three';

/** 機体ローカル軸の規約: forward = -Z, up = +Y, right = +X */
export const LOCAL_FORWARD = new Vector3(0, 0, -1);
export const LOCAL_UP = new Vector3(0, 1, 0);
export const LOCAL_RIGHT = new Vector3(1, 0, 0);

export const DEG = Math.PI / 180;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** t を [0,1] に正規化 (a==b のときは 0) */
export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp01((v - a) / (b - a));
}

/** 現在値を目標値へ一定速度で近づける (フレームレート非依存) */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/**
 * 指数減衰による追従。halfLife 秒で目標との差が半分になる。
 * dt に依存しない滑らかな追従が欲しい箇所で使う。
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target;
  const k = Math.pow(0.5, dt / halfLife);
  return target + (current - target) * k;
}

export function dampVec(out: Vector3, target: Vector3, halfLife: number, dt: number): Vector3 {
  if (halfLife <= 0) return out.copy(target);
  const k = Math.pow(0.5, dt / halfLife);
  out.x = target.x + (out.x - target.x) * k;
  out.y = target.y + (out.y - target.y) * k;
  out.z = target.z + (out.z - target.z) * k;
  return out;
}

/** 姿勢クォータニオンから前方ベクトルを得る */
export function forwardOf(q: Quaternion, out = new Vector3()): Vector3 {
  return out.copy(LOCAL_FORWARD).applyQuaternion(q);
}

export function upOf(q: Quaternion, out = new Vector3()): Vector3 {
  return out.copy(LOCAL_UP).applyQuaternion(q);
}

export function rightOf(q: Quaternion, out = new Vector3()): Vector3 {
  return out.copy(LOCAL_RIGHT).applyQuaternion(q);
}

/**
 * 角速度 (機体ローカル系, rad/s) でクォータニオンを1ステップ積分する。
 * q' = normalize(q + 0.5*dt * q ⊗ (ω,0))
 */
export function integrateRotation(q: Quaternion, omegaLocal: Vector3, dt: number): Quaternion {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const { x: wx, y: wy, z: wz } = omegaLocal;
  const dx = qw * wx + qy * wz - qz * wy;
  const dy = qw * wy + qz * wx - qx * wz;
  const dz = qw * wz + qx * wy - qy * wx;
  const dw = -(qx * wx + qy * wy + qz * wz);
  const h = 0.5 * dt;
  return q.set(qx + h * dx, qy + h * dy, qz + h * dz, qw + h * dw).normalize();
}

/**
 * 目標方向 (ワールド) へ機首を向けるためのローカル角速度指令を求める。
 * 戻り値は {pitch, yaw} で、それぞれ -1..1 の操縦入力相当。
 */
export function aimError(
  q: Quaternion,
  toTarget: Vector3,
): { pitch: number; yaw: number; angle: number } {
  const local = _tmpA.copy(toTarget).applyQuaternion(_tmpQ.copy(q).invert());
  const len = local.length();
  if (len < 1e-6) return { pitch: 0, yaw: 0, angle: 0 };
  local.divideScalar(len);
  // local: forward = -Z。z が負なら前方。
  const angle = Math.acos(clamp(-local.z, -1, 1));
  // 前方から見て上 (+Y) にずれていれば nose up (pitch +)
  const pitch = local.y;
  // 右 (+X) にずれていれば yaw right (yaw +)
  const yaw = local.x;
  return { pitch, yaw, angle };
}

const _tmpA = new Vector3();
const _tmpQ = new Quaternion();

/**
 * 弾速 speed の弾を shooterPos から撃って targetPos (速度 targetVel) に当てる射点。
 * 相対運動の2次方程式を解く。解が無ければ現在位置を返す。
 */
export function leadPoint(
  shooterPos: Vector3,
  targetPos: Vector3,
  targetVel: Vector3,
  speed: number,
  out = new Vector3(),
): Vector3 {
  const rx = targetPos.x - shooterPos.x;
  const ry = targetPos.y - shooterPos.y;
  const rz = targetPos.z - shooterPos.z;
  const a = targetVel.lengthSq() - speed * speed;
  const b = 2 * (rx * targetVel.x + ry * targetVel.y + rz * targetVel.z);
  const c = rx * rx + ry * ry + rz * rz;

  let t = -1;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) > 1e-6) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b + sq) / (2 * a);
      const t2 = (-b - sq) / (2 * a);
      // 正で小さい方を採用
      const cands = [t1, t2].filter((v) => v > 0);
      if (cands.length) t = Math.min(...cands);
    }
  }
  if (t <= 0 || !Number.isFinite(t)) return out.copy(targetPos);
  return out.set(targetPos.x + targetVel.x * t, targetPos.y + targetVel.y * t, targetPos.z + targetVel.z * t);
}

/** ワールド距離 */
export function dist(a: Vector3, b: Vector3): number {
  return a.distanceTo(b);
}
