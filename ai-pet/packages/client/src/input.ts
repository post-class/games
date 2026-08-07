/**
 * 入力（docs/02_ゲーム実装プラン/06_クライアント設計.md §4）
 *
 * | 操作 | PC | スマホ |
 * |---|---|---|
 * | 移動 | WASD/矢印 or 地面クリック | 地面タップ |
 * | ズーム | ホイール | ピンチ |
 * | ペット呼び出し | Space | （M4でボタン化） |
 *
 * サーバ送信は main.ts が行う。ここはイベントをコールバックで通知するだけ。
 * `axis` は毎フレームのクライアント予測（render/sprites.ts）が読む。
 */
import type { Vec2 } from '@ai-pet/shared';
import type { Camera } from './render/camera.ts';

/** moveAxis の送信間隔（ms）。docs 05章の「100msごとに変化時のみ」 */
export const AXIS_SEND_INTERVAL_MS = 100;
/** タップ判定：この距離（CSS px）を超えたらドラッグ扱いで移動指示にしない */
const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 500;
/** ホイールのしきい値（トラックパッドの細かいdeltaで段が飛ばないように） */
const WHEEL_THRESHOLD = 40;
/** ピンチでズーム段を動かす倍率 */
const PINCH_IN = 1.25;
const PINCH_OUT = 0.8;

export interface InputCallbacks {
  /** 100msごと・変化時のみ呼ばれる（moveAxis 相当） */
  onMoveAxis?: (dx: number, dy: number) => void;
  /** 地面クリック/タップ（move 相当。タイル座標の整数） */
  onMoveTo?: (tile: Vec2) => void;
  /** ズーム段の変更要求。dir>0 で寄る */
  onZoom?: (dir: number) => void;
  /** 対象選択（ワールド座標とスクリーン座標）。M2以降のコンテキストメニュー用 */
  onPick?: (world: Vec2, screen: Vec2) => void;
  /** Space（ペット呼び出し） */
  onCall?: () => void;
  /** B（ベンチ）/ F（花壇）/ L（ランタン）で設置 */
  onPlace?: (type: 'bench' | 'flowerbed' | 'lantern') => void;
  /** Enter（チャット欄フォーカス） */
  onChatFocus?: () => void;
}

interface PointerRec {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startAt: number;
}

