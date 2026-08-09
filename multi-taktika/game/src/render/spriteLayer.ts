/**
 * render/spriteLayer.ts — 建物・ユニット・資源の描画と Y ソート（T-M5-02）
 *
 * 手順書 §7.1:
 *  - **Y ソートは `sy` 昇順、同値は `EntityId` 昇順**（ちらつき防止）。
 *    比較キーは `iso.drawOrderKey`（`(x+y)` を 1/1024 マス精度で整数化 → 下位に index）。
 *  - 予算は「1 フレーム 16.6ms のうち描画 10ms 以内 / 400 体」。
 *    そのため 1 体あたりの処理は
 *      ① 補間座標を引く ② 画面外を捨てる ③ `SpriteProvider` に 1 回投げる
 *    だけにし、`sort` は index の配列に対して 1 回だけ行う（毎フレームの再確保もしない）。
 *
 * 視界（T-M5-05）: 自軍・味方は常に描く。**敵と中立は「可視」のマスに居るときだけ描く**。
 * 既知（暗がり）に残る建物の形は `fogLayer` が別に描く（`07§7`「建物は嘘をつく」）。
 *
 * sim は読むだけ（手順書 §3.1）。状態を書き換えない。
 */

import { EntityKind, NEUTRAL_OWNER, type PlayerId } from '@/shared/types';
import { buildingDef, unitDef } from '@/sim/core/defs';
import type { Entities } from '@/sim/core/entity';
import { PROGRESS_DONE, idOfIndex } from '@/sim/core/entity';
import { resourceNodeDef } from '@/sim/core/gather';
import type { World } from '@/sim/core/world';
import { areAllies } from '@/sim/core/world';
import type { Ctx2D } from './ctx';
import type { MotionBuffer } from './interp';
import { TILE_H, TILE_W, type Camera, drawOrderKey, tileToScreen } from './iso';
import {
  GOLD,
  frontColor,
  healthColor,
  playerColor,
  resourceColor,
  resourceGlyph,
} from './palette';
import type { SpriteProvider } from './placeholder';
import { roleGlyph } from './placeholder';

/** 霧の問い合わせ（`vision.VisionBuffer` が構造的に適合する）。 */
export interface VisibilityQuery {
  /** そのマスが今「可視」か。 */
  isVisible(tx: number, ty: number): boolean;
}

/** 1 フレームの描画入力。 */
export interface SpriteLayerInput {
  readonly world: World;
  readonly cam: Camera;
  /** 見ているプレイヤー（視界の基準）。 */
  readonly viewer: PlayerId;
  /** tick 間補間の係数 0..1。 */
  readonly alpha: number;
  readonly motion: MotionBuffer;
  readonly sprites: SpriteProvider;
  /** null = 霧なし（観戦・テスト）。 */
  readonly vision: VisibilityQuery | null;
  /** 選択中の EntityId（選択円を描く）。 */
  readonly selected: ReadonlySet<number> | null;
}

/** 描画実績（性能テストとデバッグ表示用）。 */
export interface SpriteStats {
  /** Y ソートに載せた数。 */
  sorted: number;
  /** 実際に描いた数。 */
  drawn: number;
  /** 画面外・不可視で捨てた数。 */
  culled: number;
}

/** 画面外判定の余白（px）。 */
const CULL_MARGIN = 96;

/**
 * Y ソート描画。バッファを持ち回すのでフレームごとに new しないこと。
 */
export class SpriteLayer {
  /** ソート対象の entity index。 */
  private order: Int32Array;
  /** index → 比較キー。 */
  private keys: Float64Array;
  /** index → 補間済み座標（マス単位）。 */
  private px: Float64Array;
  private py: Float64Array;
  /** ソート用の作業配列（`Array.prototype.sort` を使うため number[] を再利用）。 */
  private work: number[] = [];

  constructor(capacity: number) {
    this.order = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.px = new Float64Array(capacity);
    this.py = new Float64Array(capacity);
  }

  private ensure(capacity: number): void {
    if (this.order.length >= capacity) return;
    this.order = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.px = new Float64Array(capacity);
    this.py = new Float64Array(capacity);
  }

  draw(ctx: Ctx2D, inp: SpriteLayerInput): SpriteStats {
    const { world: w, cam, viewer, alpha, motion, sprites, vision } = inp;
    const e = w.entities;
    this.ensure(e.highWater + 1);
    const stats: SpriteStats = { sorted: 0, drawn: 0, culled: 0 };

    // ---- ① 候補を集めて比較キーを作る -------------------------------------
    let n = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1) continue;
      const kind = e.kind[i]!;
      if (kind === EntityKind.None) continue;

      const x = motion.sampleX(e, i, alpha);
      const y = motion.sampleY(e, i, alpha);

      // 視界: 自軍・味方は常に見える。敵・中立は「可視」のマスだけ（`07§7`）。
      const owner = e.owner[i]!;
      const own = owner !== NEUTRAL_OWNER && (owner === viewer || areAllies(w, owner, viewer));
      if (!own && vision !== null && !vision.isVisible(Math.floor(x), Math.floor(y))) {
        stats.culled++;
        continue;
      }

      // 画面外を捨てる
      const p = tileToScreen(cam, x, y);
      if (
        p.sx < -CULL_MARGIN ||
        p.sy < -CULL_MARGIN ||
        p.sx > cam.viewW + CULL_MARGIN ||
        p.sy > cam.viewH + CULL_MARGIN
      ) {
        stats.culled++;
        continue;
      }

