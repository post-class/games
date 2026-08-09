/**
 * 斜め見下ろし（擬似アイソメ）の座標変換。T-M5-01 の中核。
 *
 * 実装手順書 §7.1:
 *   sx = (x - y) * TW / 2
 *   sy = (x + y) * TH / 2
 *
 * ここは純関数のみ。Canvas も World も触らない（テストしやすさのため）。
 * sim 側の座標は Fx（実数 × 256）だが、描画側は補間するので通常の
 * number（マス単位の小数）で扱う。変換はこのモジュールの入口で行う。
 */

/** タイル 1 枚の画面上の幅（px, ズーム 1.0 のとき）。2:1 の菱形。 */
export const TILE_W = 64;
/** タイル 1 枚の画面上の高さ（px, ズーム 1.0 のとき）。 */
export const TILE_H = 32;

/** ズーム段階（手順書 §7.1 / 06§7「4 段階」）。 */
export const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.5] as const;

export interface Camera {
  /** 画面中央が見ているマップ座標（マス単位、小数可） */
  cx: number;
  cy: number;
  /** ZOOM_LEVELS の値 */
  zoom: number;
  /** ビューポートの px サイズ */
  viewW: number;
  viewH: number;
}

export interface ScreenPos {
  sx: number;
  sy: number;
}

export interface TilePos {
  x: number;
  y: number;
}

/** マップ座標（マス）→ ワールド画面座標（px, カメラ無視）。 */
export function tileToWorld(x: number, y: number, zoom = 1): ScreenPos {
  return {
    sx: ((x - y) * TILE_W * zoom) / 2,
    sy: ((x + y) * TILE_H * zoom) / 2,
  };
}

/** ワールド画面座標（px）→ マップ座標（マス）。tileToWorld の逆変換。 */
export function worldToTile(sx: number, sy: number, zoom = 1): TilePos {
  const a = (sx * 2) / (TILE_W * zoom);
  const b = (sy * 2) / (TILE_H * zoom);
  return { x: (b + a) / 2, y: (b - a) / 2 };
}

/** マップ座標 → 実際に描くビューポート座標（px）。 */
export function tileToScreen(cam: Camera, x: number, y: number): ScreenPos {
  const p = tileToWorld(x, y, cam.zoom);
  const c = tileToWorld(cam.cx, cam.cy, cam.zoom);
  return {
    sx: p.sx - c.sx + cam.viewW / 2,
    sy: p.sy - c.sy + cam.viewH / 2,
  };
}

/** ビューポート座標（px, マウス位置など）→ マップ座標。 */
export function screenToTile(cam: Camera, sx: number, sy: number): TilePos {
  const c = tileToWorld(cam.cx, cam.cy, cam.zoom);
  return worldToTile(sx - cam.viewW / 2 + c.sx, sy - cam.viewH / 2 + c.sy, cam.zoom);
}

/** タイルの矩形範囲（両端を含む）。 */
export interface TileBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 画面に映っているマップ範囲（描画するタイルの矩形）。
 * 菱形の四隅からマップ座標を求め、その外接矩形に余白 `pad` を足す。
 */
export function visibleTileBounds(cam: Camera, mapW: number, mapH: number, pad = 2): TileBounds {
  return tileBoundsForScreenRect(cam, mapW, mapH, 0, 0, cam.viewW, cam.viewH, pad);
}

/**
 * **画面の一部の矩形**に重なるマップ範囲。
 * 地形のチャンクキャッシュ（`terrainCache.ts`）が「このチャンクに要るタイルだけ」を
 * 求めるのに使う。`visibleTileBounds` はこれをビューポート全体に適用したもの。
 */
export function tileBoundsForScreenRect(
  cam: Camera,
  mapW: number,
  mapH: number,
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
  pad = 2,
): TileBounds {
  const corners = [
    screenToTile(cam, rx0, ry0),
    screenToTile(cam, rx1, ry0),
    screenToTile(cam, rx0, ry1),
    screenToTile(cam, rx1, ry1),
  ];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of corners) {
    if (c.x < x0) x0 = c.x;
    if (c.y < y0) y0 = c.y;
    if (c.x > x1) x1 = c.x;
    if (c.y > y1) y1 = c.y;
  }
  return {
    x0: Math.max(0, Math.floor(x0) - pad),
    y0: Math.max(0, Math.floor(y0) - pad),
    x1: Math.min(mapW - 1, Math.ceil(x1) + pad),
    y1: Math.min(mapH - 1, Math.ceil(y1) + pad),
  };
}

/**
 * 描画順（Y ソート）の比較キー。
 * 手順書 §7.1「sy 昇順、同値は EntityId 昇順（ちらつき防止）」。
 */
export function drawOrderKey(x: number, y: number, entityId: number): number {
  // sy は (x + y) に比例するので、そのまま (x+y) で比較すれば十分。
  // 実数の同値比較を避けるため、1/1024 マス精度で整数化してから ID を足す。
  return Math.round((x + y) * 1024) * 0x100000 + (entityId & 0xfffff);
}

/** ズームを 1 段上げる / 下げる（範囲外は端で止まる）。 */
export function stepZoom(current: number, dir: -1 | 1): number {
  const idx = ZOOM_LEVELS.indexOf(current as (typeof ZOOM_LEVELS)[number]);
  const base = idx < 0 ? nearestZoomIndex(current) : idx;
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, base + dir));
  return ZOOM_LEVELS[next] as number;
}

function nearestZoomIndex(z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < ZOOM_LEVELS.length; i++) {
    const d = Math.abs((ZOOM_LEVELS[i] as number) - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** tick 間補間（手順書 §7.1）。alpha は 0..1。 */
export function lerp(prev: number, next: number, alpha: number): number {
  return prev + (next - prev) * alpha;
}
