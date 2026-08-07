/**
 * 接地影（D-1 / docs/03_宣伝用との乖離是正プラン/04_スタイルガイド.md §5）
 *
 * 宣伝資料のキャラは全員、足元に楕円の影がある。実装には影が1つも無く、
 * キャラもオブジェクトも地面から浮いて見えていた。
 *
 * 方針:
 * - **スプライトに焼き込まない。** `stage.ts` の `shadow` レイヤ（`entities` の下）に
 *   1枚の `Graphics` へ全員ぶんをまとめて描く。`weather.ts` の「260本の線を1枚にまとめる」と同じ考え方で、
 *   影が何百個あっても描画コールは1回になる
 * - 影は**地面に残す**ので、歩行中の上下バウンドには追従させない（`sprites.ts` の bob を足さない）
 * - 睡眠中は平たく潰す（丸まって寝ている表現に合わせる）
 * - アセットに影を焼き込ませない方針とセット（焼き込むと二重になる）
 */
import { Graphics, type Container } from 'pixi.js';
import { CHAR_PX, TILE_PX } from '@ai-pet/shared';
import type { Layers } from './stage.ts';
import type { Camera } from './camera.ts';
import { interpolatedPos, type WorldState } from '../state/world.ts';
import { ANCHOR_Y, SPECIES_SCALE } from './sprites.ts';
import { OBJECT_SCALE } from './objects.ts';

/** 影の色（`--ink` #4a3b2a）と濃さ。スタイルガイド §5 の値 */
export const SHADOW_COLOR = 0x4a3b2a;
export const SHADOW_ALPHA = 0.18;
/** 影の幅 = 対象の幅 × これ */
export const SHADOW_WIDTH_RATIO = 0.6;
/** 影の高さ = 影の幅 × これ */
export const SHADOW_ASPECT = 0.38;
/** 睡眠中は平たくする（丸まっているので接地面が広く、薄く見える） */
export const SHADOW_SLEEP_FLATTEN = 0.6;
/** 画面外判定のマージン（タイル） */
const CULL_MARGIN = 2;

/** 1つぶんの影。テストしやすいように描画と分けている */
export interface ShadowEllipse {
  /** 画面ではなくワールドのピクセル座標（worldRoot の中に置くので） */
  x: number;
  y: number;
  /** 楕円の半径（x/y） */
  rx: number;
  ry: number;
}

/**
 * 対象の表示幅（px）から楕円の半径を出す。
 * `flatten` は睡眠などで縦を潰す係数（1でそのまま）。
 */
export function ellipseFor(x: number, y: number, widthPx: number, flatten: number): ShadowEllipse {
  const rx = (widthPx * SHADOW_WIDTH_RATIO) / 2;
  return { x, y, rx, ry: rx * SHADOW_ASPECT * flatten };
}

export class ShadowLayer {
  private readonly g: Graphics;
  private readonly camera: Camera;
  private drawnCount = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(layers: Pick<Layers, 'shadow'>, camera: Camera) {
    this.g = new Graphics();
    this.g.eventMode = 'none';
    this.camera = camera;
    (layers.shadow as Container).addChild(this.g);
  }

  /**
   * 毎フレーム描き直す。
   *
   * `selfPos` は自アバターのクライアント予測位置（`ActorLayer.selfPos`）。
   * 渡さないとサーバ値（150ms遅れ）の位置に影が出て、自分の足元だけ影がずれる。
   */
  update(world: WorldState, nowMs: number, selfPos: { x: number; y: number } | null): void {
    const rect = this.camera.visibleRect(CULL_MARGIN);
    this.g.clear();
    this.drawnCount = 0;

    // 資源・設置物（木・ベンチ・花壇・灯り…）
    for (const r of world.resources.values()) {
      // 水場と釣り場は地形で表現しているので絵が無い（objects.ts と同じ判断）
      if (r.type === 'water' || r.type === 'fishing_spot') continue;
      this.add(r.x, r.y + 0.5, TILE_PX * (OBJECT_SCALE[r.type] ?? 1), 1, rect);
    }
    for (const p of world.placeables.values()) {
      this.add(p.x, p.y + 0.5, TILE_PX * (OBJECT_SCALE[p.type] ?? 1), 1, rect);
    }

    // アクター（プレイヤー・ペット・動物）
    for (const view of world.actors.values()) {
      const isSelf = world.selfId !== null && view.id === world.selfId;
      const pos = isSelf && selfPos ? selfPos : interpolatedPos(view, nowMs);
      const scale = SPECIES_SCALE[view.species ?? ''] ?? 1;
      const flatten = view.anim === 'sleep' ? SHADOW_SLEEP_FLATTEN : 1;
      // アンカーが足元（ANCHOR_Y）なので、影の中心はアクターの座標そのもの
      this.add(pos.x, pos.y, CHAR_PX * scale, flatten, rect);
    }

    if (this.drawnCount > 0) {
      this.g.fill({ color: SHADOW_COLOR, alpha: SHADOW_ALPHA });
    }
  }

  /** タイル座標で受け取り、画面内なら楕円を1つ積む */
  private add(
    tx: number,
    ty: number,
    widthPx: number,
    flatten: number,
    rect: { x0: number; y0: number; x1: number; y1: number },
  ): void {
    if (tx < rect.x0 || tx > rect.x1 || ty < rect.y0 || ty > rect.y1) return;
    const e = ellipseFor(tx * TILE_PX, ty * TILE_PX, widthPx, flatten);
    this.g.ellipse(e.x, e.y, e.rx, e.ry);
    this.drawnCount++;
  }

  /** デバッグ表示用 */
  get drawn(): number {
    return this.drawnCount;
  }

  destroy(): void {
    this.g.destroy();
  }
}
