import type { FlightMode } from '../sim/flight';

export type DifficultyId = 'easy' | 'normal' | 'hard';

/** キー割り当てで変更できる操作。メニューの上下左右は固定する。 */
export type ControlBinding =
  | 'pitchUp'
  | 'pitchDown'
  | 'yawLeft'
  | 'yawRight'
  | 'rollLeft'
  | 'rollRight'
  | 'afterburner'
  | 'firePrimary'
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
  | 'pause'
  | 'throttleMax'
  | 'throttleStop'
  | 'throttleUp'
  | 'throttleDown';

export type KeyBindings = Record<ControlBinding, string>;

/** 設定画面に表示する操作の順番とラベル。 */
export const CONTROL_BINDINGS: Array<{ id: ControlBinding; label: string }> = [
  { id: 'pitchUp', label: '機首上げ' },
  { id: 'pitchDown', label: '機首下げ' },
  { id: 'yawLeft', label: 'ヨー左' },
  { id: 'yawRight', label: 'ヨー右' },
  { id: 'rollLeft', label: 'ロール左' },
  { id: 'rollRight', label: 'ロール右' },
  { id: 'afterburner', label: 'アフターバーナー' },
  { id: 'firePrimary', label: '主砲' },
  { id: 'fireMissile', label: 'ミサイル' },
  { id: 'targetNext', label: 'ターゲット 次' },
  { id: 'targetNearest', label: 'ターゲット 最至近' },
  { id: 'targetFront', label: 'ターゲット 正面' },
  { id: 'autopilot', label: 'オートパイロット' },
  { id: 'comms', label: '通信メニュー' },
  { id: 'damageDisplay', label: '被害状況' },
  { id: 'viewToggle', label: '視点切替' },
  { id: 'navMap', label: 'Nav マップ' },
  { id: 'nextSecondary', label: '副兵装切替' },
  { id: 'flare', label: 'フレア' },
  { id: 'mouseToggle', label: 'マウス操縦 ON/OFF' },
  { id: 'flightModeToggle', label: '飛行モード切替' },
  { id: 'pause', label: 'ポーズ' },
  { id: 'throttleMax', label: '全速' },
  { id: 'throttleStop', label: '停止' },
  { id: 'throttleUp', label: 'スロットル増' },
  { id: 'throttleDown', label: 'スロットル減' },
];

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  pitchUp: 'ArrowUp',
  pitchDown: 'ArrowDown',
  yawLeft: 'ArrowLeft',
  yawRight: 'ArrowRight',
  rollLeft: 'KeyQ',
  rollRight: 'KeyE',
  afterburner: 'Tab',
  firePrimary: 'Space',
  fireMissile: 'Enter',
  targetNext: 'KeyT',
  targetNearest: 'KeyR',
  targetFront: 'KeyY',
  autopilot: 'KeyA',
  comms: 'KeyC',
  damageDisplay: 'KeyD',
  viewToggle: 'KeyF',
  navMap: 'KeyN',
  nextSecondary: 'KeyX',
  flare: 'KeyG',
  mouseToggle: 'KeyM',
  flightModeToggle: 'KeyZ',
  pause: 'Escape',
  throttleMax: 'Backquote',
  throttleStop: 'Backspace',
  throttleUp: 'BracketRight',
  throttleDown: 'BracketLeft',
};

