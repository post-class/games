/**
 * input/mouse.ts — マウス操作（`06§2`。T-M5-04 / 07 / 08）
 *
 *  | 左クリック         | 選択                                       |
 *  | 左ドラッグ         | 範囲選択（`Alt`+ で村人を除く）            |
 *  | 左ダブルクリック   | 画面内の同種すべて                         |
 *  | `Ctrl`+左クリック  | マップ全体の同種すべて                     |
 *  | `Shift`+左クリック | 追加／除外                                 |
 *  | 右クリック         | 文脈指示（`Shift`+ で予約）                |
 *  | 中ドラッグ         | 視点スクロール                             |
 *  | ホイール           | ズーム（4 段）                             |
 *
 * DOM の購読は `attach()` に閉じ込め、判定は純粋なメソッドに出してある
 * （`tests/unit/input.*.test.ts` が DOM 無しで叩けるようにするため）。
 */

import { INVALID_ENTITY, type EntityId } from '@/shared/types';
import { resolveIndex } from '@/sim/core/entity';
import { screenToTile } from '@/render/iso';
import type { DragRect } from '@/render/Renderer';
import { CursorKind, contextCommand, resolveContext, type CursorKindId } from './context';
import { cursorCss } from './cursor';
import type { InputContext } from './env';
import {
  pickEntityAt,
  sameTypeInView,
  sameTypeOnMap,
  selectInScreenRect,
} from './selection';

/** ドラッグと判定する最小移動量（px）。 */
export const DRAG_THRESHOLD_PX = 5;

/** 押されている修飾キー。 */
export interface Modifiers {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
}

const NO_MODS: Modifiers = { shift: false, ctrl: false, alt: false };

export class MouseInput {
  /** 画面端スクロール用の現在位置。 */
  pointerX = 0;
  pointerY = 0;
  pointerInside = false;
  /** 今のカーソル形状（HUD のデバッグ表示にも使う）。 */
  cursor: CursorKindId = CursorKind.None;

  private leftDown = false;
  private startX = 0;
  private startY = 0;
  private dragging = false;
  private middleDown = false;
  private lastMidX = 0;
  private lastMidY = 0;
  /** 範囲選択の矩形（描画層に渡す）。 */
  private rect: DragRect | null = null;

  private detachFns: (() => void)[] = [];

  /**
   * 地面クリックを先に受け取るフック（建設位置の指定など、UI の「置くモード」用）。
   * true を返すとクリックを消費して選択処理を行わない。
   */
  onGroundClick: ((tileX: number, tileY: number, mods: Modifiers) => boolean) | null = null;

  constructor(private readonly ctx: InputContext) {}

  /** 描画に渡す範囲選択の矩形（無ければ null）。 */
  dragRect(): DragRect | null {
    return this.rect;
  }

  // ------------------------------------------------------------ 判定（DOM 不要）

  /** 左ボタンを押した。 */
  onLeftDown(sx: number, sy: number): void {
    this.leftDown = true;
    this.dragging = false;
    this.startX = sx;
    this.startY = sy;
    this.rect = null;
  }

  /** マウスが動いた。 */
  onMove(sx: number, sy: number, mods: Modifiers = NO_MODS): void {
    this.pointerX = sx;
    this.pointerY = sy;
    this.pointerInside = true;
    if (this.leftDown) {
      if (
        !this.dragging &&
        (Math.abs(sx - this.startX) > DRAG_THRESHOLD_PX ||
          Math.abs(sy - this.startY) > DRAG_THRESHOLD_PX)
      ) {
        this.dragging = true;
      }
      if (this.dragging) {
        this.rect = { x0: this.startX, y0: this.startY, x1: sx, y1: sy };
      }
    }
    if (this.middleDown) {
      this.ctx.cam.dragScroll(sx - this.lastMidX, sy - this.lastMidY);
      this.lastMidX = sx;
      this.lastMidY = sy;
    }
    this.refreshCursor(sx, sy, mods);
  }

  /**
   * 左ボタンを離した。ドラッグなら範囲選択、そうでなければクリック選択。
   * @param clickCount `MouseEvent.detail`（2 = ダブルクリック）
   */
  onLeftUp(sx: number, sy: number, mods: Modifiers = NO_MODS, clickCount = 1): void {
    if (!this.leftDown) return;
    this.leftDown = false;
    const sel = this.ctx.selection;
    sel.resetGroupRecall();

    if (this.dragging && this.rect !== null) {
      const picked = selectInScreenRect(
        this.ctx.world(),
        this.ctx.viewer,
        this.ctx.cam.cam,
        this.rect,
        // `Alt`+ドラッグ = 村人を除く（`06§5`）
        mods.alt ? { excludeVillagers: true } : {},
      );
      if (mods.shift) sel.add(picked);
      else sel.set(picked);
      this.dragging = false;
      this.rect = null;
      this.ctx.onChange?.();
      return;
    }
    this.rect = null;
    this.clickSelect(sx, sy, mods, clickCount);
  }

