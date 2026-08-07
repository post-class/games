/**
 * スマホ用のバーチャルパッドとボタン（docs/02_ゲーム実装プラン/06_クライアント設計.md §4）
 *
 * タッチ端末のときだけ出す。移動は左下のスティック、
 * ペット情報と設置はボタンにする（キーボードが無いので B/F/L と Space の代わり）。
 *
 * 出力は `InputController.axis` と同じ形（-1..1）で、main.ts が同じ経路に流す。
 */

export interface TouchPadCallbacks {
  /** 方向が変わったとき（-1..1）。停止は (0,0) */
  onAxis: (dx: number, dy: number) => void;
  /** ペット情報パネルの開閉 */
  onCall: () => void;
  /** 設置 */
  onPlace: (type: 'bench' | 'flowerbed' | 'lantern') => void;
}

/** スティックの半径（px）。この距離で最大入力になる */
const STICK_RADIUS = 46;
/** これ未満は0扱い（指の震えを拾わない） */
const DEAD_ZONE = 8;

/** タッチ操作が主な端末か（マウスがあるノートPCでは出さない） */
export function isTouchDevice(): boolean {
  return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
}

export class TouchPad {
  private root: HTMLElement;
  private stick: HTMLElement;
  private knob: HTMLElement;
  private cb: TouchPadCallbacks;
  private pointerId: number | null = null;
  private center = { x: 0, y: 0 };
  private axis = { dx: 0, dy: 0 };

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(cb: TouchPadCallbacks) {
    this.cb = cb;

    this.root = document.createElement('div');
    this.root.className = 'pad';
    this.root.dataset['testid'] = 'touch-pad';
    this.root.innerHTML = `
      <div class="pad-stick" data-testid="pad-stick"><div class="pad-knob"></div></div>
      <div class="pad-buttons">
        <button class="pad-btn" data-act="call" data-testid="pad-call">ペット</button>
        <button class="pad-btn" data-act="bench">ベンチ</button>
        <button class="pad-btn" data-act="flowerbed">花壇</button>
        <button class="pad-btn" data-act="lantern">灯り</button>
      </div>`;
    document.body.appendChild(this.root);

    this.stick = this.root.querySelector('.pad-stick') as HTMLElement;
    this.knob = this.root.querySelector('.pad-knob') as HTMLElement;

    this.stick.addEventListener('pointerdown', (e) => this.onDown(e));
    this.stick.addEventListener('pointermove', (e) => this.onMove(e));
    this.stick.addEventListener('pointerup', (e) => this.onUp(e));
    this.stick.addEventListener('pointercancel', (e) => this.onUp(e));

    this.root.querySelector('.pad-buttons')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.pad-btn') as HTMLElement | null;
      const act = btn?.dataset['act'];
      if (!act) return;
      if (act === 'call') this.cb.onCall();
      else this.cb.onPlace(act as 'bench' | 'flowerbed' | 'lantern');
    });
  }

  private onDown(e: PointerEvent): void {
    e.preventDefault();
    this.pointerId = e.pointerId;
    this.stick.setPointerCapture(e.pointerId);
    const rect = this.stick.getBoundingClientRect();
    this.center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    this.update(e.clientX, e.clientY);
  }

  private onMove(e: PointerEvent): void {
    if (this.pointerId !== e.pointerId) return;
    e.preventDefault();
    this.update(e.clientX, e.clientY);
  }

  private onUp(e: PointerEvent): void {
    if (this.pointerId !== e.pointerId) return;
    this.pointerId = null;
    this.knob.style.transform = '';
    this.emit(0, 0);
  }

  private update(x: number, y: number): void {
    let dx = x - this.center.x;
    let dy = y - this.center.y;
    const len = Math.hypot(dx, dy);
    if (len < DEAD_ZONE) {
      this.knob.style.transform = '';
      this.emit(0, 0);
      return;
    }
    // ノブの見た目は半径内に収める
    const clamped = Math.min(len, STICK_RADIUS);
    const nx = (dx / len) * clamped;
    const ny = (dy / len) * clamped;
    this.knob.style.transform = `translate(${nx}px, ${ny}px)`;

    // 入力は -1..1 に正規化（半径で最大）
    dx = nx / STICK_RADIUS;
    dy = ny / STICK_RADIUS;
    this.emit(Math.max(-1, Math.min(1, dx)), Math.max(-1, Math.min(1, dy)));
  }

  private emit(dx: number, dy: number): void {
    // 0.05刻みに丸めて、送信回数を減らす（サーバへは変化時のみ送る）
    const rx = Math.round(dx * 20) / 20;
    const ry = Math.round(dy * 20) / 20;
    if (rx === this.axis.dx && ry === this.axis.dy) return;
    this.axis = { dx: rx, dy: ry };
    this.cb.onAxis(rx, ry);
  }

  /** 現在の入力（main.ts のクライアント予測が読む） */
  get value(): { dx: number; dy: number } {
    return this.axis;
  }

  destroy(): void {
    this.root.remove();
  }
}
