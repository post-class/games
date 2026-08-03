import { Vector3 } from 'three';

/**
 * 線分 p0→p1 と 半径 r の球 (中心 c) の最初の交差パラメータ t (0..1) を返す。
 * 交差しなければ null。高速弾のすり抜けを防ぐためのスイープ判定。
 */
export function sweepSphere(
  p0: Vector3,
  p1: Vector3,
  c: Vector3,
  r: number,
): number | null {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dz = p1.z - p0.z;
  const mx = p0.x - c.x;
  const my = p0.y - c.y;
  const mz = p0.z - c.z;

  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (mx * dx + my * dy + mz * dz);
  const cc = mx * mx + my * my + mz * mz - r * r;

  // 始点が既に球内なら即ヒット
  if (cc <= 0) return 0;
  if (a <= 1e-12) return null;

  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  const t2 = (-b + sq) / (2 * a);
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

/** 2球の重なり判定 (機体同士の接触) */
export function spheresOverlap(a: Vector3, ra: number, b: Vector3, rb: number): boolean {
  const d = ra + rb;
  return a.distanceToSquared(b) <= d * d;
}

/** 線分上の点 */
export function pointOnSegment(p0: Vector3, p1: Vector3, t: number, out = new Vector3()): Vector3 {
  return out.copy(p0).lerp(p1, t);
}
