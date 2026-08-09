/**
 * input/camera.ts — 視点操作（T-M5-04。`06§7`）
 *
 * `06§7` の全操作:
 *  | 矢印キー / 画面端 / 中ドラッグ | スクロール（画面端は無効化可）          |
 *  | ホイール                      | ズーム 4 段階                            |
 *  | ミニマップ左クリック          | その地点へジャンプ                        |
 *  | H                             | 町の中心へ。**2 回押すと次の町の中心へ** |
 *  | F1〜F4                        | 記憶した視点の呼び出し（`Ctrl`+ で記憶） |
 *  | Backspace                     | 直前の視点へ。**連続で押すと履歴を遡る** |
 *
 * ■ 層の責務（手順書 §9.1）
 *   カメラは**端末ローカル状態**。`Command` にしない（リプレイ容量とデシンクの元）。
 *   sim は読むだけ（`H` で町の中心を探すときだけ World を走査する）。
 *   DOM イベントの購読はここではなく `input/bindings.ts` が行う（テスト可能にするため）。
 */

import { EntityKind, type PlayerId } from '@/shared/types';
import { buildingDef } from '@/sim/core/defs';
import { FX_ONE } from '@/sim/core/fx';
import type { World } from '@/sim/core/world';
import { ZOOM_LEVELS, type Camera, stepZoom, worldToTile } from '@/render/iso';

/** 画面端スクロールの反応する幅（px）。 */
export const EDGE_MARGIN_PX = 16;

/** スクロール速度（画面上の px / 秒）。設定で変更可（`06§7`）。 */
export const DEFAULT_SCROLL_PX_PER_SEC = 900;

/** 記憶できる視点の数（`F1`〜`F4`）。 */
export const CAMERA_SLOTS = 4;

/** 視点履歴の上限（`Backspace` で遡れる回数）。 */
export const CAMERA_HISTORY_LIMIT = 32;

/** 押されている方向キー。 */
export interface ScrollKeys {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

/** マウス位置（画面端スクロールの判定用）。 */
export interface PointerPos {
  x: number;
  y: number;
  /** ウィンドウ内にカーソルがあるか。 */
  inside: boolean;
}

/** 記憶した視点。 */
export interface CameraSnapshot {
  cx: number;
  cy: number;
  zoom: number;
}

export class CameraController {
  readonly cam: Camera;
  /** マップの広さ（マス）。範囲外へスクロールしないための clamp に使う。 */
  mapW: number;
  mapH: number;
  /** 画面端スクロールの有効・無効（`06§7`「無効にもできます」）。 */
  edgeScrollEnabled = true;
  /** スクロール速度（px / 秒）。 */
  scrollPxPerSec = DEFAULT_SCROLL_PX_PER_SEC;

  /** `F1`〜`F4` に記憶した視点。 */
  private readonly slots: (CameraSnapshot | null)[] = new Array<CameraSnapshot | null>(
    CAMERA_SLOTS,
  ).fill(null);
  /** 視点履歴（`Backspace` 用。末尾が直前）。 */
  private readonly history: CameraSnapshot[] = [];
  /** `H` の巡回位置（2 回目で次の町の中心へ）。 */
  private homeCursor = 0;

  constructor(cam: Camera, mapW: number, mapH: number) {
    this.cam = cam;
    this.mapW = mapW;
    this.mapH = mapH;
  }

  /** 今の視点のコピー。 */
  snapshot(): CameraSnapshot {
    return { cx: this.cam.cx, cy: this.cam.cy, zoom: this.cam.zoom };
  }

  /** マップの外に出ないよう中心座標を丸める。 */
  clamp(): void {
    if (this.cam.cx < 0) this.cam.cx = 0;
    if (this.cam.cy < 0) this.cam.cy = 0;
    if (this.cam.cx > this.mapW) this.cam.cx = this.mapW;
    if (this.cam.cy > this.mapH) this.cam.cy = this.mapH;
  }

  /** マス単位で動かす（履歴に積まない）。 */
  panByTiles(dx: number, dy: number): void {
    this.cam.cx += dx;
    this.cam.cy += dy;
    this.clamp();
  }

  /**
   * 画面上の px 差分で動かす（中ドラッグ・矢印キー・画面端）。
   * 画面 → マップの変換は線形なので `worldToTile` に差分をそのまま通せる。
   */
  panByScreen(dxPx: number, dyPx: number): void {
    const d = worldToTile(dxPx, dyPx, this.cam.zoom);
    this.panByTiles(d.x, d.y);
  }

  /**
   * 毎フレームのスクロール処理。
   * @param dtMs 前フレームからの経過 ms
   */
  update(dtMs: number, keys: ScrollKeys, pointer: PointerPos | null): void {
    let dx = 0;
    let dy = 0;
    if (keys.left) dx -= 1;
    if (keys.right) dx += 1;
    if (keys.up) dy -= 1;
    if (keys.down) dy += 1;

    if (this.edgeScrollEnabled && pointer !== null && pointer.inside) {
      if (pointer.x <= EDGE_MARGIN_PX) dx -= 1;
      if (pointer.x >= this.cam.viewW - EDGE_MARGIN_PX) dx += 1;
      if (pointer.y <= EDGE_MARGIN_PX) dy -= 1;
      if (pointer.y >= this.cam.viewH - EDGE_MARGIN_PX) dy += 1;
    }
    if (dx === 0 && dy === 0) return;
    // 斜めが速くならないように正規化
    const len = Math.hypot(dx, dy);
    const step = (this.scrollPxPerSec * dtMs) / 1000;
    this.panByScreen((dx / len) * step, (dy / len) * step);
  }