export interface Settings {
  difficulty: DifficultyId;
  /** マウス操縦を使うか */
  mouseFlight: boolean;
  mouseSensitivity: number;
  invertY: boolean;
  /** ゲームパッドのスティック入力設定 */
  gamepadDeadzone: number;
  gamepadSensitivity: number;
  /** ゲームパッドの右スティック縦軸をアナログスロットルとして使う */
  gamepadThrottle: boolean;
  /** キーボード操作の割り当て */
  keyBindings: KeyBindings;
  /** 照準アシスト (リード表示の見やすさ / 微小な補正) */
  aimAssist: boolean;
  flightMode: FlightMode;
  /** 上級者向け操作 (飛行モード切替など) を露出するか */
  advanced: boolean;
  volumeMaster: number;
  volumeMusic: number;
  volumeSfx: number;
  /** 無線ログの表示時間 (秒)。読む速さに合わせて調整できる */
  radioDuration: number;
  /** 天蓋・ダッシュボードの見た目だけの装飾を表示するか */
  cockpitDecorations: boolean;
  /** カメラの揺れ、追従遅延、アフターバーナー画角の強さ (0 で無効) */
  cameraShake: number;
  cameraFollowLag: number;
  cameraFovKick: number;
  /** ブルームを表示するか */
  bloom: boolean;
  /** 閃光・画面点滅を抑える */
  reducedFlashes: boolean;
  /** 敵味方を色だけに頼らない高コントラスト配色 */
  colorblindMode: boolean;
  /** 無線字幕の大きさ */
  subtitleScale: number;
  /** 対応ゲームパッドの振動 */
  gamepadRumble: boolean;
  /** ロールを離したときに水平へ戻す補助 */
  autoLevel: boolean;
  /** 旋回補助。正面の目標へわずかに機首を寄せる */
  turnAssist: boolean;
  /** 被弾直後の短い時間減速 */
  timeSlowAssist: boolean;
  /** 訓練を見たか */
  tutorialDone: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  difficulty: 'normal',
  mouseFlight: true,
  mouseSensitivity: 1,
  invertY: false,
  gamepadDeadzone: 0.12,
  gamepadSensitivity: 1,
  gamepadThrottle: true,
  keyBindings: { ...DEFAULT_KEY_BINDINGS },
  aimAssist: true,
  flightMode: 'wc',
  advanced: false,
  volumeMaster: 0.8,
  volumeMusic: 0.5,
  volumeSfx: 0.9,
  radioDuration: 9,
  cockpitDecorations: false,
  cameraShake: 1,
  cameraFollowLag: 1,
  cameraFovKick: 1,
  bloom: true,
  reducedFlashes: false,
  colorblindMode: false,
  subtitleScale: 1,
  gamepadRumble: true,
  autoLevel: false,
  turnAssist: false,
  timeSlowAssist: false,
  tutorialDone: false,
};

const KEY = 'multi-commander.settings.v1';

export const settings: Settings = {
  ...DEFAULT_SETTINGS,
  keyBindings: { ...DEFAULT_KEY_BINDINGS },
};

const listeners = new Set<(s: Settings) => void>();

export function loadSettings(): void {
  const loaded: Settings = {
    ...DEFAULT_SETTINGS,
    keyBindings: { ...DEFAULT_KEY_BINDINGS },
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      for (const k of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
        if (k === 'keyBindings') continue;
        if (parsed[k] !== undefined) {
          (loaded as unknown as Record<string, unknown>)[k] = parsed[k];
        }
      }
      loaded.keyBindings = mergeKeyBindings(DEFAULT_KEY_BINDINGS, parsed.keyBindings);
    }
    Object.assign(settings, loaded);
    normalizeSettings();
  } catch {
    /* 壊れた保存データは無視して既定値で動かす */
    Object.assign(settings, loaded);
  }
}

export function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* プライベートブラウジング等で保存できなくてもゲームは続行する */
  }
}

export function updateSettings(patch: Partial<Settings>): void {
  const { keyBindings, ...values } = patch;
  Object.assign(settings, values);
  if (keyBindings !== undefined) {
    settings.keyBindings = mergeKeyBindings(settings.keyBindings, keyBindings);
  }
  normalizeSettings();
  saveSettings();
  for (const l of listeners) l(settings);
}

export function resetSettings(): void {
  Object.assign(settings, DEFAULT_SETTINGS, { keyBindings: { ...DEFAULT_KEY_BINDINGS } });
  saveSettings();
  for (const l of listeners) l(settings);
}

