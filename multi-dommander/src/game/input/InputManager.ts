import { DEFAULT_BINDINGS, THROTTLE_PRESET_KEYS, type Action } from "../../config/inputBindings";
import { MouseFlightStick } from "./MouseFlightStick";

/** 連続値の飛行軸。各 -1..1 (throttle は 0..1)。 */
export interface FlightAxes {
  pitch: number;
  yaw: number;
  roll: number;
  throttle: number;
}

/** 押下状態のアクション。 */
export interface DiscreteActions {
  afterburner: boolean;
  firePrimary: boolean;
  fireMissile: boolean;
}

/** エッジ検出付きの1回だけ発火するアクション。 */
export interface EdgeActions {
  toggleFlightAssist: boolean;
  cycleTargetNext: boolean;
  cycleTargetNearest: boolean;
  targetFront: boolean;
}

/**
 * キーボード入力を集約し、論理的な入力状態に正規化する (キーボードのみで完結)。
 * マウス操縦は既定で無効。将来ゲームパッドを poll() 内で合成する余地も残す。
 */
export class InputManager {
  private readonly pressed = new Set<Action>();
  /** このフレームで新たに押されたアクション (エッジ)。 */
  private readonly justPressed = new Set<Action>();
  private throttle = 0;
  /** 数字キー等で要求された絶対スロットル値 (次サンプルで反映)。 */
  private throttleRequest: number | null = null;
  /** マウス操縦 (既定オフ = キーボードのみ)。 */
  readonly mouse: MouseFlightStick;

  constructor(private readonly target: HTMLElement) {
    this.mouse = new MouseFlightStick(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    this.mouse.enabled = false;
    this.attach();
  }

  private attach(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    // フォーカス外れ時に入力を解除して暴走を防ぐ。
    window.addEventListener("blur", () => this.pressed.clear());
    this.target.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // 数字キーによるスロットル割合指定。
    const preset = THROTTLE_PRESET_KEYS[e.code];
    if (preset !== undefined) {
      this.throttleRequest = preset;
      e.preventDefault();
      return;
    }

    const action = DEFAULT_BINDINGS[e.code];
    if (!action) return;
    // バインド済みキーはブラウザ既定動作 (スクロール/戻る/フォーカス移動) を抑止。
    e.preventDefault();
    if (!this.pressed.has(action)) this.justPressed.add(action);
    this.pressed.add(action);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const action = DEFAULT_BINDINGS[e.code];
    if (action) this.pressed.delete(action);
  };

  /** スロットルを更新して連続軸を返す。dt で throttle 変化速度を制御。 */
  sampleAxes(dt: number): FlightAxes {
    // 絶対指定 (数字キー / 全速 / 全停止) を優先反映。
    if (this.throttleRequest !== null) {
      this.throttle = this.throttleRequest;
      this.throttleRequest = null;
    }
    if (this.pressed.has("throttleFull")) this.throttle = 1;
    if (this.pressed.has("throttleZero")) this.throttle = 0;
    if (this.pressed.has("throttleUp")) this.throttle += dt * 0.8;
    if (this.pressed.has("throttleDown")) this.throttle -= dt * 0.8;
    this.throttle = clampUnit01(this.throttle);

    let pitch = 0;
    let yaw = 0;
    // 上キー = 機首上げ (上昇)。
    if (this.pressed.has("pitchUp")) pitch += 1;
    if (this.pressed.has("pitchDown")) pitch -= 1;
    if (this.pressed.has("yawLeft")) yaw -= 1;
    if (this.pressed.has("yawRight")) yaw += 1;

    // マウス操縦が有効な場合のみ加算合成 (既定は無効)。
    if (this.mouse.enabled) {
      const m = this.mouse.sample();
      pitch = clampUnit(pitch + m.pitch);
      yaw = clampUnit(yaw + m.yaw);
    }

    let roll = 0;
    if (this.pressed.has("rollLeft")) roll -= 1;
    if (this.pressed.has("rollRight")) roll += 1;

    return { pitch, yaw, roll, throttle: this.throttle };
  }

  sampleDiscrete(): DiscreteActions {
    return {
      afterburner: this.pressed.has("afterburner"),
      firePrimary: this.pressed.has("firePrimary"),
      fireMissile: this.pressed.has("fireMissile"),
    };
  }

  /** エッジアクションを取り出す。呼び出し側は毎フレーム clearEdges() すること。 */
  sampleEdges(): EdgeActions {
    return {
      toggleFlightAssist: this.justPressed.has("toggleFlightAssist"),
      cycleTargetNext: this.justPressed.has("cycleTargetNext"),
      cycleTargetNearest: this.justPressed.has("cycleTargetNearest"),
      targetFront: this.justPressed.has("targetFront"),
    };
  }

  get throttleValue(): number {
    return this.throttle;
  }

  clearEdges(): void {
    this.justPressed.clear();
  }
}

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function clampUnit01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
