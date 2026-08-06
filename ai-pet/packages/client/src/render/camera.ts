/**
 * カメラ（docs/02_ゲーム実装プラン/06_クライアント設計.md §3）
 *
 * - 自キャラ追従。画面中央1/6のデッドゾーン内は動かさない
 * - ズーム3段（0.75 / 1.0 / 1.5）。ホイールとピンチから操作する
 * - 島の端でクランプ。島全体が画面より小さいときは中央寄せ
 * - worldToScreen / screenToWorld を提供（入力処理が使う）
 *
 * Pixi に依存しない（テストしやすくするため）。
 * 描画側は `containerX / containerY / zoom` を worldRoot に流し込むだけ。
 *
 * 座標系:
 *   world = タイル単位（小数）
 *   px    = world * TILE_PX
 *   screen = (worldPx - camCenterPx) * zoom + 画面中心
 */
import { MAP_H, MAP_W, TILE_PX, type Vec2 } from '@ai-pet/shared';

export const ZOOM_STEPS: readonly number[] = [0.75, 1.0, 1.5];
export const DEFAULT_ZOOM_INDEX = 1;

/** デッドゾーンは画面の 1/6 の矩形（中央） */
const DEADZONE_RATIO = 1 / 6;

export interface CameraOptions {
  mapW?: number;
  mapH?: number;
  tilePx?: number;
  viewW?: number;
  viewH?: number;
}

export class Camera {
  /** カメラ中心（world = タイル単位） */
  x: number;
  y: number;
  zoomIndex: number;
  zoom: number;

  viewW: number;
  viewH: number;

  readonly mapW: number;
  readonly mapH: number;
  readonly tilePx: number;

  constructor(opts: CameraOptions = {}) {
    this.mapW = opts.mapW ?? MAP_W;
    this.mapH = opts.mapH ?? MAP_H;
    this.tilePx = opts.tilePx ?? TILE_PX;
    this.viewW = opts.viewW ?? 960;
    this.viewH = opts.viewH ?? 540;
    this.x = this.mapW / 2;
    this.y = this.mapH / 2;
    this.zoomIndex = DEFAULT_ZOOM_INDEX;
    this.zoom = ZOOM_STEPS[DEFAULT_ZOOM_INDEX] as number;
  }

  resize(w: number, h: number): void {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    this.clamp();
  }

  // ---------- ズーム ----------

  setZoomIndex(i: number): void {
    const idx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, Math.round(i)));
    this.zoomIndex = idx;
    this.zoom = ZOOM_STEPS[idx] as number;
    this.clamp();
  }

  /** ホイール1ノッチ / ピンチの段階移動。dir > 0 で寄る */
  stepZoom(dir: number): void {
    if (dir === 0) return;
    this.setZoomIndex(this.zoomIndex + (dir > 0 ? 1 : -1));
  }

  // ---------- 追従 ----------

  /** 追従なしで即座に合わせる（スポーン時・再同期時） */
  snapTo(target: Vec2): void {
    this.x = target.x;
    this.y = target.y;
    this.clamp();
  }

  /**
   * デッドゾーン追従。
   * 対象が画面中央1/6の矩形の中にいる間はカメラを動かさず、
   * 外に出たぶんだけカメラを寄せる（＝対象は常にデッドゾーンの縁に留まる）。
   */
  follow(target: Vec2): void {
    // 画面px上の対象位置とデッドゾーン矩形（中心基準の半幅）
    const halfDeadW = (this.viewW * DEADZONE_RATIO) / 2;
    const halfDeadH = (this.viewH * DEADZONE_RATIO) / 2;
    const s = this.worldToScreen(target);
    const cxs = this.viewW / 2;
    const cys = this.viewH / 2;
    const dx = s.x - cxs;
    const dy = s.y - cys;

    let overX = 0;
    let overY = 0;
    if (dx > halfDeadW) overX = dx - halfDeadW;
    else if (dx < -halfDeadW) overX = dx + halfDeadW;
    if (dy > halfDeadH) overY = dy - halfDeadH;
    else if (dy < -halfDeadH) overY = dy + halfDeadH;

    if (overX !== 0) this.x += overX / (this.zoom * this.tilePx);
    if (overY !== 0) this.y += overY / (this.zoom * this.tilePx);
    this.clamp();
  }

  // ---------- クランプ ----------

  /** 島の端でクランプ。島全体が画面に収まるときは中央寄せ */
  clamp(): void {
    const mapPxW = this.mapW * this.tilePx;
    const mapPxH = this.mapH * this.tilePx;
    /** 画面が覆うワールドpx */
    const visW = this.viewW / this.zoom;
    const visH = this.viewH / this.zoom;

    if (visW >= mapPxW) this.x = this.mapW / 2;
    else {
      const min = visW / 2 / this.tilePx;
      const max = (mapPxW - visW / 2) / this.tilePx;
      this.x = Math.max(min, Math.min(max, this.x));
    }

    if (visH >= mapPxH) this.y = this.mapH / 2;
    else {
      const min = visH / 2 / this.tilePx;
      const max = (mapPxH - visH / 2) / this.tilePx;
      this.y = Math.max(min, Math.min(max, this.y));
    }
  }

  // ---------- 変換 ----------

  worldToScreen(w: Vec2): Vec2 {
    return {
      x: (w.x * this.tilePx - this.x * this.tilePx) * this.zoom + this.viewW / 2,
      y: (w.y * this.tilePx - this.y * this.tilePx) * this.zoom + this.viewH / 2,
    };
  }

  screenToWorld(s: Vec2): Vec2 {
    return {
      x: (s.x - this.viewW / 2) / this.zoom / this.tilePx + this.x,
      y: (s.y - this.viewH / 2) / this.zoom / this.tilePx + this.y,
    };
  }

  /** worldRoot.position.x に入れる値 */
  get containerX(): number {
    return this.viewW / 2 - this.x * this.tilePx * this.zoom;
  }

  get containerY(): number {
    return this.viewH / 2 - this.y * this.tilePx * this.zoom;
  }

  /** 画面が覆うワールド矩形（タイル単位）。cullingとchunkReqに使う */
  visibleRect(marginTiles = 0): { x0: number; y0: number; x1: number; y1: number } {
    const halfW = this.viewW / 2 / this.zoom / this.tilePx;
    const halfH = this.viewH / 2 / this.zoom / this.tilePx;
    return {
      x0: this.x - halfW - marginTiles,
      y0: this.y - halfH - marginTiles,
      x1: this.x + halfW + marginTiles,
      y1: this.y + halfH + marginTiles,
    };
  }
}
