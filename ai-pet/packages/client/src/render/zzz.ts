/**
 * 眠っているアクターの上に出す「zzz」（D-3 の残り）
 *
 * 睡眠ポーズ（丸まった絵）だけだと、遠目には「うずくまっている」のか「寝ている」のか
 * 区別が付きにくい。宣伝資料 `screen-ecosystem.png` の夜も、眠っている個体に小さな符号が付いている。
 *
 * 方針:
 * - **1枚の `Graphics` にまとめて描く**（`weather.ts` と同じ。眠っている個体は夜だと100体近くになる）
 * - **うるさくしない**のが最優先。1体につき1文字だけを、ゆっくり浮かせて消す。
 *   個体ごとに位相をずらすので、画面全体で見ると「ぽつぽつ」出る
 * - 文字の形は `Graphics` の線で描く（フォントに依存させない。端末差で崩れるのを避ける）
 * - `prefers-reduced-motion` では**浮かせない**（出したまま静止させる）
 */
import { Container, Graphics } from 'pixi.js';
import { TILE_PX } from '@ai-pet/shared';
import type { Layers } from './stage.ts';
import type { Camera } from './camera.ts';
import { interpolatedPos, type WorldState } from '../state/world.ts';

/** 1周期の長さ（秒）。この間に1回だけ浮かんで消える */
export const ZZZ_PERIOD_SEC = 3;
/** 浮かぶ高さ（px） */
const RISE_PX = 14;
/** 文字の大きさ（px） */
const GLYPH_PX = 7;
/** アクターの足元から何px上に出すか（頭のあたり） */
const HEAD_OFFSET_PX = 30;
/** 画面外判定のマージン（タイル） */
const CULL_MARGIN = 2;
/** 色は輪郭と同じ `--ink`。薄く出す */
const ZZZ_COLOR = 0x4a3b2a;
const ZZZ_MAX_ALPHA = 0.5;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 周期の中の位置（0..1）から、浮かぶ量と不透明度を出す。
 *
 * 前半で現れて後半で消える。**出ている時間は周期の6割だけ**にして、
 * 残りの4割は何も出さない（常時出ていると賑やかすぎる）。
 */
export function zzzPhase(t: number): { rise: number; alpha: number } {
  // `((t % 1) + 1) % 1` と書くと t=0.6 で 0.6000000000000001 になり、
  // 表示/非表示の境目が1コマぶんずれる。負のときだけ足す形にすれば誤差が出ない
  let p = t % 1;
  if (p < 0) p += 1;
  if (p > 0.6) return { rise: 0, alpha: 0 };
  const k = p / 0.6;
  // 出て消えるのを1つの山にする（サインの半周期）
  return { rise: RISE_PX * k, alpha: ZZZ_MAX_ALPHA * Math.sin(k * Math.PI) };
}

/** 個体ごとに位相をずらす（全部が同じ拍で光ると人工的に見える） */
export function zzzOffsetFor(id: number): number {
  // 決定論。`Math.random` は使わない方針に合わせる
  return ((id * 2654435761) % 1000) / 1000;
}

export class ZzzLayer {
  private readonly g: Graphics;
  private readonly camera: Camera;
  private t = 0;
  private reduced = prefersReducedMotion();
  private drawnCount = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(layers: Pick<Layers, 'light'>, camera: Camera) {
    this.g = new Graphics();
    this.g.eventMode = 'none';
    this.camera = camera;
    (layers.light as Container).addChild(this.g);
  }

  update(world: WorldState, nowMs: number, dtSec: number): void {
    this.t += dtSec;
    this.g.clear();
    this.drawnCount = 0;
    const rect = this.camera.visibleRect(CULL_MARGIN);

    for (const view of world.actors.values()) {
      if (view.anim !== 'sleep') continue;
      const pos = interpolatedPos(view, nowMs);
      if (pos.x < rect.x0 || pos.x > rect.x1 || pos.y < rect.y0 || pos.y > rect.y1) continue;

      const phase = this.reduced
        ? { rise: RISE_PX * 0.5, alpha: ZZZ_MAX_ALPHA * 0.7 }
        : zzzPhase(this.t / ZZZ_PERIOD_SEC + zzzOffsetFor(view.id));
      if (phase.alpha <= 0.01) continue;

      this.drawZ(pos.x * TILE_PX + 10, pos.y * TILE_PX - HEAD_OFFSET_PX - phase.rise, phase.alpha);
      this.drawnCount++;
    }
  }

  /** 「z」を線で描く（フォントに依存させない） */
  private drawZ(x: number, y: number, alpha: number): void {
    const s = GLYPH_PX;
    this.g
      .moveTo(x, y)
      .lineTo(x + s, y)
      .lineTo(x, y + s)
      .lineTo(x + s, y + s)
      .stroke({ width: 1.6, color: ZZZ_COLOR, alpha, cap: 'round', join: 'round' });
  }

  /** デバッグ表示用 */
  get drawn(): number {
    return this.drawnCount;
  }

  destroy(): void {
    this.g.destroy();
  }
}