const KEY_AXIS: Record<string, readonly [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

export class InputController {
  private readonly target: HTMLElement;
  private readonly camera: Camera;
  private readonly cb: InputCallbacks;

  /** 現在の入力方向（-1..1、正規化はしない。予測側で正規化する） */
  readonly axis: { dx: number; dy: number } = { dx: 0, dy: 0 };

  private readonly held = new Set<string>();
  private readonly pointers = new Map<number, PointerRec>();
  private pinchBase = 0;
  private wheelAcc = 0;
  private lastSentAt = 0;
  private lastSent = { dx: 0, dy: 0 };
  private detached = false;

  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onBlur: () => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;

  constructor(target: HTMLElement, camera: Camera, cb: InputCallbacks) {
    this.target = target;
    this.camera = camera;
    this.cb = cb;

    this.onKeyDown = (e) => {
      if (isTypingInto(e.target)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.cb.onCall?.();
        return;
      }
      if (e.code === 'Enter') {
        this.cb.onChatFocus?.();
        return;
      }
      // 設置物のショートカット（B/F/L）。移動キー（WASD）と重ならない位置を選んである
      if (e.code === 'KeyB' || e.code === 'KeyF' || e.code === 'KeyL') {
        const type = e.code === 'KeyB' ? 'bench' : e.code === 'KeyF' ? 'flowerbed' : 'lantern';
        this.cb.onPlace?.(type);
        return;
      }
      if (!(e.code in KEY_AXIS)) return;
      e.preventDefault();
      this.held.add(e.code);
      this.recomputeAxis();
    };

    this.onKeyUp = (e) => {
      if (!(e.code in KEY_AXIS)) return;
      this.held.delete(e.code);
      this.recomputeAxis();
    };

    this.onBlur = () => {
      this.held.clear();
      this.pointers.clear();
      this.recomputeAxis();
    };

    this.onWheel = (e) => {
      e.preventDefault();
      this.wheelAcc += e.deltaY;
      while (Math.abs(this.wheelAcc) >= WHEEL_THRESHOLD) {
        const dir = this.wheelAcc > 0 ? -1 : 1; // 下スクロールで引く
        this.wheelAcc -= Math.sign(this.wheelAcc) * WHEEL_THRESHOLD;
        this.cb.onZoom?.(dir);
      }
    };

    this.onPointerDown = (e) => {
      const p = this.local(e);
      this.pointers.set(e.pointerId, { x: p.x, y: p.y, startX: p.x, startY: p.y, startAt: performance.now() });
      if (this.pointers.size === 2) this.pinchBase = this.pointerDistance();
      this.target.setPointerCapture?.(e.pointerId);
    };

    this.onPointerMove = (e) => {
      const rec = this.pointers.get(e.pointerId);
      if (!rec) return;
      const p = this.local(e);
      rec.x = p.x;
      rec.y = p.y;
      if (this.pointers.size === 2 && this.pinchBase > 0) {
        const d = this.pointerDistance();
        const ratio = d / this.pinchBase;
        if (ratio > PINCH_IN) {
          this.cb.onZoom?.(1);
          this.pinchBase = d;
        } else if (ratio < PINCH_OUT) {
          this.cb.onZoom?.(-1);
          this.pinchBase = d;
        }
      }
    };

    this.onPointerUp = (e) => {
      const rec = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchBase = 0;
      if (!rec) return;
      // ピンチ中の指離しはタップにしない
      if (this.pointers.size > 0) return;
      const moved = Math.hypot(rec.x - rec.startX, rec.y - rec.startY);
      const dt = performance.now() - rec.startAt;
      if (moved > TAP_SLOP_PX || dt > TAP_MAX_MS) return;
      const world = this.camera.screenToWorld({ x: rec.x, y: rec.y });
      this.cb.onPick?.(world, { x: rec.x, y: rec.y });
      this.cb.onMoveTo?.({ x: Math.floor(world.x), y: Math.floor(world.y) });
    };

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('wheel', this.onWheel, { passive: false });
    target.addEventListener('pointerdown', this.onPointerDown);
    target.addEventListener('pointermove', this.onPointerMove);
    target.addEventListener('pointerup', this.onPointerUp);
    target.addEventListener('pointercancel', this.onPointerUp);
  }

  private local(e: PointerEvent): Vec2 {
    const r = this.target.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pointerDistance(): number {
    const list = [...this.pointers.values()];
    const a = list[0];
    const b = list[1];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private recomputeAxis(): void {
    let dx = 0;
    let dy = 0;
    for (const code of this.held) {
      const v = KEY_AXIS[code];
      if (!v) continue;
      dx += v[0];
      dy += v[1];
    }
    this.axis.dx = Math.max(-1, Math.min(1, dx));
    this.axis.dy = Math.max(-1, Math.min(1, dy));
  }

  /**
   * 毎フレーム呼ぶ。100msごとに、前回送った値と違うときだけ onMoveAxis を呼ぶ。
   * 停止（0,0）への変化は即座に通知する（歩き続ける事故を防ぐ）。
   */
  update(nowMs: number): void {
    if (this.detached) return;
    const changed = this.axis.dx !== this.lastSent.dx || this.axis.dy !== this.lastSent.dy;
    if (!changed) return;
    const stopping = this.axis.dx === 0 && this.axis.dy === 0;
    if (!stopping && nowMs - this.lastSentAt < AXIS_SEND_INTERVAL_MS) return;
    this.lastSent = { dx: this.axis.dx, dy: this.axis.dy };
    this.lastSentAt = nowMs;
    this.cb.onMoveAxis?.(this.axis.dx, this.axis.dy);
  }

  detach(): void {
    this.detached = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('wheel', this.onWheel);
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    this.target.removeEventListener('pointermove', this.onPointerMove);
    this.target.removeEventListener('pointerup', this.onPointerUp);
    this.target.removeEventListener('pointercancel', this.onPointerUp);
  }
}

/** チャット欄などに入力中はゲーム操作を奪わない */
function isTypingInto(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