  /** クリック 1 回ぶんの選択処理。 */
  clickSelect(sx: number, sy: number, mods: Modifiers = NO_MODS, clickCount = 1): EntityId {
    const w = this.ctx.world();
    const cam = this.ctx.cam.cam;
    const t = screenToTile(cam, sx, sy);
    // 「置くモード」（建設位置の指定）が先取りする
    if (this.onGroundClick !== null && this.onGroundClick(t.x, t.y, mods)) {
      return INVALID_ENTITY;
    }
    const id = pickEntityAt(w, this.ctx.viewer, t.x, t.y, this.ctx.vision());
    const sel = this.ctx.selection;

    if (id === INVALID_ENTITY) {
      if (!mods.shift) sel.clear();
      this.ctx.onChange?.();
      return INVALID_ENTITY;
    }
    const i = resolveIndex(w.entities, id);
    const typeId = i >= 0 ? w.entities.typeId[i]! : -1;
    const mine = i >= 0 && w.entities.owner[i] === this.ctx.viewer;

    if (mods.shift) {
      sel.toggle(id);
    } else if (mods.ctrl && mine) {
      // `Ctrl`+クリック: マップ全体の同種
      sel.set(sameTypeOnMap(w, this.ctx.viewer, typeId));
    } else if (clickCount >= 2 && mine) {
      // ダブルクリック: 画面内の同種
      sel.set(sameTypeInView(w, this.ctx.viewer, cam, typeId));
    } else {
      sel.set([id]);
    }
    this.ctx.onChange?.();
    return id;
  }

  /** 右クリック（文脈指示）。`Shift` で予約。 */
  onRightClick(sx: number, sy: number, mods: Modifiers = NO_MODS): void {
    const w = this.ctx.world();
    const t = screenToTile(this.ctx.cam.cam, sx, sy);
    const cmd = contextCommand(
      w,
      this.ctx.viewer,
      this.ctx.selection.list(),
      t.x,
      t.y,
      mods.shift,
      this.ctx.vision(),
    );
    if (cmd !== null) this.ctx.emit(cmd);
  }

  /** 中ボタン（視点スクロール）。 */
  onMiddleDown(sx: number, sy: number): void {
    this.middleDown = true;
    this.lastMidX = sx;
    this.lastMidY = sy;
  }

  onMiddleUp(): void {
    this.middleDown = false;
  }

  /** ホイール（ズーム 4 段）。 */
  onWheel(deltaY: number): void {
    this.ctx.cam.zoomStep(deltaY < 0 ? 1 : -1);
  }

  /** カーソルが窓の外へ出た。 */
  onLeave(): void {
    this.pointerInside = false;
    this.leftDown = false;
    this.middleDown = false;
    this.dragging = false;
    this.rect = null;
  }

  /** カーソル形状を更新する（実際の指示と同じ判定を使う）。 */
  refreshCursor(sx: number, sy: number, mods: Modifiers = NO_MODS): CursorKindId {
    void mods;
    const t = screenToTile(this.ctx.cam.cam, sx, sy);
    const r = resolveContext(
      this.ctx.world(),
      this.ctx.viewer,
      t.x,
      t.y,
      this.ctx.selection.list(),
      this.ctx.vision(),
    );
    this.cursor = r.cursor;
    return r.cursor;
  }

  // ------------------------------------------------------------ DOM 結線

  /** Canvas にイベントを繋ぐ。戻り値を呼ぶと外れる。 */
  attach(canvas: HTMLCanvasElement): () => void {
    const pos = (ev: MouseEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    const mods = (ev: MouseEvent): Modifiers => ({
      shift: ev.shiftKey,
      ctrl: ev.ctrlKey || ev.metaKey,
      alt: ev.altKey,
    });

    const onDown = (ev: MouseEvent): void => {
      const p = pos(ev);
      if (ev.button === 0) this.onLeftDown(p.x, p.y);
      else if (ev.button === 1) {
        ev.preventDefault();
        this.onMiddleDown(p.x, p.y);
      }
    };
    const onUp = (ev: MouseEvent): void => {
      const p = pos(ev);
      if (ev.button === 0) this.onLeftUp(p.x, p.y, mods(ev), ev.detail);
      else if (ev.button === 1) this.onMiddleUp();
      else if (ev.button === 2) this.onRightClick(p.x, p.y, mods(ev));
    };
    const onMove = (ev: MouseEvent): void => {
      const p = pos(ev);
      this.onMove(p.x, p.y, mods(ev));
      canvas.style.cursor = cursorCss(this.cursor);
    };
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      this.onWheel(ev.deltaY);
    };
    const onContext = (ev: MouseEvent): void => ev.preventDefault();
    const onLeave = (): void => this.onLeave();

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onMove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContext);
    canvas.addEventListener('mouseleave', onLeave);

    const detach = (): void => {
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      canvas.removeEventListener('mouseleave', onLeave);
    };
    this.detachFns.push(detach);
    return detach;
  }

  /** 繋いだイベントを全部外す。 */
  detachAll(): void {
    for (const f of this.detachFns) f();
    this.detachFns = [];
  }
}
