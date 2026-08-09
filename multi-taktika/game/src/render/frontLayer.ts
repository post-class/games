/**
 * render/frontLayer.ts — 戦域の輪（手順書 §7.3。`05§6-12` / `07§7`）
 *
 * ■ 自分の戦域
 *   スロット色（`palette.FRONT_COLORS`）の輪。
 *   **輪の太さ = 優勢度**、**点滅 = 崩れかけ**（`front.isFrontWarning`）。
 *   色覚に依存しないよう、輪の傍に**形 + 番号**を併記する（`06§12`）。
 *
 * ■ 敵の戦域（★ここを間違えると「囮」が成立しない。`07§7` / 手順書 §16-5）
 *   `visibleEnemyFronts` が返す **中心と半径だけ**を破線の輪で描く。
 *   中の兵・令・優勢度は**絶対に描かない**（そもそも API が返さない）。
 *   輪は視界の外でも描く（「自軍が交戦している場所は視界と無関係に分かる」）。
 */

import type { PlayerId } from '@/shared/types';
import { FX_ONE } from '@/sim/core/fx';
import { isFrontWarning, ownFronts, visibleEnemyFronts } from '@/sim/core/front';
import type { World } from '@/sim/core/world';
import type { Ctx2D } from './ctx';
import { TILE_H, TILE_W, type Camera, tileToScreen } from './iso';
import { frontColor, frontShape, playerColor } from './palette';

/** 点滅の周期（ms）。崩れかけの戦域を点滅させる。 */
const BLINK_PERIOD_MS = 700;

/** 描画実績（テスト用）。 */
export interface FrontLayerStats {
  /** 自分の戦域の輪の数。 */
  own: number;
  /** 敵の戦域の輪の数。 */
  enemy: number;
}

/**
 * 戦域の輪を描く。エンティティより後（最前面近く）に呼ぶ。
 *
 * @param nowMs 点滅用の時刻（`performance.now()`）。決定論の対象外。
 */
export function drawFronts(
  ctx: Ctx2D,
  cam: Camera,
  w: World,
  viewer: PlayerId,
  nowMs: number,
): FrontLayerStats {
  const stats: FrontLayerStats = { own: 0, enemy: 0 };
  const blinkOn = Math.floor(nowMs / BLINK_PERIOD_MS) % 2 === 0;

  // ---- 自分の戦域 --------------------------------------------------------
  for (const f of ownFronts(w, viewer)) {
    const warn = isFrontWarning(f);
    if (warn && !blinkOn) continue; // 点滅 = 崩れかけ
    const cx = f.x / FX_ONE;
    const cy = f.y / FX_ONE;
    const rTiles = f.radius / FX_ONE;
    // 優勢度（-1..1）→ 輪の太さ 1.5..6px
    const adv = f.advantage / FX_ONE;
    ctx.lineWidth = Math.max(1.5, 3.5 + adv * 2.5) * Math.max(0.6, cam.zoom);
    ctx.strokeStyle = frontColor(f.slot);
    ctx.setLineDash([]);
    strokeIsoCircle(ctx, cam, cx, cy, rTiles);
    // 形 + 番号（色覚に依存しない併記）
    const p = tileToScreen(cam, cx, cy - rTiles);
    ctx.fillStyle = frontColor(f.slot);
    ctx.font = `${Math.round(14 * Math.max(0.8, cam.zoom))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${frontShape(f.slot)}${f.slot}`, p.sx, p.sy);
    stats.own++;
  }

  // ---- 敵の戦域（中心と半径だけ） ----------------------------------------
  for (const ring of visibleEnemyFronts(w, viewer)) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = playerColor(ring.owner);
    ctx.setLineDash([6, 6]);
    strokeIsoCircle(ctx, cam, ring.x / FX_ONE, ring.y / FX_ONE, ring.radius / FX_ONE);
    ctx.setLineDash([]);
    stats.enemy++;
  }
  return stats;
}

/**
 * マップ上の円を擬似アイソメの楕円として描く。
 * `ellipse` を使わず折れ線で描いているのは、`Ctx2D` の面を小さく保つため
 * （テストの偽 ctx が実装しなければならないメソッドを増やさない）。
 */
function strokeIsoCircle(
  ctx: Ctx2D,
  cam: Camera,
  cx: number,
  cy: number,
  rTiles: number,
): void {
  const c = tileToScreen(cam, cx, cy);
  const rx = rTiles * TILE_W * cam.zoom * 0.707;
  const ry = rTiles * TILE_H * cam.zoom * 0.707;
  const steps = 32;
  ctx.beginPath();
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * Math.PI * 2;
    const x = c.sx + Math.cos(a) * rx;
    const y = c.sy + Math.sin(a) * ry;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
