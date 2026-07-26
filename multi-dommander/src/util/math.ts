import { Vector3, Quaternion } from "three";

export const EPS = 1e-6;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** フレームレート非依存の指数減衰係数。value *= dampFactor(k, dt) で使う。 */
export function dampFactor(k: number, dt: number): number {
  return Math.exp(-k * dt);
}

/** ベクトルの長さを max 以下にクランプ（in-place）。 */
export function clampLength(v: Vector3, max: number): Vector3 {
  const lenSq = v.lengthSq();
  if (lenSq > max * max && lenSq > EPS) {
    v.multiplyScalar(max / Math.sqrt(lenSq));
  }
  return v;
}

/** デッドゾーンと感度カーブ(指数)を適用。入力は -1..1 想定。 */
export function applyDeadzoneCurve(value: number, deadzone: number, expo = 1.5): number {
  const sign = Math.sign(value);
  const mag = Math.abs(value);
  if (mag < deadzone) return 0;
  const scaled = (mag - deadzone) / (1 - deadzone);
  return sign * Math.pow(clamp(scaled, 0, 1), expo);
}

/**
 * 機体ローカル角速度 omega からクォータニオン姿勢を離散更新する（半角近似）。
 * q_next = normalize(q * dq), dq ≈ [0.5*wx*dt, 0.5*wy*dt, 0.5*wz*dt, 1]
 */
export function integrateOrientation(q: Quaternion, omega: Vector3, dt: number): void {
  const half = 0.5 * dt;
  const dq = new Quaternion(omega.x * half, omega.y * half, omega.z * half, 1);
  q.multiply(dq).normalize();
}

/** 再利用用の一時ベクトル/クォータニオン（GC削減）。 */
export const tmpVec3 = new Vector3();
export const tmpVec3b = new Vector3();
export const tmpQuat = new Quaternion();
