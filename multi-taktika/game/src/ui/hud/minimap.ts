/**
 * ui/hud/minimap.ts — ミニマップ（`05§6-3` / `06§7`。T-M5-06）
 *
 * 「自軍が明るい点、敵が赤、**戦域は色付きの輪**で出ます。クリックで視点移動」
 *
 * - 地形は `ImageData` に 1 回書いて `putImageData` する（毎フレーム数万回の
 *   `fillRect` を避けるため）。更新は数 Hz でよい。
 * - 霧は地形と同じ ImageData の中で暗くする（未探索は真っ黒）。
 * - 戦域は自分のスロット色の輪、敵は破線相当の点（**中心と半径だけ**。`07§7`）。
 *
 * ここは DOM 前提（`CanvasRenderingContext2D` を直接使う）。
 * 判定ロジックは持たないので単体テストは持たず、目視確認（`V`）で担保する。
 */

import { EntityKind, NEUTRAL_OWNER, type PlayerId } from '@/shared/types';
import { FX_ONE } from '@/sim/core/fx';
import { ownFronts, visibleEnemyFronts } from '@/sim/core/front';
import { hasTerrain, tileIndex } from '@/sim/core/terrain';
import type { World } from '@/sim/core/world';
import { areAllies } from '@/sim/core/world';
import { FRONT_COLORS, TILE_COLORS, playerColor } from '@/render/palette';
import { VisionState, type VisionBuffer } from '@/render/vision';
import type { Camera } from '@/render/iso';

/** ミニマップの一辺（CSS px）。 */
export const MINIMAP_SIZE = 180;

/** '#rrggbb' → [r, g, b]。 */
function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const TILE_RGB: readonly [number, number, number][] = TILE_COLORS.map(hexToRgb);

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private image: ImageData | null = null;

  constructor(size = MINIMAP_SIZE) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.canvas.className = 'mt-minimap';
    const c = this.canvas.getContext('2d');
    if (c === null) throw new Error('Minimap: 2d コンテキストが取れない');
    this.ctx = c;
  }

  /** 画面座標（canvas 内 px）→ マップのマス座標。クリックのジャンプに使う。 */
  toTile(px: number, py: number, w: World): { x: number; y: number } {
    const s = this.canvas.width;
    return {
      x: (px / s) * w.map.widthTiles,
      y: (py / s) * w.map.heightTiles,
    };
  }

  /** 地形 + 霧を描き直す（数 Hz で呼ぶ）。 */
  redrawTerrain(w: World, vision: VisionBuffer): void {
    const map = w.map;
    if (!hasTerrain(map)) return;
    const s = this.canvas.width;
    if (this.image === null || this.image.width !== s) {
      this.image = this.ctx.createImageData(s, s);
    }
    const img = this.image;
    const data = img.data;
    for (let py = 0; py < s; py++) {
      const ty = Math.min(map.heightTiles - 1, Math.floor((py / s) * map.heightTiles));
      for (let px = 0; px < s; px++) {
        const tx = Math.min(map.widthTiles - 1, Math.floor((px / s) * map.widthTiles));
        const o = (py * s + px) * 4;
        const st = vision.stateAt(tx, ty);
        if (st === VisionState.Unexplored) {
          data[o] = 6;
          data[o + 1] = 5;
          data[o + 2] = 4;
          data[o + 3] = 255;
          continue;
        }
        const tile = map.tiles[tileIndex(map, tx, ty)]!;
        const rgb = TILE_RGB[tile] ?? TILE_RGB[0]!;
        const dim = st === VisionState.Known ? 0.45 : 1;
        data[o] = Math.round(rgb[0] * dim);
        data[o + 1] = Math.round(rgb[1] * dim);
        data[o + 2] = Math.round(rgb[2] * dim);
        data[o + 3] = 255;
      }
    }
    this.ctx.putImageData(img, 0, 0);
  }

  /**
   * 点と輪を上書きする（毎フレーム呼んでよい軽さ）。
   * `redrawTerrain` の直後に呼ぶこと（putImageData が上書きするため）。
   */
  drawOverlay(w: World, viewer: PlayerId, vision: VisionBuffer, cam: Camera): void {
    const ctx = this.ctx;
    const s = this.canvas.width;
    const sx = s / w.map.widthTiles;
    const sy = s / w.map.heightTiles;
    const e = w.entities;

    // ---- エンティティの点 ----
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1) continue;
      const kind = e.kind[i]!;
      if (kind !== EntityKind.Unit && kind !== EntityKind.Building) continue;
      const owner = e.owner[i]!;
      if (owner === NEUTRAL_OWNER) continue;
      const tx = e.x[i]! / FX_ONE;
      const ty = e.y[i]! / FX_ONE;
      const mine = owner === viewer || areAllies(w, owner, viewer);
      if (!mine && !vision.isVisible(Math.floor(tx), Math.floor(ty))) continue;
      // 自軍は明るい点、敵は赤（`05§6-3`）
      ctx.fillStyle = mine ? '#ffffff' : '#ff4a3d';
      const size = kind === EntityKind.Building ? 3 : 2;
      ctx.fillRect(tx * sx - size / 2, ty * sy - size / 2, size, size);
      if (kind === EntityKind.Building && mine) {
        ctx.fillStyle = playerColor(owner);
        ctx.fillRect(tx * sx - 1, ty * sy - 1, 2, 2);
      }
    }

    // ---- 戦域の輪（自分: スロット色 / 敵: 中心と半径だけ） ----
    for (const f of ownFronts(w, viewer)) {
      ctx.strokeStyle = FRONT_COLORS[f.slot - 1] ?? '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(
        (f.x / FX_ONE) * sx,
        (f.y / FX_ONE) * sy,
        Math.max(3, (f.radius / FX_ONE) * sx),
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    for (const ring of visibleEnemyFronts(w, viewer)) {
      ctx.strokeStyle = playerColor(ring.owner);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(
        (ring.x / FX_ONE) * sx,
        (ring.y / FX_ONE) * sy,
        Math.max(3, (ring.radius / FX_ONE) * sx),
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- 今見ている範囲の枠 ----
    const halfW = (cam.viewW / (64 * cam.zoom)) * 1;
    const halfH = (cam.viewH / (32 * cam.zoom)) * 1;
    ctx.strokeStyle = 'rgba(224,179,74,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      (cam.cx - halfW / 2) * sx,
      (cam.cy - halfH / 2) * sy,
      halfW * sx,
      halfH * sy,
    );
  }
}
