import {
  DEFAULT_BINDINGS,
  THROTTLE_PRESET_KEYS,
  CONTEXT_RULES,
  type Action,
  type InputContext,
} from "../../config/inputBindings";
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
  dropFlare: boolean;
  cycleSecondary: boolean;
  toggleFlightAssist: boolean;
  cycleTargetNext: boolean;
  cycleTargetNearest: boolean;
  targetFront: boolean;
  cmdFormUp: boolean;
  cmdAttackTarget: boolean;
  cmdEngage: boolean;
  toggleMouseFlight: boolean;
  pause: boolean;
}

/** flight/combat/targeting カテゴリに属するアクション (ui はキーボード側では未使用)。 */
const FLIGHT_ACTIONS = new Set<Action>([
  "pitchUp",
  "pitchDown",
  "yawLeft",
  "yawRight",
  "rollLeft",
  "rollRight",
  "throttleUp",
  "throttleDown",
  "throttleFull",
  "throttleZero",
  "toggleFlightAssist",
  "toggleMouseFlight",
]);
const COMBAT_ACTIONS = new Set<Action>([
  "afterburner",
  "firePrimary",
  "fireMissile",
  "dropFlare",
  "cycleSecondary",
  "cmdFormUp",
  "cmdAttackTarget",
  "cmdEngage",
]);
const TARGETING_ACTIONS = new Set<Action>(["cycleTargetNext", "cycleTargetNearest", "targetFront"]);

