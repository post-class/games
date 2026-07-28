import { Vector3, type Camera } from "three";

/**
 * 有限弾速での命中予測点 (リードインジケータ) を反復近似で求める。
 * 2〜3回で十分収束する。
 */
export function computeLeadPosition(
  shooterPos: Vector3,
  projectileSpeed: number,
  targetPos: Vector3,
  targetVelocity: Vector3,
  out = new Vector3(),
): Vector3 {
  if (projectileSpeed <= 1e-3) return out.copy(targetPos);
  let t = shooterPos.distanceTo(targetPos) / projectileSpeed;
  for (let i = 0; i < 3; i++) {
    out.copy(targetPos).addScaledVector(targetVelocity, t);
    t = shooterPos.distanceTo(out) / projectileSpeed;
  }
  return out.copy(targetPos).addScaledVector(targetVelocity, t);
}

export interface ScreenProjection {
  /** 画面内か。 */
  onScreen: boolean;
  /** ピクセル座標。 */
  x: number;
  y: number;
  /** カメラ背後にあるか。 */
  behind: boolean;
}

const ndc = new Vector3();

/**
 * ワールド座標をスクリーン(ピクセル)座標へ射影する。
 * カメラ背後の点は behind=true とし、x/y は反転補正済み方向を返す。
 */
export function projectToScreen(
  worldPos: Vector3,
  camera: Camera,
  width: number,
  height: number,
): ScreenProjection {
  ndc.copy(worldPos).project(camera);
  const behind = ndc.z > 1;
  let nx = ndc.x;
  let ny = ndc.y;
  if (behind) {
    // 背後の点は符号反転で正しい方向を得る。
    nx = -nx;
    ny = -ny;
  }
  const x = (nx * 0.5 + 0.5) * width;
  const y = (1 - (ny * 0.5 + 0.5)) * height;
  const onScreen = !behind && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
  return { onScreen, x, y, behind };
}

/**
 * 画面外ターゲットの方向 (画面中央からの角度) と、画面端リング上のクランプ座標を求める。
 */
export function computeOffscreenIndicator(
  worldPos: Vector3,
  camera: Camera,
  width: number,
  height: number,
  margin = 60,
): { onScreen: boolean; x: number; y: number; angleRad: number } {
  const proj = projectToScreen(worldPos, camera, width, height);
  if (proj.onScreen) {
    return { onScreen: true, x: proj.x, y: proj.y, angleRad: 0 };
  }
  const cx = width / 2;
  const cy = height / 2;
  const dx = proj.x - cx;
  const dy = proj.y - cy;
  const angle = Math.atan2(dy, dx);
  // 楕円(画面矩形-margin)上にクランプ。
  const rx = width / 2 - margin;
  const ry = height / 2 - margin;
  const scale = 1 / Math.max(Math.abs(Math.cos(angle) / rx), Math.abs(Math.sin(angle) / ry));
  return {
    onScreen: false,
    x: cx + Math.cos(angle) * scale,
    y: cy + Math.sin(angle) * scale,
    angleRad: angle,
  };
}
