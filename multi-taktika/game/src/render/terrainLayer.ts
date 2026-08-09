/**
 * render/terrainLayer.ts — 地形のタイル塗り（手順書 §7.1 のレイヤ 1 枚目）
 *
 * ■ 経緯（**前の判断は実測で否定された**）
 *   以前ここには「オフスクリーンキャッシュではなく、同じ色のタイルを 1 本の Path2D に
 *   まとめて `fill()` 8 回にする方が速い」と書いてあった。実測は逆だった:
 *
 *     1440×900 / DPR 2 / ユニット 28 体 → 45fps、うち **地形 11.7ms**（予算は全部で 10ms）
 *
 *   3000 個の小さな菱形を 1 本のパスに積むと、ブラウザは
 *   「巨大な複合パスの塗り分け（nonzero winding）」を毎フレーム解く。
 *   `fill` の**回数**は減っても、走査線あたりの交差辺の数は減らない。
 *   よって手順書 §7.1 の指定どおり**オフスクリーンにキャッシュして、
 *   毎フレームは `drawImage` だけ**にする（`terrainCache.ts`）。
 *
 *   このファイルは「タイルを実際に塗る」部分だけを持つ。呼ばれるのは
 *     - キャッシュのチャンクを焼くとき（= カメラが新しい場所に入ったときだけ）
 *     - オフスクリーンが作れない環境での代替（Vitest の node など）
 *   の 2 つ。
 *
 * ■ 画面外のタイルを捨てる（この 1 か所だけでも効く）
 *   `visibleTileBounds` は菱形の外接矩形なので、**返る範囲の約半分は画面外**
 *   （1440×900 で 3025 マス返るが、実際に画面に載るのは約 1300 マス）。
 *   菱形ごとに矩形の重なりを見て捨てる。
 *
 * sim は読むだけ（手順書 §3.1）。
 */

import { TILE_COUNT, hasTerrain, tileIndex } from '@/sim/core/terrain';
import type { MapState } from '@/sim/core/world';
import type { Ctx2D } from './ctx';
import {
  TILE_H,
  TILE_W,
  type Camera,
  type TileBounds,
  tileToScreen,
  visibleTileBounds,
} from './iso';
import { TINT_ALPHA, terrainFill } from './terrainTextures';
import type { PatternSource, TerrainTextures } from './terrainTextures';

/** 1 フレームの地形描画の実績（性能テストとデバッグ表示用）。 */
export interface TerrainStats {
  /** 実際に塗ったタイル数（キャッシュが完全に効いていれば 0）。 */
  tiles: number;
  /** `fill()` の回数（= 使われた色の種類数）。 */
  fills: number;
  /** キャッシュを貼った回数（= `drawImage` の回数）。 */
  blits: number;
  /** このフレームで焼き直したチャンク数（0 = 完全にキャッシュヒット）。 */
  built: number;
}

/** 空の実績。 */
export function emptyTerrainStats(): TerrainStats {
  return { tiles: 0, fills: 0, blits: 0, built: 0 };
}

/**
 * 地形のタイルを塗る。
 *
 * @param bounds 塗る範囲。省略時は `visibleTileBounds`（余白 1）。
 * @returns 塗ったタイル数と fill 回数
 */
export function drawTerrainTiles(
  ctx: Ctx2D,
  cam: Camera,
  map: MapState,
  bounds?: TileBounds,
  /**
   * 地形の模様（M17）。省略 / null なら `TILE_COLORS` の単色で塗る。
   * 模様があるときは「模様 → 色を薄く重ねる」の 2 段になる（`terrainTextures.ts`）。
   */
  textures?: TerrainTextures | null,
): TerrainStats {
  const stats = emptyTerrainStats();
  if (!hasTerrain(map)) return stats;

  const b = bounds ?? visibleTileBounds(cam, map.widthTiles, map.heightTiles, 1);
  const hw = (TILE_W * cam.zoom) / 2;
  const hh = (TILE_H * cam.zoom) / 2;

  // タイル種別ごとに菱形を積んでから、種別単位で 1 回だけ塗る。
  // （焼くのは稀なので、ここは分かりやすさを優先して据え置き）
  for (let t = 0; t < TILE_COUNT; t++) {
    let started = false;
    for (let ty = b.y0; ty <= b.y1; ty++) {
      for (let tx = b.x0; tx <= b.x1; tx++) {
        if (map.tiles[tileIndex(map, tx, ty)] !== t) continue;
        // タイル (tx, ty) の中心 = マス中央（+0.5, +0.5）
        const p = tileToScreen(cam, tx + 0.5, ty + 0.5);
        // この描画面に載らない菱形は捨てる
        if (p.sx + hw < 0 || p.sx - hw > cam.viewW) continue;
        if (p.sy + hh < 0 || p.sy - hh > cam.viewH) continue;
        if (!started) {
          ctx.beginPath();
          started = true;
        }
        ctx.moveTo(p.sx, p.sy - hh);
        ctx.lineTo(p.sx + hw, p.sy);
        ctx.lineTo(p.sx, p.sy + hh);
        ctx.lineTo(p.sx - hw, p.sy);
        ctx.closePath();
        stats.tiles++;
      }
    }
    if (started) {
      // 積んだ菱形をまとめて塗る。模様があるときだけ色を薄く重ねる
      // （模様そのままだと明るすぎて上の兵と建物が読めない）。
      // パターンは塗る先の面で作る（`ctx` をそのまま渡す）。
      const fill = terrainFill(textures ?? null, ctx as unknown as PatternSource, t);
      ctx.fillStyle = fill.base;
      ctx.fill();
      stats.fills++;
      if (fill.tint !== null) {
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = prevAlpha * TINT_ALPHA;
        ctx.fillStyle = fill.tint;
        ctx.fill();
        ctx.globalAlpha = prevAlpha;
        stats.fills++;
      }
    }
  }
  return stats;
}

/**
 * マップの外周（盤外）を塗り潰す下敷き。
 * 地形より先に呼ぶ（`clearRect` の代わり）。
 */
export function clearField(ctx: Ctx2D, cam: Camera, color = '#0b0906'): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, cam.viewW, cam.viewH);
}

/**
 * タイル種別の並びの安価な指紋（FNV-1a 32bit）。
 *
 * 地形キャッシュの「焼き直しが要るか」の判定に使う。
 * **矩形範囲だけを見る**ので 1 チャンクあたり百数十バイトの走査で済む
 * （1 フレーム・全チャンクで 1 万バイト未満 ≒ 数 µs）。
 */
export function hashTileRect(map: MapState, b: TileBounds): number {
  let h = 0x811c9dc5;
  const w = map.widthTiles;
  const tiles = map.tiles;
  for (let ty = b.y0; ty <= b.y1; ty++) {
    const row = ty * w;
    for (let tx = b.x0; tx <= b.x1; tx++) {
      h ^= tiles[row + tx]!;
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}
