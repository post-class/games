/** 論理アクション。物理キーから独立させ、将来のリバインドを容易にする。 */
export type Action =
  | "pitchUp"
  | "pitchDown"
  | "yawLeft"
  | "yawRight"
  | "rollLeft"
  | "rollRight"
  | "throttleUp"
  | "throttleDown"
  | "throttleFull"
  | "throttleZero"
  | "afterburner"
  | "firePrimary"
  | "fireMissile"
  | "dropFlare"
  | "cycleSecondary"
  | "toggleFlightAssist"
  | "cycleTargetNext"
  | "cycleTargetNearest"
  | "targetFront"
  | "cmdFormUp"
  | "cmdAttackTarget"
  | "cmdEngage";

/**
 * デフォルトキーバインド (ウィングコマンダー方式 / キーボードのみ)。
 * KeyboardEvent.code -> Action。
 *
 * - 操縦(機首)は方向キー。上=機首上げ(上昇), 下=機首下げ(降下), 左右=ヨー。
 * - WASD も同義キーとして併用可能。
 * - スロットルはレバー式: [ / ] で増減、Backspace=全停止、` (Backquote)=全速。
 * - アフターバーナーは Tab (押し続け)。主砲は Space、ミサイルは Enter。
 */
export const DEFAULT_BINDINGS: Record<string, Action> = {
  // 機首操作 (方向キー)。
  ArrowUp: "pitchUp",
  ArrowDown: "pitchDown",
  ArrowLeft: "yawLeft",
  ArrowRight: "yawRight",
  // WASD 併用。
  KeyW: "pitchUp",
  KeyS: "pitchDown",
  KeyA: "yawLeft",
  KeyD: "yawRight",
  // ロール。
  KeyQ: "rollLeft",
  KeyE: "rollRight",
  // スロットル。
  BracketRight: "throttleUp", // ]
  BracketLeft: "throttleDown", // [
  Backquote: "throttleFull", // `
  Backspace: "throttleZero", // 全停止
  // 兵装。
  Tab: "afterburner",
  Space: "firePrimary",
  Enter: "fireMissile",
  KeyC: "dropFlare",
  KeyX: "cycleSecondary",
  // ターゲッティング。
  KeyT: "cycleTargetNext",
  KeyR: "cycleTargetNearest",
  KeyY: "targetFront",
  // モード切替 (WCアーケード ⇄ ニュートン慣性)。
  KeyZ: "toggleFlightAssist",
  // 僚機コマンド。
  Comma: "cmdFormUp", // , 編隊を組め
  Period: "cmdAttackTarget", // . 私の敵を攻撃
  Slash: "cmdEngage", // / 自由に交戦
} as const;

/**
 * 数字キーでスロットルを割合指定 (WC風)。Digit1..9 -> 10%..90%, Digit0 -> 0%。
 * (code -> 0..1)
 */
export const THROTTLE_PRESET_KEYS: Record<string, number> = {
  Digit0: 0,
  Digit1: 0.1,
  Digit2: 0.2,
  Digit3: 0.3,
  Digit4: 0.4,
  Digit5: 0.5,
  Digit6: 0.6,
  Digit7: 0.7,
  Digit8: 0.8,
  Digit9: 0.9,
} as const;
