import { clamp, clamp01 } from '../core/math';
import { AIM_ORIGIN_Y } from '../core/aim';
import { DEFAULT_KEY_BINDINGS, settings, type ControlBinding } from './settings';

/** エッジ入力 (押した瞬間に1回だけ効くもの) */
export type InputAction =
  | 'fireMissile'
  | 'manualLock'
  | 'speedMatch'
  | 'targetNext'
  | 'targetNearest'
  | 'targetFront'
  | 'targetReticle'
  | 'autopilot'
  | 'comms'
  | 'damageDisplay'
  | 'hudPanelToggle'
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
  | 'comms4'
  | 'comms5'
  | 'comms6';

const THROTTLE_KEY_RATE = 0.9; // 毎秒
const THROTTLE_KEY_STEP = 0.1; // キーを1回押すごとの変化量

/**
 * 速度設定キーの別名 (W7-2)。
 *
 * 方針書どおり `+` `-` を既定にしつつ、これまでの `]` `[` と
 * テンキーの `+` `-` も従来どおり効かせる。
 * **既定から割り当てを変えた人には別名を効かせない**（自分で選んだキーだけが効く）。
 * 単押し (`handleEdge`) と押しっぱなし (`update`) の両方が同じ表を見るので、
 * 「押し続けたときだけ `+` が効く」という以前のずれが起きない。
 */
const THROTTLE_ALIASES: Record<'throttleUp' | 'throttleDown', readonly string[]> = {
  throttleUp: ['Equal', 'NumpadAdd', 'BracketRight'],
  throttleDown: ['Minus', 'NumpadSubtract', 'BracketLeft'],
};

/**
 * Alt + キー → 通信メニューの項目番号 (1..5)。方針書の Alt+F/A/B/H/R に対応する (W7-6)。
 * メニューを開かずに僚機命令を出すためのショートカット。
 */
const ALT_WING_ORDERS: Record<string, number> = {
  KeyF: 1,
  KeyA: 2,
  KeyB: 3,
  KeyH: 4,
  KeyR: 5,
};

/**
 * 操縦を代行する入力 (チュートリアルのお手本モード)。
 *
 * `InputManager` へ差し込むと、人間の操縦入力の代わりにこの値が返る。
 * お手本モードが「画面に出すキー」と「実際にゲームへ渡す値」を
 * 同じ場所から作れるようにするための口で、`undefined` に戻せば人間の操作へ戻る。
 * エッジ入力 (ミサイル・ターゲットなど) は `pushAction()` で同じ列へ積む。
 */
export interface ScriptedFlightInput {
  /** -1..1 (+ = 機首上げ) */
  pitch: number;
  /** -1..1 (+ = 右) */
  yaw: number;
  /** -1..1 (+ = 右ロール) */
  roll: number;
  afterburner: boolean;
  firePrimary: boolean;
}

/**
 * キーボード + マウスの入力集約。
 * - 操縦は「マウスだけ」でも「キーボードだけ」でも完結する。
 * - スロットルはレバー式で、キーを離しても値を保持する。
 */
export class InputManager {
  /**
   * 操縦を代行する入力。設定されている間は人間の操縦入力を無視する。
   * 案内の送りやポーズなどのエッジ入力は、人間の側も従来どおり受け付ける。
   */
  scripted?: ScriptedFlightInput;
  private keys = new Set<string>();
  private actions: InputAction[] = [];
  private mouseButtons = new Set<number>();
  private gamepad?: Gamepad;
  private gamepadButtons = new Set<number>();
  private gamepadX = 0;
  private gamepadY = 0;
  private gamepadThrottleAxis = 0;
  private pendingInputEvents: number[] = [];
  private latencySamples = 0;
  private latencyTotal = 0;
  private latencyMax = 0;
  private playtestLatencySamples = 0;
  private playtestLatencyTotal = 0;
  private playtestLatencyMax = 0;

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
  /** チュートリアル用: キーボード操縦キーを一度でも受け取ったか */
  flightInputUsed = false;
  /** チュートリアル用: アフターバーナーキーを一度でも受け取ったか */
  afterburnerUsed = false;

  /** ゲームパッドが接続され、入力を読めているか */
  get gamepadConnected(): boolean {
    return !!this.gamepad;
  }

