/**
 * 被弾がどこから来たかを、画面の縁と装甲図に写す (T2-⑨).
 *
 * 「シールドが 76% → 50% と削られたのに、どこから撃たれているか分からない」への対応。
 * **深刻さの判定は `hud/damageStage.ts` が唯一の出所**で、ここは扱わない。
 * ここが決めるのは方向だけ。
 *
 * 座標系は機体ローカル (自機の姿勢を打ち消した後)。
 * x = 右、y = 上、機首は -z (`radarPoint()` と同じ規約)。
 */

/** 光らせる画面の縁。 */
export type HitEdge = 'left' | 'right' | 'top' | 'bottom';

/** 縁の日本語表記。点滅を抑える設定でも文字で残すために使う。 */
export const HIT_EDGE_LABEL: Record<HitEdge, string> = {
  left: '左',
  right: '右',
  top: '上',
  bottom: '下',
};

/** 装甲図の4象限。`world/entity.ts` の `ArmorFace` と同じ語。 */
export type HitFace = 'front' | 'rear' | 'left' | 'right';

/** 真横・真上の判定がぶれない程度の下限 (機体半径より内側の誤差を無視する)。 */
const EPSILON = 1e-4;

/**
 * 被弾方向 → 光らせる縁。
 *
 * 左右の成分が上下より大きければ左右、そうでなければ上下。
 * どちらもほぼ0 (真正面か真後ろ) のときは、後ろからなら下端、前からなら上端にする
 * （真正面の被弾は照準の先で見えているので、視線を上げれば分かる）。
 */
export function hitEdgeOf(local: { x: number; y: number; z: number }): HitEdge {
  const ax = Math.abs(local.x);
  const ay = Math.abs(local.y);
  if (ax < EPSILON && ay < EPSILON) return local.z > 0 ? 'bottom' : 'top';
  if (ax >= ay) return local.x >= 0 ? 'right' : 'left';
  return local.y >= 0 ? 'top' : 'bottom';
}

/**
 * 被弾方向 → 装甲図の面。
 *
 * ダメージ計算が面を返している (`shieldHit` / `armorHit` の `hitFace`) ときは
 * **そちらを使う**。この関数は面が付いてこない被弾 (衝突・機雷など) の保険。
 */
export function hitFaceOf(local: { x: number; y: number; z: number }): HitFace {
  const ax = Math.abs(local.x);
  const az = Math.abs(local.z);
  if (az >= ax) return local.z > 0 ? 'rear' : 'front';
  return local.x >= 0 ? 'right' : 'left';
}
