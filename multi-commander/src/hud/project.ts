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

/** 実際に外が見えている範囲 (ピクセル)。コクピットの開口部に対応する。 */
export interface ViewRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * コクピットの開口部 (NDC) をピクセル矩形へ写す。
 *
 * 開口部の値は 3D 側 (`src/render/Cockpit.ts` の `COCKPIT_OPENING`) が唯一の出所。
 * ここでは**読んで写すだけ**なので、構図を変えても HUD が自動で追従する。
 *
 * @param margin 縁から内側へ取る余白 (矢印を縁に置くときに使う)
 */
export function openingRectPx(
  opening: { side: number; top: number; bottom: number },
  width: number,
  height: number,
  margin = 0,
): ViewRect {
  const ndcToX = (n: number) => (n * 0.5 + 0.5) * width;
  const ndcToY = (n: number) => (-n * 0.5 + 0.5) * height;
  return {
    left: ndcToX(-opening.side) + margin,
    right: ndcToX(opening.side) - margin,
    top: ndcToY(opening.top) + margin,
    bottom: ndcToY(opening.bottom) - margin,
  };
}

/** 点が「外が見えている範囲」の内側か。 */
export function pointInRect(p: { x: number; y: number }, r: ViewRect): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/**
 * 範囲の外にある対象を、範囲の縁に寄せた矢印にする。
 *
 * 画面外の矢印 (`edgeArrow`) と同じ考え方だが、基準を画面枠ではなく
 * **開口部の矩形**にする。構造物に隠れて見えていない相手を、
 * 「そこに枠がある」と嘘をつかずに方向だけ示すための表示。
 */
export function rectEdgeArrow(
  p: { x: number; y: number },
  r: ViewRect,
): { x: number; y: number; angleDeg: number } {
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;
  const halfW = Math.max(1e-6, (r.right - r.left) / 2);
  const halfH = Math.max(1e-6, (r.bottom - r.top) / 2);
  const dx = p.x - cx;
  const dy = p.y - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: cx, y: r.bottom, angleDeg: 90 };
  // 中心から点への線が、矩形の縁と交わるところまで伸ばす (内側なら縮めない)
  const scale = Math.min(halfW / Math.abs(dx || 1e-6), halfH / Math.abs(dy || 1e-6));
  const t = Math.min(1, scale);
  return {
    x: cx + dx * t,
    y: cy + dy * t,
    // 角度の向きは edgeArrow と同じ規約 (呼び側で rotate(-angleDeg) する)
    angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}

/**
 * 画面端に寄ったラベルを画面内へ押し戻す (T2-⑧)。
 *
 * `発艦点 2.6k` のような Nav ラベルは `transform: translate(-50%,-50%)` で
 * 中央合わせに置くので、`x = 0` だとラベルの左半分が画面外に出て切れる。
 * ラベルの寸法の**半分**を余白として与え、その分だけ内側へ寄せる。
 *
 * @param halfWidth ラベル幅の半分 (px)
 * @param halfHeight ラベル高さの半分 (px)
 * @param rect 開口部などのさらに内側の枠 (あれば画面枠より優先)
 */
export function clampLabel(
  p: { x: number; y: number },
  width: number,
  height: number,
  halfWidth: number,
  halfHeight: number,
  rect?: ViewRect,
): { x: number; y: number } {
  const left = Math.max(0, rect ? rect.left : 0) + halfWidth;
  const right = Math.min(width, rect ? rect.right : width) - halfWidth;
  const top = Math.max(0, rect ? rect.top : 0) + halfHeight;
  const bottom = Math.min(height, rect ? rect.bottom : height) - halfHeight;
  // 枠がラベルより狭いときは中央に置く (押し戻しで反転させない)
  return {
    x: left > right ? (left + right) / 2 : Math.min(right, Math.max(left, p.x)),
    y: top > bottom ? (top + bottom) / 2 : Math.min(bottom, Math.max(top, p.y)),
  };
}

/** ラベル幅の目安 (px)。日本語と数字が混ざるので 1 文字 = 12px で見積もる。 */
export function estimateLabelHalfWidth(text: string, charPx = 12): number {
  return Math.max(charPx, (text.length * charPx) / 2);
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
