/**
 * render/fogLayer.ts — 霧の描画（T-M5-05。`07§7` / 手順書 §7.2）
 *
 * 3 状態の塗り分け:
 *   未探索 → 真っ黒（地形も見えない）
 *   既知   → 地形の上に黒を薄く重ね、**覚えている建物の形だけ**を暗い影で描く
 *   可視   → 何も重ねない
 *
 * 「既知の建物」は形だけ。体力バーも所属戦域の点も描かない
 * （`07§7`「建物は嘘をつく」= 壊れていても古い形が残る）。
 */

import { buildingDef } from '@/sim/core/defs';
import type { MapState } from '@/sim/core/world';
import type { Ctx2D } from './ctx';
import { TILE_H, TILE_W, type Camera, tileToScreen, visibleTileBounds } from './iso';
import { FOG_KNOWN_ALPHA, FOG_UNEXPLORED } from './palette';
import { VisionState, type VisionBuffer } from './vision';

/**
 * 覚えている建物の形（既知エリア）。**地形の後、霧の前**に呼ぶ。
 * こうすると建物の影も霧で暗くなり、「以前見た情報」であることが見た目で分かる。
 */
export function drawRememberedBuildings(
  ctx: Ctx2D,
  cam: Camera,
  map: MapState,
  vision: VisionBuffer,
): number {
  if (vision.isRevealed()) return 0;
  const b = visibleTileBounds(cam, map.widthTiles, map.heightTiles, 1);
  const hw = (TILE_W * cam.zoom) / 2;
  const hh = (TILE_H * cam.zoom) / 2;
  let drawn = 0;
  let started = false;
  for (let ty = b.y0; ty <= b.y1; ty++) {
    for (let tx = b.x0; tx <= b.x1; tx++) {
      if (vision.stateAt(tx, ty) !== VisionState.Known) continue;
      const t = vision.rememberedBuilding(tx, ty);
      if (t < 0) continue;
      // typeId の妥当性だけ確認（データ差し替えで壊れないように）
      if (buildingDef(t).index !== t) continue;
      const p = tileToScreen(cam, tx + 0.5, ty + 0.5);
      // 外接矩形の外（画面に載らない菱形）は捨てる
      if (p.sx + hw < 0 || p.sx - hw > cam.viewW) continue;
      if (p.sy + hh * 1.6 < 0 || p.sy - hh * 1.6 > cam.viewH) continue;
      if (!started) {
        ctx.beginPath();
        started = true;
      }
      ctx.moveTo(p.sx, p.sy - hh * 1.6);
      ctx.lineTo(p.sx + hw * 0.8, p.sy - hh * 0.4);
      ctx.lineTo(p.sx, p.sy + hh * 0.4);
      ctx.lineTo(p.sx - hw * 0.8, p.sy - hh * 0.4);
      ctx.closePath();
      drawn++;
    }
  }
  if (started) {
    ctx.fillStyle = '#6b6455';
    ctx.fill();
  }
  return drawn;
}

/** 霧の描画実績。 */
export interface FogStats {
  unexplored: number;
  known: number;
}

/**
 * 霧を重ねる。**エンティティより前**に呼ぶ
 * （可視エリアのユニットは霧の影響を受けないため）。
 */
export function drawFog(
  ctx: Ctx2D,
  cam: Camera,
  map: MapState,
  vision: VisionBuffer,
): FogStats {
  const stats: FogStats = { unexplored: 0, known: 0 };
  if (vision.isRevealed()) return stats;

  const b = visibleTileBounds(cam, map.widthTiles, map.heightTiles, 1);
  const hw = (TILE_W * cam.zoom) / 2;
  const hh = (TILE_H * cam.zoom) / 2;

  // 状態ごとに 1 パスでまとめて塗る（タイルごとに fill しない）
  for (const pass of [VisionState.Unexplored, VisionState.Known] as const) {
    let started = false;
    for (let ty = b.y0; ty <= b.y1; ty++) {
      for (let tx = b.x0; tx <= b.x1; tx++) {
        if (vision.stateAt(tx, ty) !== pass) continue;
        const p = tileToScreen(cam, tx + 0.5, ty + 0.5);
        if (p.sx + hw < 0 || p.sx - hw > cam.viewW) continue;
        if (p.sy + hh < 0 || p.sy - hh > cam.viewH) continue;
        if (!started) {
          ctx.beginPath();
          started = true;
        }
        // 菱形どうしの継ぎ目に線が出ないよう、わずかに大きく塗る
        ctx.moveTo(p.sx, p.sy - hh - 0.5);
        ctx.lineTo(p.sx + hw + 0.5, p.sy);
        ctx.lineTo(p.sx, p.sy + hh + 0.5);
        ctx.lineTo(p.sx - hw - 0.5, p.sy);
        ctx.closePath();
        if (pass === VisionState.Unexplored) stats.unexplored++;
        else stats.known++;
      }
    }
    if (!started) continue;
    ctx.fillStyle = FOG_UNEXPLORED;
    ctx.globalAlpha = pass === VisionState.Unexplored ? 1 : FOG_KNOWN_ALPHA;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  return stats;
}