  rumble(strength = 0.35, durationMs = 90): void {
    if (!settings.gamepadRumble || !this.gamepad) return;
    const pad = this.gamepad as Gamepad & {
      vibrationActuator?: { playEffect: (type: string, options: Record<string, number>) => Promise<unknown> };
    };
    try {
      void pad.vibrationActuator?.playEffect('dual-rumble', {
        duration: durationMs,
        strongMagnitude: Math.max(0, Math.min(1, strength)),
        weakMagnitude: Math.max(0, Math.min(1, strength * 0.7)),
      }).catch(() => undefined);
    } catch {
      // ブラウザやドライバによっては、未対応の振動APIが同期例外を投げる。
    }
  }

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
      if (this.shouldPreventDefault(ev.code)) ev.preventDefault();
      if (ev.repeat) {
        // リピートはスロットル等の押しっぱなし判定にだけ使う
        return;
      }
      if ([
        settings.keyBindings.pitchUp,
        settings.keyBindings.pitchDown,
        settings.keyBindings.yawLeft,
        settings.keyBindings.yawRight,
        settings.keyBindings.rollLeft,
        settings.keyBindings.rollRight,
      ].includes(ev.code)) this.flightInputUsed = true;
      if (ev.code === settings.keyBindings.afterburner) this.afterburnerUsed = true;
      this.keys.add(ev.code);
      if (!this.uiMode) this.recordInputEvent();
      this.handleEdge(ev);
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      this.keys.delete(ev.code);
    };
    const onBlur = () => {
      this.keys.clear();
      this.mouseButtons.clear();
      this.gamepadButtons.clear();
      this.pendingInputEvents.length = 0;
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
      this.recordInputEvent();
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
      this.recordInputEvent();
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

  resetTutorialInputFlags(): void {
    this.flightInputUsed = false;
    this.afterburnerUsed = false;
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
        break;
      case 'Escape':
        this.actions.push('menuCancel');
        break;
      default:
        break;
    }
    // メニュー中の Esc は ScreenHost がキャンセル／再開を処理する。
    // ここでも pause action を積むと、ポーズ画面から Esc で再開した直後に
    // 残留 action が再処理され、ポーズが即座に再表示されてしまう。
    if (!this.uiMode && this.bound('pause', code)) this.actions.push('pause');
    if (this.uiMode) {
      // 数字キーはメニューの直接選択に使うので通す
      if (code.startsWith('Digit')) {
        const n = Number(code.slice(5));
        if (n >= 1 && n <= 6) this.actions.push(`comms${n}` as InputAction);
      }
      return;
    }

    /*
     * 修飾キー付きの入力は「別の操作」として扱う (W7-6)。
     *
     * Alt+A / Alt+F / Alt+R は僚機命令だが、`EDGE_BINDINGS` は修飾キーを見ないので
     * ここで分けないと Alt+A でオートパイロットも同時に走ってしまう。
     * 脱出が Alt/Ctrl + E をロール (KeyE) と二重に走らせない現状の作りとも整合する。
     */
    const modified = ev.altKey || ev.ctrlKey;
    if (!modified) {
      for (const [binding, action] of EDGE_BINDINGS) {
        if (this.bound(binding, code)) this.actions.push(action);
      }
    }
    // 脱出は誤操作が致命的なので、従来どおり Alt/Ctrl + E に固定する。
    if (code === 'KeyE' && modified) this.actions.push('eject');
    // 僚機命令の Alt 系ショートカット。数字キー経路と同じ action を積むので、
    // 実際の処理は `Game.handleActions()` の 1 か所のまま。
    if (ev.altKey && !ev.ctrlKey) {
      const index = ALT_WING_ORDERS[code];
      if (index !== undefined) {
        ev.preventDefault();
        this.actions.push(`comms${index}` as InputAction);
      }
    }
    if (modified) return;
    if (this.bound('throttleMax', code)) this.throttle = 1;
    if (this.bound('throttleStop', code)) this.throttle = 0;
    // キーを短くタップした場合も操作として成立させる。押しっぱなし時は
    // update() の連続入力も加わるため、細かい調整と大きな変更の両方に対応できる。
    if (this.throttleKeyHit('throttleUp', code)) this.throttle = clamp01(this.throttle + THROTTLE_KEY_STEP);
    if (this.throttleKeyHit('throttleDown', code)) this.throttle = clamp01(this.throttle - THROTTLE_KEY_STEP);

    if (code.startsWith('Digit')) {
      const n = Number(code.slice(5));
      if (!Number.isFinite(n)) return;
      if (this.commsMode && n >= 1 && n <= 6) {
        this.actions.push(`comms${n}` as InputAction);
      } else if (!this.commsMode) {
        this.throttle = n === 0 ? 0 : clamp01(n / 10);
      }
    }
  }

  /** 毎フレーム、保持系入力を更新する */
  update(dt: number): void {
    this.pollGamepad();
    const now = performance.now();
    for (const eventAt of this.pendingInputEvents) {
      const latency = Math.max(0, now - eventAt);
      this.latencySamples += 1;
      this.latencyTotal += latency;
      this.latencyMax = Math.max(this.latencyMax, latency);
      this.playtestLatencySamples += 1;
      this.playtestLatencyTotal += latency;
      this.playtestLatencyMax = Math.max(this.playtestLatencyMax, latency);
    }
    this.pendingInputEvents.length = 0;
    if (this.uiMode) return;
    const up = this.throttleKeyHeld('throttleUp');
    const down = this.throttleKeyHeld('throttleDown');
    if (up) this.throttle = clamp01(this.throttle + THROTTLE_KEY_RATE * dt);
    if (down) this.throttle = clamp01(this.throttle - THROTTLE_KEY_RATE * dt);
    if (this.gamepad && settings.gamepadThrottle && this.gamepadThrottleAxis !== 0) {
      // 右スティック縦軸をアナログスロットルとして使う。中央が 50% なので、
      // パッドを離したときは、直前のスロットル値を保持する。
      this.throttle = clamp01(0.5 - this.gamepadThrottleAxis * 0.5);
    }
  }

  /**
   * エッジ入力を外から1件積む (お手本モードが人間と同じ経路で操作するため)。
   * 実際の処理は `Game.handleActions()` が受け持つので、
   * 「お手本が押した」と「人が押した」で結果が変わらない。
   */
  pushAction(action: InputAction): void {
    this.actions.push(action);
  }

  /** 溜まったエッジ入力を取り出す (取り出すと消える) */
  consumeActions(): InputAction[] {
    if (this.actions.length === 0) return EMPTY;
    const out = this.actions;
    this.actions = [];
    return out;
  }

  get latencyTelemetry(): { samples: number; averageMs: number; maxMs: number } {
    return {
      samples: this.latencySamples,
      averageMs: this.latencySamples ? this.latencyTotal / this.latencySamples : 0,
      maxMs: this.latencyMax,
    };
  }

  /** 通しプレイ記録用に、前回の固定ステップ以降の入力遅延だけを取り出す。 */
  drainPlaytestLatency(): { samples: number; averageMs: number; maxMs: number } {
    const result = {
      samples: this.playtestLatencySamples,
      averageMs: this.playtestLatencySamples
        ? this.playtestLatencyTotal / this.playtestLatencySamples
        : 0,
      maxMs: this.playtestLatencyMax,
    };
    this.playtestLatencySamples = 0;
    this.playtestLatencyTotal = 0;
    this.playtestLatencyMax = 0;
    return result;
  }

  /** -1..1 (+ = 機首上げ) */
  get pitch(): number {
    // 代行入力は既にゲーム側の規約 (+ = 機首上げ) なので、Y反転設定は掛けない
    if (this.scripted) return clamp(this.scripted.pitch, -1, 1);
    let v = 0;
    if (this.keys.has(settings.keyBindings.pitchUp)) v += 1;
    if (this.keys.has(settings.keyBindings.pitchDown)) v -= 1;
    if (v === 0 && this.mouseFlight && this.mouseActive && this.mouseArmed) {
      v = -this.stickY();
    } else if (v === 0 && this.gamepad) {
      v = -this.gamepadY;
    }
    return clamp(settings.invertY ? -v : v, -1, 1);
  }

  /** -1..1 (+ = 右) */
  get yaw(): number {
    if (this.scripted) return clamp(this.scripted.yaw, -1, 1);
    let v = 0;
    if (this.keys.has(settings.keyBindings.yawRight)) v += 1;
    if (this.keys.has(settings.keyBindings.yawLeft)) v -= 1;
    if (v === 0 && this.mouseFlight && this.mouseActive && this.mouseArmed) {
      v = this.stickX();
    } else if (v === 0 && this.gamepad) {
      v = this.gamepadX;
    }
    return clamp(v, -1, 1);
  }

  /** -1..1 (+ = 右ロール) */
  get roll(): number {
    if (this.scripted) return clamp(this.scripted.roll, -1, 1);
    let v = 0;
    if (this.keys.has(settings.keyBindings.rollRight)) v += 1;
    if (this.keys.has(settings.keyBindings.rollLeft)) v -= 1;
    if (v === 0 && this.gamepad) {
      if (this.gamepadHeld(4)) v -= 1; // LB
      if (this.gamepadHeld(5)) v += 1; // RB
    }
    return v;
  }

  /** マウススティックが操縦に効いているか */
  get mouseStickEnabled(): boolean {
    return this.mouseFlight && this.mouseActive && this.mouseArmed;
  }

  /** マウスまたはゲームパッドのスティックが操縦に効いているか */
  get stickEnabled(): boolean {
    return this.mouseStickEnabled || !!this.gamepad;
  }

  /** ミッション開始時など、いったんマウス操縦を切っておく */
  disarmMouse(): void {
    this.mouseArmed = false;
  }

  get afterburner(): boolean {
    if (this.scripted) return this.scripted.afterburner;
    return this.keys.has(settings.keyBindings.afterburner) || this.gamepadHeld(10);
  }

  /**
   * 後方視点キーを押しているか (W7-7)。
   *
   * エッジ入力ではなく押しっぱなしで読む (アフターバーナーと同じ扱い)。
   * `onBlur` で `keys` を空にするので、押したままタブを離れても前向きへ戻る。
   */
  get rearView(): boolean {
    return this.keys.has(settings.keyBindings.rearView);
  }

  get firePrimary(): boolean {
    if (this.scripted) return this.scripted.firePrimary;
    return this.keys.has(settings.keyBindings.firePrimary) || this.mouseButtons.has(0) || this.gamepadValue(7) > 0.12;
  }

  /** 仮想スティックの水平量 (デッドゾーン付き) */
  stickX(): number {
    return stick(this.mouseNx) * settings.mouseSensitivity;
  }

  stickY(): number {
    return stick(this.mouseNy) * settings.mouseSensitivity;
  }

  /** 設定画面のキー割り当てで使う、人間向けの表示名。 */
  static keyLabel(code: string): string {
    return KEY_LABELS[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '数字 ');
  }

  private bound(binding: ControlBinding, code: string): boolean {
    return settings.keyBindings[binding] === code;
  }

  /** 速度設定キー (別名込み) が押されたか。単押しの判定に使う。 */
  private throttleKeyHit(binding: 'throttleUp' | 'throttleDown', code: string): boolean {
    if (this.bound(binding, code)) return true;
    // 割り当てを変えている人には別名を効かせない
    if (settings.keyBindings[binding] !== DEFAULT_KEY_BINDINGS[binding]) return false;
    return THROTTLE_ALIASES[binding].includes(code);
  }

  /** 速度設定キー (別名込み) を押しているか。押しっぱなしの判定に使う。 */
  private throttleKeyHeld(binding: 'throttleUp' | 'throttleDown'): boolean {
    if (this.keys.has(settings.keyBindings[binding])) return true;
    if (settings.keyBindings[binding] !== DEFAULT_KEY_BINDINGS[binding]) return false;
    return THROTTLE_ALIASES[binding].some((code) => this.keys.has(code));
  }

  private shouldPreventDefault(code: string): boolean {
    if (
      code === 'Tab' ||
      code === 'Space' ||
      code === 'Enter' ||
      code === 'NumpadEnter' ||
      code === 'Escape' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Backquote' ||
      code === 'Backspace' ||
      code === 'Equal' ||
      code === 'Minus' ||
      code === 'NumpadAdd' ||
      code === 'NumpadSubtract' ||
      // 速度設定の別名 (W7-2)。既定が `+` `-` になったので、`]` `[` は
      // keyBindings に載らなくなった。ブラウザ既定動作を出さないため明示する。
      code === 'BracketRight' ||
      code === 'BracketLeft' ||
      code.startsWith('Digit')
    ) {
      return true;
    }
    return Object.values(settings.keyBindings).includes(code);
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = Array.from(pads).find((p): p is Gamepad => !!p && p.connected);
    if (!pad) {
      this.gamepad = undefined;
      this.gamepadButtons.clear();
      this.gamepadX = 0;
      this.gamepadY = 0;
      this.gamepadThrottleAxis = 0;
      return;
    }

    this.gamepad = pad;
    this.gamepadX = axis(pad.axes[0] ?? 0) * settings.gamepadSensitivity;
    this.gamepadY = axis(pad.axes[1] ?? 0) * settings.gamepadSensitivity;
    this.gamepadThrottleAxis = axis(pad.axes[3] ?? 0);

    const pressed = new Set<number>();
    pad.buttons.forEach((button, index) => {
      if (button.pressed || button.value > 0.5) pressed.add(index);
    });
    for (const index of pressed) {
      if (this.gamepadButtons.has(index)) continue;
      this.handleGamepadEdge(index);
    }
    this.gamepadButtons = pressed;
  }

  private handleGamepadEdge(index: number): void {
    if (this.uiMode) {
      switch (index) {
        case 12:
          this.actions.push('menuUp');
          break;
        case 13:
          this.actions.push('menuDown');
          break;
        case 14:
          this.actions.push('menuLeft');
          break;
        case 15:
          this.actions.push('menuRight');
          break;
        case 0:
          this.actions.push('menuConfirm');
          break;
        case 1:
          this.actions.push('menuCancel');
          break;
      }
      return;
    }
    this.recordInputEvent();
    switch (index) {
      case 0: // A
      case 6: // LT
        this.actions.push('fireMissile');
        break;
      case 1: // B
        this.actions.push('flare');
        break;
      case 2: // X
        this.actions.push('targetNext');
        break;
      case 3: // Y
        this.actions.push('targetNearest');
        break;
      case 8: // View / Back
        this.actions.push('navMap');
        break;
      case 9: // Menu / Start
        this.actions.push('pause');
        break;
      case 11: // R3
        this.actions.push('targetFront');
        break;
    }
  }

  private gamepadValue(index: number): number {
    return this.gamepad?.buttons[index]?.value ?? 0;
  }

  private gamepadHeld(index: number): boolean {
    return this.gamepadButtons.has(index);
  }

  private recordInputEvent(): void {
    this.pendingInputEvents.push(performance.now());
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
const MOUSE_AIM_ORIGIN_Y = AIM_ORIGIN_Y;

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

function axis(n: number): number {
  const a = Math.abs(n);
  const dead = settings.gamepadDeadzone;
  if (a <= dead) return 0;
  const t = clamp01((a - dead) / Math.max(0.01, 1 - dead));
  const shaped = t * t * 0.45 + t * 0.55;
  return Math.sign(n) * shaped;
}

const EDGE_BINDINGS: Array<[ControlBinding, InputAction]> = [
  ['fireMissile', 'fireMissile'],
  ['manualLock', 'manualLock'],
  ['speedMatch', 'speedMatch'],
  ['targetNext', 'targetNext'],
  ['targetNearest', 'targetNearest'],
  ['targetFront', 'targetFront'],
  ['targetReticle', 'targetReticle'],
  ['autopilot', 'autopilot'],
  ['comms', 'comms'],
  ['damageDisplay', 'damageDisplay'],
  ['hudPanelToggle', 'hudPanelToggle'],
  ['viewToggle', 'viewToggle'],
  ['navMap', 'navMap'],
  ['nextSecondary', 'nextSecondary'],
  ['flare', 'flare'],
  ['mouseToggle', 'mouseToggle'],
  ['flightModeToggle', 'flightModeToggle'],
];

const KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Tab: 'Tab',
  Escape: 'Esc',
  Backquote: '`',
  Backspace: 'Backspace',
  KeyV: 'V',
  BracketRight: ']',
  BracketLeft: '[',
  // 速度設定のキーとして読ませるので、`=` ではなく `+` と出す (W7-2)
  Equal: '+',
  Minus: '-',
  Semicolon: ';',
  Slash: '/',
};