export function onSettingsChanged(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** localStorage から来た値が壊れていても、入力と描画が暴れないようにする。 */
function normalizeSettings(): void {
  settings.keyBindings = mergeKeyBindings(DEFAULT_KEY_BINDINGS, settings.keyBindings);
  if (!['easy', 'normal', 'hard'].includes(settings.difficulty)) {
    settings.difficulty = DEFAULT_SETTINGS.difficulty;
  }
  if (settings.flightMode !== 'wc' && settings.flightMode !== 'newton') {
    settings.flightMode = DEFAULT_SETTINGS.flightMode;
  }
  settings.mouseSensitivity = clampSetting(settings.mouseSensitivity, 0.3, 2.5, 1);
  settings.gamepadDeadzone = clampSetting(settings.gamepadDeadzone, 0, 0.4, 0.12);
  settings.gamepadSensitivity = clampSetting(settings.gamepadSensitivity, 0.3, 2.5, 1);
  settings.cameraShake = clampSetting(settings.cameraShake, 0, 1, 1);
  settings.cameraFollowLag = clampSetting(settings.cameraFollowLag, 0, 1, 1);
  settings.cameraFovKick = clampSetting(settings.cameraFovKick, 0, 1, 1);
  settings.radioDuration = clampSetting(settings.radioDuration, 4, 20, 9);
  settings.volumeMaster = clampSetting(settings.volumeMaster, 0, 1, 0.8);
  settings.volumeMusic = clampSetting(settings.volumeMusic, 0, 1, 0.5);
  settings.volumeSfx = clampSetting(settings.volumeSfx, 0, 1, 0.9);
  for (const key of [
    'mouseFlight',
    'invertY',
    'aimAssist',
    'advanced',
    'cockpitDecorations',
    'tutorialDone',
  ] as const) {
    if (typeof settings[key] !== 'boolean') settings[key] = DEFAULT_SETTINGS[key];
  }
  if (typeof settings.gamepadThrottle !== 'boolean') settings.gamepadThrottle = true;
  if (typeof settings.bloom !== 'boolean') settings.bloom = true;
  for (const key of ['reducedFlashes', 'colorblindMode', 'gamepadRumble', 'autoLevel', 'turnAssist', 'timeSlowAssist'] as const) {
    if (typeof settings[key] !== 'boolean') settings[key] = DEFAULT_SETTINGS[key];
  }
  settings.subtitleScale = clampSetting(settings.subtitleScale, 0.8, 1.8, 1);
}

function clampSetting(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function mergeKeyBindings(base: unknown, incoming: unknown): KeyBindings {
  const merged = { ...DEFAULT_KEY_BINDINGS };
  const apply = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const values = value as Partial<KeyBindings>;
    for (const key of Object.keys(DEFAULT_KEY_BINDINGS) as ControlBinding[]) {
      const code = values[key];
      if (typeof code === 'string' && code.trim().length > 0) merged[key] = code.trim();
    }
  };
  apply(base);
  apply(incoming);
  return merged;
}

// ───────── 難易度プロファイル ─────────

export interface DifficultyProfile {
  id: DifficultyId;
  label: string;
  /** 敵 AI の技量 (0..1) */
  enemySkill: number;
  /** プレイヤーの被ダメージ倍率 */
  playerDamageTaken: number;
  /** プレイヤーの与ダメージ倍率 */
  playerDamageDealt: number;
  /** 同時にプレイヤーを攻撃できる敵の数 */
  maxAttackers: number;
  /** リードレティクルの補助を強めるか */
  strongAimHelp: boolean;
  /** 敵ウェーブの投入を遅らせる秒数 */
  waveDelayBonus: number;
  /** アフターバーナー燃料倍率 */
  fuelScale: number;
  /** 敵のミサイル使用頻度倍率 */
  enemyMissileRate: number;
  /**
   * プレイヤー機の部位故障の発生率倍率。
   * 部位損傷は強力なので、難易度でここを絞らないと「ふつう」が急に厳しくなる。
   */
  playerSubsystemRate: number;
}

export const DIFFICULTIES: Record<DifficultyId, DifficultyProfile> = {
  easy: {
    id: 'easy',
    label: 'やさしい',
    enemySkill: 0.3,
    playerDamageTaken: 0.55,
    playerDamageDealt: 1.35,
    maxAttackers: 1,
    strongAimHelp: true,
    waveDelayBonus: 12,
    fuelScale: 1.6,
    enemyMissileRate: 0.4,
    playerSubsystemRate: 0.35,
  },
  normal: {
    id: 'normal',
    label: 'ふつう',
    enemySkill: 0.58,
    playerDamageTaken: 1,
    playerDamageDealt: 1,
    maxAttackers: 2,
    strongAimHelp: false,
    waveDelayBonus: 4,
    fuelScale: 1,
    enemyMissileRate: 1,
    playerSubsystemRate: 0.7,
  },
  hard: {
    id: 'hard',
    label: 'むずかしい',
    enemySkill: 0.8,
    playerDamageTaken: 1.2,
    playerDamageDealt: 0.9,
    maxAttackers: 3,
    strongAimHelp: false,
    waveDelayBonus: 0,
    fuelScale: 0.85,
    enemyMissileRate: 1.4,
    playerSubsystemRate: 1.15,
  },
};

export function difficulty(): DifficultyProfile {
  return DIFFICULTIES[settings.difficulty] ?? DIFFICULTIES.normal;
}
