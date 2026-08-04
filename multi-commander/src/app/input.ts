import { clamp, clamp01 } from '../core/math';
import { settings } from './settings';

/** エッジ入力 (押した瞬間に1回だけ効くもの) */
export type InputAction =
  | 'fireMissile'
  | 'targetNext'
  | 'targetNearest'
  | 'targetFront'
  | 'autopilot'
  | 'comms'
  | 'damageDisplay'
  | 'viewToggle'
  | 'navMap'
  | 'nextSecondary'
  | 'flare'
  | 'mouseToggle'
  | 'flightModeToggle'
  | 'eject'
  | 'pause'
  | 'menuUp'
  | 'menuDown'
  | 'menuLeft'
  | 'menuRight'
  | 'menuConfirm'
  | 'menuCancel'
  | 'comms1'
  | 'comms2'
  | 'comms3'
  | 'comms4';

const THROTTLE_KEY_RATE = 0.9; // 毎秒

/**
 * キーボード + マウスの入力集約。
 * - 操縦は「マウスだけ」でも「キーボードだけ」でも完結する。
 * - スロットルはレバー式で、キーを離しても値を保持する。
 */
export class InputManager {
  private keys = new Set<string>();
  private actions: InputAction[] = [];
  private mouseButtons = new Set<number>();

  /** 照準位置を原点とした -1..1 のマウス操縦入力 */
  mouseNx = 0;
  mouseNy = 0;
  /** 画面中心を原点とした -1..1 の実カーソル位置 (HUD 表示用) */
  mousePx = 0;
  mousePy = 0;
  /** マウスが画面内で動いたことがあるか */
  mouseActive = false;
  /**
   * マウス操縦が有効化されているか。
   * メニューのボタンを押した直後にカーソルが端にあると機首が暴れるため、
   * 一度カーソルを画面中央付近へ戻すまで操縦入力を無効にする。
   */
  mouseArmed = false;

  /** 0..1 のスロットル (保持される) */
  throttle = 0.5;
  /** マウス操縦の有効/無効 (設定と M キーで切り替え) */
  mouseFlight = true;

  /** メニュー中は飛行入力を無効化する */
  uiMode = false;
  /** 通信メニュー表示中は数字キーを選択に使う (飛行は続行) */
  commsMode = false;

  private el: HTMLElement;
  private disposers: Array<() => void> = [];

  constructor(el: HTMLElement) {
    this.el = el;
    this.mouseFlight = settings.mouseFlight;
    this.bind();
  }

