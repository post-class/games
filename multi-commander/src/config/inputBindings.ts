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
  | "cmdEngage"
  | "toggleMouseFlight"
  | "pause";

/** 入力コンテキスト。画面状態に応じて有効なアクション種別を切り替える。 */
export type InputContext = "combat" | "menu" | "loadout" | "paused";

/** コンテキストごとに有効なアクションカテゴリ。 */
export interface ContextConfig {
  flight: boolean;
  combat: boolean;
  targeting: boolean;
  ui: boolean;
}

export const CONTEXT_RULES: Record<InputContext, ContextConfig> = {
  combat: { flight: true, combat: true, targeting: true, ui: false },
  menu: { flight: false, combat: false, targeting: false, ui: true },
  loadout: { flight: false, combat: false, targeting: false, ui: true },
  paused: { flight: false, combat: false, targeting: false, ui: true },
};

/** 表示用メタデータ付きのバインド定義。1エントリは1つ以上の物理キーを1つの Action に割り当てる。 */
export interface BindingEntry {
  /** KeyboardEvent.code の一覧 (同義キー併用可)。 */
  codes: string[];
  action: Action;
  /** 設定画面に表示するキー表記。 */
  keyLabel: string;
  /** 設定画面に表示するアクション説明。 */
  actionLabel: string;
  /** マウス操作の併用がある場合の表記。 */
  mouseLabel?: string;
  /** 設定画面の一覧から隠す (既定 true)。 */
  visible?: boolean;
  /** 高度な飛行設定 (慣性モード等) が有効な時のみ表示。 */
  advancedOnly?: boolean;
}

/**
 * デフォルトキーバインド (ウィングコマンダー方式 / キーボードのみ)。
 * BINDINGS から `code -> action` の対応表を自動生成する。
 *
 * - 操縦(機首)は方向キー。上=機首上げ(上昇), 下=機首下げ(降下), 左右=ヨー。
 * - WASD も同義キーとして併用可能。
 * - スロットルはレバー式: [ / ] または - / = で増減、Backspace=全停止、` (Backquote)=全速。
 * - アフターバーナーは Tab (押し続け)。主砲は Space、ミサイルは Enter。
 */
export const BINDINGS: BindingEntry[] = [
  { codes: ["ArrowUp", "KeyW"], action: "pitchUp", keyLabel: "↑ / W", actionLabel: "機首上げ" },
  { codes: ["ArrowDown", "KeyS"], action: "pitchDown", keyLabel: "↓ / S", actionLabel: "機首下げ" },
  { codes: ["ArrowLeft", "KeyA"], action: "yawLeft", keyLabel: "← / A", actionLabel: "左旋回 (ヨー)" },
  { codes: ["ArrowRight", "KeyD"], action: "yawRight", keyLabel: "→ / D", actionLabel: "右旋回 (ヨー)" },
  { codes: ["KeyQ"], action: "rollLeft", keyLabel: "Q", actionLabel: "ロール 左" },
  { codes: ["KeyE"], action: "rollRight", keyLabel: "E", actionLabel: "ロール 右" },
  {
    codes: ["BracketRight", "Equal"],
    action: "throttleUp",
    keyLabel: "] / =",
    actionLabel: "スロットル増",
    mouseLabel: "ホイール上",
  },
  {
    codes: ["BracketLeft", "Minus"],
    action: "throttleDown",
    keyLabel: "[ / -",
    actionLabel: "スロットル減",
    mouseLabel: "ホイール下",
  },
  { codes: ["Backquote"], action: "throttleFull", keyLabel: "`", actionLabel: "スロットル全開" },
  { codes: ["Backspace"], action: "throttleZero", keyLabel: "Backspace", actionLabel: "スロットル全停止" },
  { codes: ["Tab"], action: "afterburner", keyLabel: "Tab", actionLabel: "アフターバーナー (押し続け)" },
  { codes: ["Space"], action: "firePrimary", keyLabel: "Space", actionLabel: "エネルギー砲", mouseLabel: "左クリック" },
  { codes: ["Enter"], action: "fireMissile", keyLabel: "Enter", actionLabel: "ミサイル発射", mouseLabel: "右クリック" },
  { codes: ["KeyC"], action: "dropFlare", keyLabel: "C", actionLabel: "フレア射出" },
  { codes: ["KeyX"], action: "cycleSecondary", keyLabel: "X", actionLabel: "副兵装切替" },
  { codes: ["KeyT"], action: "cycleTargetNext", keyLabel: "T", actionLabel: "ターゲット 次" },
  { codes: ["KeyR"], action: "cycleTargetNearest", keyLabel: "R", actionLabel: "ターゲット 最至近" },
  { codes: ["KeyY"], action: "targetFront", keyLabel: "Y", actionLabel: "ターゲット 前方" },
  {
    codes: ["KeyZ"],
    action: "toggleFlightAssist",
    keyLabel: "Z",
    actionLabel: "操作モード切替 (WC ⇄ 慣性)",
    advancedOnly: true,
  },
  { codes: ["Comma"], action: "cmdFormUp", keyLabel: ",", actionLabel: "僚機: 編隊を組め" },
  { codes: ["Period"], action: "cmdAttackTarget", keyLabel: ".", actionLabel: "僚機: 私の敵を攻撃せよ" },
  { codes: ["Slash"], action: "cmdEngage", keyLabel: "/", actionLabel: "僚機: 自由に交戦せよ" },
  { codes: ["KeyM"], action: "toggleMouseFlight", keyLabel: "M", actionLabel: "マウス操縦切替" },
  { codes: ["Escape"], action: "pause", keyLabel: "Esc", actionLabel: "一時停止" },
];

/** BINDINGS から自動生成される `code -> action` の対応表 (後方互換維持)。 */
export const DEFAULT_BINDINGS: Record<string, Action> = BINDINGS.reduce<Record<string, Action>>(
  (acc, entry) => {
    for (const code of entry.codes) acc[code] = entry.action;
    return acc;
  },
  {},
);

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