/**
 * キーボード・マウス入力を集約し、論理的な入力状態に正規化する。
 * `context` (combat/menu/loadout/paused) に応じて有効なアクション種別を切り替え、
 * UI操作中の押しっぱなし入力が戦闘系アクションへ漏れ込むことを防ぐ。
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
  /** マウス操縦有効フラグ (toggleMouseFlight で切替、combat 中のみ実際に効く)。 */
  mouseFlightEnabled = true;
  /** 高度な飛行設定 (慣性モード切替など) を有効化するか。 */
  advancedFlightEnabled = false;

  private context: InputContext = "menu";

  /** 押されているマウスボタン (0=左, 2=右)。 */
  private readonly mouseButtons = new Set<number>();
  /** このフレームで新たに押されたマウスボタン (エッジ)。 */
  private readonly mouseJustPressed = new Set<number>();
  /** ホイール蓄積値 (deltaY の符号: +がスロットル down, -が up)。 */
  private wheelDelta = 0;

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
    // フォーカス外れ/非表示時に入力を解除して暴走を防ぐ。
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.target.addEventListener("contextmenu", this.onContextMenu);
    this.target.addEventListener("pointerdown", this.onPointerDown);
    this.target.addEventListener("pointerup", this.onPointerUp);
    this.target.addEventListener("pointermove", this.onPointerMove);
    this.target.addEventListener("pointerleave", this.onPointerLeave);
    this.target.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("resize", this.onResize);
  }

  /** イベントリスナを解除する。 */
  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.target.removeEventListener("contextmenu", this.onContextMenu);
    this.target.removeEventListener("pointerdown", this.onPointerDown);
    this.target.removeEventListener("pointerup", this.onPointerUp);
    this.target.removeEventListener("pointermove", this.onPointerMove);
    this.target.removeEventListener("pointerleave", this.onPointerLeave);
    this.target.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("resize", this.onResize);
  }

  /** 現在の入力コンテキストを取得。 */
  getContext(): InputContext {
    return this.context;
  }

  /** コンテキストを切替え、全押下状態をリセットする (取り残しによる暴発を防止)。 */
  setContext(ctx: InputContext): void {
    this.context = ctx;
    this.resetInputState();
  }

  private resetInputState(): void {
    this.pressed.clear();
    this.justPressed.clear();
    this.throttleRequest = null;
    this.mouseButtons.clear();
    this.mouseJustPressed.clear();
    this.wheelDelta = 0;
  }

  private onBlur = (): void => {
    this.resetInputState();
    this.mouse.resetToCenter();
  };
  private onVisibilityChange = (): void => {
    if (document.hidden) {
      this.resetInputState();
      this.mouse.resetToCenter();
    }
  };
  private onContextMenu = (e: Event): void => e.preventDefault();

  private onPointerDown = (e: PointerEvent): void => {
    if (this.context !== "combat") return;
    if (!this.mouseButtons.has(e.button)) this.mouseJustPressed.add(e.button);
    this.mouseButtons.add(e.button);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.context !== "combat") return;
    this.mouseButtons.delete(e.button);
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.mouse.onMouseMove(e.clientX, e.clientY);
  };

  private onPointerLeave = (): void => {
    this.mouseButtons.clear();
    this.mouseJustPressed.clear();
    this.mouse.resetToCenter();
  };

  private onResize = (): void => {
    this.mouse.resetToCenter();
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.context !== "combat") return;
    e.preventDefault();
    this.wheelDelta += e.deltaY;
  };

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

  private categoryEnabled(action: Action): boolean {
    const rules = CONTEXT_RULES[this.context];
    if (action === "pause") return this.context === "combat";
    if (action === "toggleFlightAssist" && !this.advancedFlightEnabled) return false;
    if (FLIGHT_ACTIONS.has(action)) return rules.flight;
    if (COMBAT_ACTIONS.has(action)) return rules.combat;
    if (TARGETING_ACTIONS.has(action)) return rules.targeting;
    return rules.ui;
  }

  private isPressed(action: Action): boolean {
    return this.categoryEnabled(action) && this.pressed.has(action);
  }

  private isJustPressed(action: Action): boolean {
    return this.categoryEnabled(action) && this.justPressed.has(action);
  }

  /** スロットルを更新して連続軸を返す。dt で throttle 変化速度を制御。 */
  sampleAxes(dt: number): FlightAxes {
    this.mouse.enabled = this.mouseFlightEnabled && this.context === "combat";
    if (!CONTEXT_RULES[this.context].flight) {
      return { pitch: 0, yaw: 0, roll: 0, throttle: 0 };
    }

    // 絶対指定 (数字キー / 全速 / 全停止) を優先反映。
    if (this.throttleRequest !== null) {
      this.throttle = this.throttleRequest;
      this.throttleRequest = null;
    }
    if (this.isPressed("throttleFull")) this.throttle = 1;
    if (this.isPressed("throttleZero")) this.throttle = 0;
    if (this.isPressed("throttleUp")) this.throttle += dt * 0.8;
    if (this.isPressed("throttleDown")) this.throttle -= dt * 0.8;
    // ホイール: +deltaY (下スクロール) でスロットル down, -deltaY で up。
    if (this.wheelDelta !== 0) {
      this.throttle -= this.wheelDelta * 0.0015;
      this.wheelDelta = 0;
    }
    this.throttle = clampUnit01(this.throttle);

    let pitch = 0;
    let yaw = 0;
    // 上キー = 機首上げ (上昇)。
    if (this.isPressed("pitchUp")) pitch += 1;
    if (this.isPressed("pitchDown")) pitch -= 1;
    if (this.isPressed("yawLeft")) yaw -= 1;
    if (this.isPressed("yawRight")) yaw += 1;

    // マウス操縦が有効な場合のみ加算合成 (既定は無効)。
    if (this.mouse.enabled) {
      const m = this.mouse.sample();
      pitch = clampUnit(pitch + m.pitch);
      yaw = clampUnit(yaw + m.yaw);
    }

    let roll = 0;
    if (this.isPressed("rollLeft")) roll -= 1;
    if (this.isPressed("rollRight")) roll += 1;

    return { pitch, yaw, roll, throttle: this.throttle };
  }

  sampleDiscrete(): DiscreteActions {
    const combatAllowed = CONTEXT_RULES[this.context].combat;
    const mouseFirePrimary = combatAllowed && this.mouseButtons.has(0);
    const mouseFireMissile = combatAllowed && this.mouseJustPressed.has(2);
    return {
      afterburner: this.isPressed("afterburner"),
      firePrimary: this.isPressed("firePrimary") || mouseFirePrimary,
      fireMissile: this.isPressed("fireMissile") || mouseFireMissile,
    };
  }

  /** エッジアクションを取り出す。呼び出し側は毎フレーム clearEdges() すること。 */
  sampleEdges(): EdgeActions {
    return {
      dropFlare: this.isJustPressed("dropFlare"),
      cycleSecondary: this.isJustPressed("cycleSecondary"),
      toggleFlightAssist: this.isJustPressed("toggleFlightAssist"),
      cycleTargetNext: this.isJustPressed("cycleTargetNext"),
      cycleTargetNearest: this.isJustPressed("cycleTargetNearest"),
      targetFront: this.isJustPressed("targetFront"),
      cmdFormUp: this.isJustPressed("cmdFormUp"),
      cmdAttackTarget: this.isJustPressed("cmdAttackTarget"),
      cmdEngage: this.isJustPressed("cmdEngage"),
      toggleMouseFlight: this.isJustPressed("toggleMouseFlight"),
      pause: this.isJustPressed("pause"),
    };
  }

  get throttleValue(): number {
    return this.throttle;
  }

  /** 出撃時などにスロットル初期値を直接設定する (Easyの initialThrottle 等)。 */
  setThrottle(v: number): void {
    this.throttle = clampUnit01(v);
  }

  clearEdges(): void {
    this.justPressed.clear();
    this.mouseJustPressed.clear();
  }
}

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function clampUnit01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
