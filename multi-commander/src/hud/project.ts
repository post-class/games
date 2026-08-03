import { Vector3, type PerspectiveCamera } from 'three';

export interface ScreenPoint {
  /** ピクセル座標 */
  x: number;
  y: number;
  /** カメラ前方にあるか */
  inFront: boolean;
  /** 画面内に収まっているか */
  onScreen: boolean;
}

const _v = new Vector3();

/** ワールド座標を画面ピクセル座標へ */
export function worldToScreen(
  camera: PerspectiveCamera,
  pos: Vector3,
  width: number,
  height: number,
  out: ScreenPoint = { x: 0, y: 0, inFront: false, onScreen: false },
): ScreenPoint {
  _v.copy(pos).project(camera);
  out.inFront = _v.z < 1;
  out.x = (_v.x * 0.5 + 0.5) * width;
  out.y = (-_v.y * 0.5 + 0.5) * height;
  out.onScreen = out.inFront && _v.x >= -1 && _v.x <= 1 && _v.y >= -1 && _v.y <= 1;
  return out;
}

/**
 * 画面外のターゲットを指す矢印の位置と角度。
 * 画面中心から見た方向へ、縁に沿って配置する。
 */
export function edgeArrow(
  camera: PerspectiveCamera,
  pos: Vector3,
  width: number,
  height: number,
  margin: number,
): { x: number; y: number; angleDeg: number } {
  _v.copy(pos).project(camera);
  let nx = _v.x;
  let ny = _v.y;
  if (_v.z >= 1) {
    // 背後にある場合は方向を反転して縁へ寄せる
    nx = -nx;
    ny = -ny;
    const len = Math.hypot(nx, ny) || 1e-6;
    nx /= len;
    ny /= len;
  }
  const len = Math.hypot(nx, ny) || 1e-6;
  // 画面枠に当たるまで伸ばす
  const halfW = width / 2 - margin;
  const halfH = height / 2 - margin;
  const sx = (nx / len) * halfW;
  const sy = (ny / len) * halfH;
  const scale = Math.min(Math.abs(halfW / (sx || 1e-6)), Math.abs(halfH / (sy || 1e-6)), 1e6);
  const px = width / 2 + sx * Math.min(scale, 1);
  const py = height / 2 - sy * Math.min(scale, 1);
  const angleDeg = (Math.atan2(-ny, nx) * 180) / Math.PI;
  return { x: px, y: py, angleDeg };
}