  private bind(): void {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.repeat) {
        // リピートはスロットル等の押しっぱなし判定にだけ使う
        return;
      }
      // ブラウザ既定動作を潰す必要があるキー
      if (
        ev.code === 'Tab' ||
        ev.code === 'Space' ||
        ev.code === 'ArrowUp' ||
        ev.code === 'ArrowDown' ||
        ev.code === 'ArrowLeft' ||
        ev.code === 'ArrowRight' ||
        ev.code === 'Backquote'
      ) {
        ev.preventDefault();
      }
      this.keys.add(ev.code);
      this.handleEdge(ev);
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      this.keys.delete(ev.code);
    };
    const onBlur = () => {
      this.keys.clear();
      this.mouseButtons.clear();
    };
    const onMouseMove = (ev: MouseEvent) => {
      const r = this.el.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width;
      const y = (ev.clientY - r.top) / r.height;
      this.mousePx = x * 2 - 1;
      this.mousePy = y * 2 - 1;
      this.mouseNx = this.mousePx;
      // 照準を置いた前方視界の中央を、マウス操縦のニュートラル位置にする。
      this.mouseNy = centeredInput(y, MOUSE_AIM_ORIGIN_Y);
      this.mouseActive = true;
      // 中央付近に戻ってきたら操縦を引き渡す
      if (!this.mouseArmed && Math.abs(this.mouseNx) < ARM_ZONE && Math.abs(this.mouseNy) < ARM_ZONE) {
        this.mouseArmed = true;
      }
    };
    const onMouseDown = (ev: MouseEvent) => {
      if (this.uiMode) return;
      this.mouseButtons.add(ev.button);
      if (ev.button === 2) this.actions.push('fireMissile');
      if (ev.button === 1) ev.preventDefault();
    };
    const onMouseUp = (ev: MouseEvent) => {
      this.mouseButtons.delete(ev.button);
    };
    const onContextMenu = (ev: Event) => ev.preventDefault();
    const onWheel = (ev: WheelEvent) => {
      if (this.uiMode) return;
      ev.preventDefault();
      this.throttle = clamp01(this.throttle - Math.sign(ev.deltaY) * 0.1);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('contextmenu', onContextMenu);
    this.el.addEventListener('wheel', onWheel, { passive: false });

    this.disposers.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('contextmenu', onContextMenu);
      this.el.removeEventListener('wheel', onWheel);
    });
  }

  private handleEdge(ev: KeyboardEvent): void {
    const code = ev.code;
    // メニュー操作は常に受け付ける
    switch (code) {
      case 'ArrowUp':
        this.actions.push('menuUp');
        break;
      case 'ArrowDown':
        this.actions.push('menuDown');
        break;
      case 'ArrowLeft':
        this.actions.push('menuLeft');
        break;
      case 'ArrowRight':
        this.actions.push('menuRight');
        break;
      case 'Enter':
      case 'NumpadEnter':
        this.actions.push('menuConfirm');
        if (!this.uiMode) this.actions.push('fireMissile');
        break;
      case 'Escape':
        this.actions.push('menuCancel');
        this.actions.push('pause');
        break;
      default:
        break;
    }
    if (this.uiMode) {
      // 数字キーはメニューの直接選択に使うので通す
      if (code.startsWith('Digit')) {
        const n = Number(code.slice(5));
        if (n >= 1 && n <= 4) this.actions.push(`comms${n}` as InputAction);
      }
      return;
    }

    switch (code) {
      case 'KeyT':
        this.actions.push('targetNext');
        break;
      case 'KeyR':
        this.actions.push('targetNearest');
        break;
      case 'KeyY':
        this.actions.push('targetFront');
        break;
      case 'KeyA':
        this.actions.push('autopilot');
        break;
      case 'KeyC':
        this.actions.push('comms');
        break;
      case 'KeyD':
        this.actions.push('damageDisplay');
        break;
      case 'KeyF':
        this.actions.push('viewToggle');
        break;
      case 'KeyN':
        this.actions.push('navMap');
        break;
      case 'KeyX':
        this.actions.push('nextSecondary');
        break;
      case 'KeyG':
        this.actions.push('flare');
        break;
      case 'KeyM':
        this.actions.push('mouseToggle');
        break;
      case 'KeyZ':
        this.actions.push('flightModeToggle');
        break;
      case 'KeyE':
        // 脱出は誤操作が致命的なので修飾キー必須にする
        if (ev.altKey || ev.ctrlKey) this.actions.push('eject');
        break;
      case 'Backquote':
        this.throttle = 1;
        break;
      case 'Backspace':
        this.throttle = 0;
        break;
      default:
        if (code.startsWith('Digit')) {
          const n = Number(code.slice(5));
          if (!Number.isFinite(n)) break;
          if (this.commsMode && n >= 1 && n <= 4) {
            this.actions.push(`comms${n}` as InputAction);
          } else {
            this.throttle = n === 0 ? 0 : clamp01(n / 10);
          }
        }
        break;
    }
  }

  /** 毎フレーム、保持系入力を更新する */
  update(dt: number): void {
    if (this.uiMode) return;
    const up = this.keys.has('BracketRight') || this.keys.has('Equal') || this.keys.has('NumpadAdd');
    const down =
      this.keys.has('BracketLeft') || this.keys.has('Minus') || this.keys.has('NumpadSubtract');
    if (up) this.throttle = clamp01(this.throttle + THROTTLE_KEY_RATE * dt);
    if (down) this.throttle = clamp01(this.throttle - THROTTLE_KEY_RATE * dt);
  }

  /** 溜まったエッジ入力を取り出す (取り出すと消える) */
  consumeActions(): InputAction[] {
    if (this.actions.length === 0) return EMPTY;
    const out = this.actions;
    this.actions = [];
    return out;
  }

  /** -1..1 (+ = 機首上げ) */
  get pitch(): number {
    let v = 0;
    if (this.keys.has('ArrowUp')) v += 1;
    if (this.keys.has('ArrowDown')) v -= 1;
    if (v === 0 && this.stickEnabled) {
      v = -this.stickY();
    }
    return clamp(settings.invertY ? -v : v, -1, 1);
  }

  /** -1..1 (+ = 右) */
  get yaw(): number {
    let v = 0;
    if (this.keys.has('ArrowRight')) v += 1;
    if (this.keys.has('ArrowLeft')) v -= 1;
    if (v === 0 && this.stickEnabled) {
      v = this.stickX();
    }
    return clamp(v, -1, 1);
  }

  /** -1..1 (+ = 右ロール) */
  get roll(): number {
    let v = 0;
    if (this.keys.has('KeyE')) v += 1;
    if (this.keys.has('KeyQ')) v -= 1;
    return v;
  }

  /** マウススティックが操縦に効いているか */
  get stickEnabled(): boolean {
    return this.mouseFlight && this.mouseActive && this.mouseArmed;
  }

  /** ミッション開始時など、いったんマウス操縦を切っておく */
  disarmMouse(): void {
    this.mouseArmed = false;
  }

  get afterburner(): boolean {
    return this.keys.has('Tab');
  }

  get firePrimary(): boolean {
    return this.keys.has('Space') || this.mouseButtons.has(0);
  }

  /** 仮想スティックの水平量 (デッドゾーン付き) */
  stickX(): number {
    return stick(this.mouseNx) * settings.mouseSensitivity;
  }

  stickY(): number {
    return stick(this.mouseNy) * settings.mouseSensitivity;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}

const EMPTY: InputAction[] = [];
const DEADZONE = 0.06;
/** この範囲にカーソルが入るとマウス操縦が有効になる */
const ARM_ZONE = 0.22;
/** この割合で入力が最大になる (画面中心から 55% の位置) */
const FULL_AT = 0.55;
/** HUD の固定照準と共有する、画面内でのマウス操縦のニュートラル位置 */
const MOUSE_AIM_ORIGIN_Y = 0.35;

/** 画面上の位置を、指定した原点を中心とする -1..1 の操縦入力へ変換する。 */
function centeredInput(position: number, origin: number): number {
  return position < origin ? (position - origin) / origin : (position - origin) / (1 - origin);
}

function stick(n: number): number {
  const a = Math.abs(n);
  if (a < DEADZONE) return 0;
  const t = clamp01((a - DEADZONE) / (FULL_AT - DEADZONE));
  // 中心付近を緩やかにして微調整しやすくする
  const shaped = t * t * 0.45 + t * 0.55;
  return Math.sign(n) * shaped;
}