      this.px[i] = x;
      this.py[i] = y;
      this.keys[i] = drawOrderKey(x, y, i);
      this.order[n] = i;
      n++;
    }
    stats.sorted = n;

    // ---- ② Y ソート（sy 昇順 → index 昇順） -------------------------------
    const work = this.work;
    work.length = n;
    for (let k = 0; k < n; k++) work[k] = this.order[k]!;
    const keys = this.keys;
    work.sort((a, b) => keys[a]! - keys[b]!);

    // ---- ③ 手前から奥へ順に描く -------------------------------------------
    const zoom = cam.zoom;
    const unitR = TILE_W * zoom * 0.15;
    for (let k = 0; k < n; k++) {
      const i = work[k]!;
      const p = tileToScreen(cam, this.px[i]!, this.py[i]!);
      const kind = e.kind[i]!;
      const owner = e.owner[i]!;
      const color = playerColor(owner);

      if (kind === EntityKind.Unit) {
        const def = unitDef(e.typeId[i]!);
        sprites.drawUnit(ctx, p.sx, p.sy, {
          typeId: e.typeId[i]!,
          owner,
          color,
          radiusPx: unitR,
          glyph: roleGlyph(def.role),
          dir: directionOf(e.vx[i]!, e.vy[i]!),
          frame: 0,
        });
        this.drawFootRing(ctx, p.sx, p.sy, unitR, e.frontId[i]!, e.manual[i]! === 1);
        this.drawHealth(ctx, p.sx, p.sy - unitR * 2.4, unitR * 2.2, i, e, zoom);
      } else if (kind === EntityKind.Building || kind === EntityKind.Attachment) {
        const def = buildingDef(e.typeId[i]!);
        const wPx = ((def.sizeW + def.sizeH) * (TILE_W * zoom)) / 2 / 2 + 4 * zoom;
        const hPx = wPx * 0.9;
        const ratio = e.buildProgress[i]! >= PROGRESS_DONE ? 1 : buildRatio(e.buildProgress[i]!);
        sprites.drawBuilding(ctx, p.sx, p.sy, {
          typeId: e.typeId[i]!,
          owner,
          color,
          wPx,
          hPx,
          glyph: def.name.slice(0, 1),
          buildRatio: ratio,
        });
        this.drawHealth(ctx, p.sx, p.sy - hPx - 6 * zoom, wPx * 0.9, i, e, zoom);
      } else if (kind === EntityKind.Resource) {
        const node = resourceNodeDef(e.typeId[i]!);
        sprites.drawResource(ctx, p.sx, p.sy, {
          typeId: e.typeId[i]!,
          color: resourceColor(node.resource),
          radiusPx: TILE_W * zoom * 0.18,
          glyph: resourceGlyph(node.resource),
        });
      } else if (kind === EntityKind.Projectile) {
        ctx.fillStyle = '#f0e0b0';
        ctx.beginPath();
        ctx.arc(p.sx, p.sy - TILE_H * zoom * 0.5, Math.max(1, 2 * zoom), 0, Math.PI * 2);
        ctx.fill();
      }

      // 選択円（`05§12-4`。選択した瞬間に手動になるのは Command 側の責務）
      if (inp.selected !== null && inp.selected.size > 0) {
        if (inp.selected.has(idOfIndex(e, i))) {
          ctx.strokeStyle = GOLD;
          ctx.lineWidth = Math.max(1, 1.5 * zoom);
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, Math.max(4, unitR * 1.6), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      stats.drawn++;
    }
    return stats;
  }

  /** 足元の輪。戦域に属していればその戦域色、手動なら白（`06§5`）。 */
  private drawFootRing(
    ctx: Ctx2D,
    sx: number,
    sy: number,
    r: number,
    frontId: number,
    manual: boolean,
  ): void {
    if (!manual && frontId === 0) return;
    ctx.strokeStyle = manual ? '#ffffff' : frontColor(frontId);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 1.2, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * 体力バー（`05§12-3`）。
   * **左端の小さな点が所属戦域の色**で、令で動いている兵かどうかが分かる。
   */
  private drawHealth(
    ctx: Ctx2D,
    sx: number,
    sy: number,
    wPx: number,
    i: number,
    e: Entities,
    zoom: number,
  ): void {
    const hp = e.hp[i]!;
    const max = e.hpMax[i]!;
    if (max <= 0) return;
    const ratio = hp / max;
    if (ratio >= 1 && e.frontId[i] === 0) return; // 満タンで戦域外なら描かない（情報量を絞る）
    if (zoom < 0.75 && ratio >= 1) return;
    const h = Math.max(2, 3 * zoom);
    const x = sx - wPx / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, sy, wPx, h);
    ctx.fillStyle = healthColor(ratio);
    ctx.fillRect(x, sy, wPx * Math.max(0, Math.min(1, ratio)), h);
    if (e.frontId[i] !== 0) {
      ctx.fillStyle = frontColor(e.frontId[i]!);
      ctx.fillRect(x - h, sy, h, h);
    }
  }
}

/** 速度から向き 8 方向（0 = 東、時計回り）。アトラス差し替え時の列番号になる。 */
export function directionOf(vx: number, vy: number): number {
  if (vx === 0 && vy === 0) return 0;
  const a = Math.atan2(vy, vx); // -π..π
  const d = Math.round((a / (Math.PI * 2)) * 8);
  return ((d % 8) + 8) % 8;
}

/** 建設進捗（積み上げた仕事量）を 0..1 に丸める。完成の判定は `PROGRESS_DONE`。 */
function buildRatio(progress: number): number {
  if (progress <= 0) return 0;
  // 実際の必要量は建物ごとに違う（`construction` が持つ）。
  // 見た目のためだけなので、ここでは「30 秒ぶん = 750 tick × FX_ONE」を上限とみなす。
  const nominal = 750 * 256;
  const r = progress / nominal;
  return r > 1 ? 1 : r;
}