  /** 中ドラッグ（`06§2`）。掴んだ地面が指に付いてくるように逆向きに動かす。 */
  dragScroll(dxPx: number, dyPx: number): void {
    this.panByScreen(-dxPx, -dyPx);
  }

  /**
   * ホイールでズーム（4 段階。`06§7`）。
   * @param dir +1 = 寄る / -1 = 引く
   */
  zoomStep(dir: -1 | 1): number {
    this.cam.zoom = stepZoom(this.cam.zoom, dir);
    return this.cam.zoom;
  }

  /** 一番引いた状態か（「最も引くと戦域の輪が全部見えます」）。 */
  isFullyZoomedOut(): boolean {
    return this.cam.zoom === ZOOM_LEVELS[0];
  }

  /**
   * 指定のマスへ飛ぶ。**飛ぶ前の視点を履歴に積む**（`Backspace` で戻れる）。
   * ミニマップのクリック・戦域選択（`1`〜`6`）・`H`・`F1`〜`F4` から呼ぶ。
   */
  jumpTo(tileX: number, tileY: number): void {
    this.pushHistory();
    this.cam.cx = tileX;
    this.cam.cy = tileY;
    this.clamp();
  }

  /** 履歴に今の視点を積む（連続した同じ位置は積まない）。 */
  pushHistory(): void {
    const last = this.history[this.history.length - 1];
    const s = this.snapshot();
    if (last !== undefined && Math.abs(last.cx - s.cx) < 0.5 && Math.abs(last.cy - s.cy) < 0.5) {
      return;
    }
    this.history.push(s);
    if (this.history.length > CAMERA_HISTORY_LIMIT) this.history.shift();
  }

  /** 履歴の長さ（テスト用）。 */
  historyLength(): number {
    return this.history.length;
  }

  /** `Backspace`: 直前の視点へ。連続で押すと履歴を遡る。戻れなければ false。 */
  back(): boolean {
    const s = this.history.pop();
    if (s === undefined) return false;
    this.cam.cx = s.cx;
    this.cam.cy = s.cy;
    this.cam.zoom = s.zoom;
    this.clamp();
    return true;
  }

  /** `Ctrl`+`F1`〜`F4`: 今の視点を記憶する。slot は 0..3。 */
  saveSlot(slot: number): boolean {
    if (!Number.isInteger(slot) || slot < 0 || slot >= CAMERA_SLOTS) return false;
    this.slots[slot] = this.snapshot();
    return true;
  }

  /** `F1`〜`F4`: 記憶した視点を呼び出す。未記憶なら false。 */
  recallSlot(slot: number): boolean {
    if (!Number.isInteger(slot) || slot < 0 || slot >= CAMERA_SLOTS) return false;
    const s = this.slots[slot];
    if (s === null || s === undefined) return false;
    this.pushHistory();
    this.cam.cx = s.cx;
    this.cam.cy = s.cy;
    this.cam.zoom = s.zoom;
    this.clamp();
    return true;
  }

  /** slot に記憶があるか（HUD の表示用）。 */
  hasSlot(slot: number): boolean {
    return this.slots[slot] !== null && this.slots[slot] !== undefined;
  }

  /**
   * `H`: 町の中心へ視点を移す。**2 回押すと次の町の中心へ**（`06§7`）。
   * 町の中心は `buildings.json` の `lossCausesDefeat` で判定する（ID を書かない）。
   *
   * @returns 飛んだ先のマス座標。町の中心が無ければ null
   */
  home(w: World, viewer: PlayerId): { x: number; y: number } | null {
    const centers = findTownCenters(w, viewer);
    if (centers.length === 0) return null;
    if (this.homeCursor >= centers.length) this.homeCursor = 0;
    const c = centers[this.homeCursor]!;
    this.homeCursor = (this.homeCursor + 1) % centers.length;
    this.jumpTo(c.x, c.y);
    return c;
  }

  /** `H` の巡回位置を先頭に戻す（町の中心が壊れたときなど）。 */
  resetHomeCursor(): void {
    this.homeCursor = 0;
  }
}

/**
 * そのプレイヤーの町の中心の座標（マス単位）を index 昇順で返す。
 * 「町の中心」= `lossCausesDefeat` が立っている建物（`buildings.json`）。
 */
export function findTownCenters(w: World, viewer: PlayerId): { x: number; y: number }[] {
  const e = w.entities;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== viewer) continue;
    if (!buildingDef(e.typeId[i]!).lossCausesDefeat) continue;
    out.push({ x: e.x[i]! / FX_ONE, y: e.y[i]! / FX_ONE });
  }
  return out;
}
