import type { FlightMode } from '../sim/flight';
import {
  setMusicAssignment,
  isMusicChoice,
  isMusicCue,
  type MusicChoice,
  type MusicTrackId,
} from '../audio/musicCues';

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
  | 'hudPanelToggle'
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
  | 'throttleDown'
  // ───── 07_更なる改善 W7 で追加した操作 ─────
  /** ミサイルの手動ロック（設定「ミサイルロック: 手動」のときロックを進める） */
  | 'manualLock'
  /** 速度設定を目標の速度へ同期する */
  | 'speedMatch'
  /** 照準の射線上にいる相手をターゲットにする */
  | 'targetReticle'
  /** 押している間だけ後方を見る */
  | 'rearView';

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
  { id: 'manualLock', label: 'ミサイル手動ロック' },
  { id: 'targetNext', label: 'ターゲット 次' },
  { id: 'targetNearest', label: 'ターゲット 最至近' },
  { id: 'targetFront', label: 'ターゲット 正面' },
  { id: 'targetReticle', label: 'ターゲット 照準下' },
  { id: 'autopilot', label: 'オートパイロット' },
  { id: 'comms', label: '通信メニュー' },
  { id: 'damageDisplay', label: '被害状況' },
  { id: 'hudPanelToggle', label: 'HUD情報切替' },
  { id: 'viewToggle', label: '視点切替' },
  { id: 'rearView', label: '後方視点（押している間）' },
  { id: 'navMap', label: 'Nav マップ' },
  { id: 'nextSecondary', label: '副兵装切替' },
  { id: 'flare', label: 'フレア' },
  { id: 'mouseToggle', label: 'マウス操縦 ON/OFF' },
  { id: 'flightModeToggle', label: '飛行モード切替' },
  { id: 'pause', label: 'ポーズ' },
  // 用語は「速度設定」（目標速度の割合）で統一する。W7-1。
  // 推力割合を直接表す Newton 型の「スロットル」と混同しないため。
  { id: 'throttleMax', label: '速度設定 100%' },
  { id: 'throttleStop', label: '速度設定 0%' },
  { id: 'throttleUp', label: '速度設定を上げる' },
  { id: 'throttleDown', label: '速度設定を下げる' },
  { id: 'speedMatch', label: '目標速度へ同期' },
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
  hudPanelToggle: 'KeyV',
  viewToggle: 'KeyF',
  navMap: 'KeyN',
  nextSecondary: 'KeyX',
  flare: 'KeyG',
  mouseToggle: 'KeyM',
  flightModeToggle: 'KeyZ',
  pause: 'Escape',
  throttleMax: 'Backquote',
  throttleStop: 'Backspace',
  // 本家 WC の `+` `-` を既定にする（W7-2）。
  // 従来の `]` `[` とテンキーの `+` `-` は `input.ts` の別名で従来どおり効く。
  throttleUp: 'Equal',
  throttleDown: 'Minus',
  // `L` は本家の手動ロックと同じ位置。艦内の名鑑パネル切替 (`ui/HubPanels.ts` の 'KeyL') と
  // コードは同じだが、画面が排他（艦内 / 出撃中）なので衝突しない。
  manualLock: 'KeyL',
  // `L` の隣で右手で押せて、未割り当てだったキー。
  // 方針書の「資料上は V 系」は本作の V（HUD情報切替）と衝突するため採らない。
  speedMatch: 'Semicolon',
  // 方針書の「I 系」に合わせる。
  targetReticle: 'KeyI',
  // 押しっぱなしで使うので、右手の小指で押し続けられるキーにする。
  // `B` は訓練の送り (`Tutorial.ts` / `TutorialDemo.ts` の 'KeyB') と飛行中に衝突するため採らない。
  rearView: 'Slash',
};

/**
 * コクピットの表示方法（W4）。
 * 'full'  … 骨組み + ガラス + 計器盤（既定。機体に乗っている構図）
 * 'glass' … ガラスと計器盤のみ（骨組みを消して視界を最大にする）
 * 'frame' … 骨組みと計器盤のみ（ガラスの映り込みを消す）
 * 'dash'  … 計器盤のみ（旧「コクピット表示 OFF」に近い見え方）
 * 'off'   … 何も出さない
 */
export type CockpitStyle = 'full' | 'glass' | 'frame' | 'dash' | 'off';

export const COCKPIT_STYLES: CockpitStyle[] = ['full', 'glass', 'frame', 'dash', 'off'];

export const COCKPIT_STYLE_LABEL: Record<CockpitStyle, string> = {
  full: '風防ぜんぶ',
  glass: 'ガラスのみ',
  frame: '骨組みのみ',
  dash: '計器盤のみ',
  off: '非表示',
};

/** ミサイルロックの方式（W7-3）。手動では `L` を押した目標だけロックが進む。 */
export type MissileLockMode = 'auto' | 'manual';

/** 効果音のカテゴリ（W5-B）。 */
export type SfxCategory =
  | 'gun'
  | 'missile'
  | 'impact'
  | 'explosion'
  | 'warning'
  | 'lock'
  | 'ui'
  | 'voice'
  | 'engine';

/**
 * 音源の選び方。
 * 'sample' … 同梱の wav（`public/audio/weapons/*-after3.wav`）
 * 'synth'  … Web Audio による合成音
 * 'soft'   … 合成音の控えめ版（音量 0.5 倍・長さ 0.7 倍）
 * 'off'    … 鳴らさない
 */
export type SfxSource = 'sample' | 'synth' | 'soft' | 'off';

export interface SfxSetting {
  source: SfxSource;
  /** 0..1 のカテゴリ音量倍率（`volumeSfx` に掛かる） */
  gain: number;
}

export const SFX_CATEGORIES: SfxCategory[] = [
  'gun',
  'missile',
  'impact',
  'explosion',
  'warning',
  'lock',
  'ui',
  'voice',
  'engine',
];

export const SFX_CATEGORY_LABEL: Record<SfxCategory, string> = {
  gun: '主砲',
  missile: 'ミサイル',
  impact: '被弾',
  explosion: '爆発',
  warning: '警報',
  lock: 'ロック音',
  ui: 'UI・通知',
  voice: '無線の声',
  engine: 'エンジン',
};

export const SFX_SOURCE_LABEL: Record<SfxSource, string> = {
  sample: '実音声',
  synth: '合成音',
  soft: '控えめ',
  off: '無音',
};

/**
 * カテゴリごとに選べる音源。
 * **設定画面の選択肢もこの表から作る**（表示と実挙動を同じ出所にするため）。
 * 実音声を持つのは主砲とミサイルだけ（同梱 wav がこの2種のみ）。
 */
export const SFX_SOURCE_OPTIONS: Record<SfxCategory, SfxSource[]> = {
  gun: ['sample', 'synth', 'off'],
  missile: ['sample', 'synth', 'off'],
  impact: ['synth', 'off'],
  explosion: ['synth', 'off'],
  warning: ['synth', 'soft', 'off'],
  lock: ['synth', 'soft', 'off'],
  ui: ['synth', 'off'],
  voice: ['synth', 'off'],
  engine: ['synth', 'off'],
};

export const DEFAULT_SFX: Record<SfxCategory, SfxSetting> = {
  gun: { source: 'sample', gain: 1 },
  missile: { source: 'sample', gain: 1 },
  impact: { source: 'synth', gain: 1 },
  explosion: { source: 'synth', gain: 1 },
  warning: { source: 'synth', gain: 1 },
  lock: { source: 'synth', gain: 1 },
  ui: { source: 'synth', gain: 1 },
  voice: { source: 'synth', gain: 1 },
  engine: { source: 'synth', gain: 1 },
};

/** 「控えめ」の係数。音量と長さの両方を落として耳に刺さらないようにする。 */
export const SFX_SOFT_GAIN = 0.5;
export const SFX_SOFT_DURATION = 0.7;

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
  /**
   * 旧: コクピット表示の ON/OFF。
   * **W4 で `cockpitStyle` へ移行したので、実装からは読まない。**
   * 古い保存データをそのまま読めるようにするためフィールドだけ残している。
   */
  cockpitDecorations: boolean;
  /** コクピットの表示方法（W4。旧 `cockpitDecorations` の後継） */
  cockpitStyle: CockpitStyle;
  /**
   * 風防ガラスの映り込みの濃さ (0..1)。
   * 実際の不透明度は `GLASS_OPACITY_MAX` に掛けた値になる。
   * 0 でガラス面を描かない（完全な素通し）。
   */
  glassOpacity: number;
  /** ミサイルロックの方式（W7-3） */
  missileLock: MissileLockMode;
  /**
   * 場面ごとに鳴らす BGM（W5-A）。
   * 未設定の場面は `DEFAULT_MUSIC_ASSIGNMENT` の曲を使う。
   */
  musicAssignment: Partial<Record<MusicTrackId, MusicChoice>>;
  /** 効果音のカテゴリごとの音源と音量（W5-B） */
  sfx: Record<SfxCategory, SfxSetting>;
  /**
   * 保存データの版。既定値の意味が変わったときの移行に使う (UI には出さない)。
   * 1: 版が無い時代の保存データ (cockpitDecorations の既定が false だった)
   * 2: コクピット表示を既定 ON にした
   * 3: マウス操縦を既定 OFF にした (キーボード操縦を基準の操作にした)
   * 4: コクピット表示を boolean から `cockpitStyle` の5段階へ移した
   */
  settingsVersion: number;
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
  difficulty: 'easy',
  // マウス操縦は既定 OFF。キーボード操縦を基準の操作にする (M で切り替え)。
  mouseFlight: false,
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
  cockpitDecorations: true,
  cockpitStyle: 'full',
  // 0.4 × GLASS_OPACITY_MAX(0.25) = 実効 0.1（`render/Cockpit.ts` の GLASS_OPACITY と一致）
  glassOpacity: 0.4,
  missileLock: 'auto',
  musicAssignment: {},
  sfx: cloneSfx(DEFAULT_SFX),
  settingsVersion: 4,
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

/** 効果音設定の複製。参照を共有すると既定値が書き換わってしまう。 */
function cloneSfx(source: Record<SfxCategory, SfxSetting>): Record<SfxCategory, SfxSetting> {
  const out = {} as Record<SfxCategory, SfxSetting>;
  for (const category of SFX_CATEGORIES) out[category] = { ...source[category] };
  return out;
}

export const settings: Settings = {
  ...DEFAULT_SETTINGS,
  keyBindings: { ...DEFAULT_KEY_BINDINGS },
  sfx: cloneSfx(DEFAULT_SFX),
};

const listeners = new Set<(s: Settings) => void>();

export function loadSettings(): void {
  const loaded: Settings = {
    ...DEFAULT_SETTINGS,
    keyBindings: { ...DEFAULT_KEY_BINDINGS },
    sfx: cloneSfx(DEFAULT_SFX),
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
      migrateSettings(loaded, parsed);
    }
    Object.assign(settings, loaded);
    normalizeSettings();
    if (raw) saveSettings();
  } catch {
    /* 壊れた保存データは無視して既定値で動かす */
    Object.assign(settings, loaded);
  }
}

/**
 * 保存データの移行。
 *
 * 保存は「全項目まとめて JSON」なので、既定値を変えても
 * 一度でも設定を保存した人は古い値のまま固定されてしまう。
 * 版が上がった項目だけを新しい既定へ引き上げる。
 */
function migrateSettings(loaded: Settings, parsed: Partial<Settings>): void {
  // 版が書かれていない保存データは版1 (既定値を変える前) として扱う
  const version = typeof parsed.settingsVersion === 'number' && Number.isFinite(parsed.settingsVersion)
    ? parsed.settingsVersion
    : 1;
  // 版1: コクピット表示の既定が false だった。既定 ON へ引き上げる。
  // (版2以降で自分で OFF にした人の選択は尊重する)
  if (version < 2) loaded.cockpitDecorations = DEFAULT_SETTINGS.cockpitDecorations;
  // 版2以前: マウス操縦の既定が true だった。既定 OFF へ引き下げる
  // (版3以降で自分で ON にした人の選択は尊重する)。
  if (version < 3) loaded.mouseFlight = DEFAULT_SETTINGS.mouseFlight;
  // 版3以前: コクピット表示は boolean だった。ON→'full' / OFF→'dash' へ写す。
  // OFF を 'off' にしないのは、旧 OFF でも DOM の計器盤は出ていたため
  // （3D の筐体だけが消えていた）。見え方をそのまま引き継ぐのは 'dash' である。
  if (version < 4) {
    loaded.cockpitStyle = parsed.cockpitDecorations === false ? 'dash' : 'full';
  }
  loaded.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
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
  Object.assign(settings, DEFAULT_SETTINGS, {
    keyBindings: { ...DEFAULT_KEY_BINDINGS },
    sfx: cloneSfx(DEFAULT_SFX),
    musicAssignment: {},
  });
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
  // ───── W4: コクピット表示 ─────
  if (!COCKPIT_STYLES.includes(settings.cockpitStyle)) {
    settings.cockpitStyle = DEFAULT_SETTINGS.cockpitStyle;
  }
  settings.glassOpacity = clampSetting(settings.glassOpacity, 0, 1, DEFAULT_SETTINGS.glassOpacity);
  // ───── W7-3: ミサイルロック ─────
  if (settings.missileLock !== 'auto' && settings.missileLock !== 'manual') {
    settings.missileLock = DEFAULT_SETTINGS.missileLock;
  }
  // ───── W5-A: 場面ごとの BGM ─────
  // 未知の場面キー・未知の曲 id は捨てる。壊れた保存データで全場面が無音になると
  // 「音が出ない不具合」に見えるため、ここで必ず落とす。
  const assignment: Partial<Record<MusicTrackId, MusicChoice>> = {};
  const rawAssignment = settings.musicAssignment;
  if (rawAssignment && typeof rawAssignment === 'object') {
    for (const [cue, choice] of Object.entries(rawAssignment)) {
      if (isMusicCue(cue) && isMusicChoice(choice)) assignment[cue] = choice;
    }
  }
  settings.musicAssignment = assignment;
  /*
   * 正規化した割り当てを音楽側へ流す。
   *
   * ここで流すのは、`loadSettings` / `updateSettings` / `resetSettings` の
   * すべてが `normalizeSettings()` を通るため。画面側 (App) で購読すると
   * 「設定を変えたのに曲が変わらない」経路を作りかねない。
   * `musicCues` は `settings` を import しないので、依存の向きは一方通行のまま。
   */
  setMusicAssignment(assignment);
  // ───── W5-B: 効果音 ─────
  const sfx = cloneSfx(DEFAULT_SFX);
  const rawSfx = settings.sfx as unknown;
  if (rawSfx && typeof rawSfx === 'object') {
    for (const category of SFX_CATEGORIES) {
      const value = (rawSfx as Partial<Record<SfxCategory, Partial<SfxSetting>>>)[category];
      if (!value || typeof value !== 'object') continue;
      // そのカテゴリが持てない音源（実音声を持たない被弾に 'sample' など）は既定へ戻す
      if (typeof value.source === 'string' && SFX_SOURCE_OPTIONS[category].includes(value.source as SfxSource)) {
        sfx[category].source = value.source as SfxSource;
      }
      sfx[category].gain = clampSetting(Number(value.gain), 0, 1, 1);
    }
  }
  settings.sfx = sfx;
  if (
    !Number.isFinite(settings.settingsVersion) ||
    settings.settingsVersion < DEFAULT_SETTINGS.settingsVersion
  ) {
    settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
  }
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

/** プレイヤーが発射する武器だけに掛ける、命中性の補正。 */
export interface PlayerWeaponModifiers {
  /** 主砲弾速倍率 */
  playerGunSpeedScale: number;
  /** 主砲の実効命中半径倍率 */
  playerGunHitRadiusScale: number;
  /** ミサイル速度倍率 */
  playerMissileSpeedScale: number;
  /** ミサイル近接信管の判定半径倍率 */
  playerMissileTriggerScale: number;
  /** ミサイル爆発半径倍率 */
  playerMissileBlastScale: number;
  /** プレイヤー用ロードアウトのミサイル数倍率 */
  playerMissileCountScale: number;
}

export const DEFAULT_PLAYER_WEAPON_MODIFIERS: PlayerWeaponModifiers = {
  playerGunSpeedScale: 1,
  playerGunHitRadiusScale: 1,
  playerMissileSpeedScale: 1,
  playerMissileTriggerScale: 1,
  playerMissileBlastScale: 1,
  playerMissileCountScale: 1,
};

export interface DifficultyProfile extends PlayerWeaponModifiers {
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
   * 敵機の速度倍率 (初速・最高速・アフターバーナー速度に掛かる)。
   *
   * `MissionRunner` が敵対勢力の機体だけに `speedScale` として渡す。
   * 味方・護衛対象・自機には掛けない。
   * NORMAL/HARD は 1 (据え置き)。
   */
  enemySpeedScale: number;
  /**
   * プレイヤー機の部位故障の発生率倍率。
   * 部位損傷は強力なので、難易度でここを絞らないと「ふつう」が急に厳しくなる。
   */
  playerSubsystemRate: number;
  /**
   * 非敵対勢力（母艦・輸送船・救難ポッド・僚機・中立艦）との接触ダメージ倍率。
   *
   * 接触ダメージは質量比 `min(14, 0.6 + 相手半径/自半径 × 1.6)` を掛けるので、
   * 母艦のような大質量に触れると 1回で 100 前後（ホーネットの hull と同値）になる。
   * 「発艦直後に母艦を擦って沈む」を「やさしい」で起こさないため、ここだけ 0 にできるようにした。
   * **プレイヤー機が当事者の接触にだけ掛かる**（AI 同士の接触・敵機との接触・誤射には掛からない）。
   * NORMAL / HARD は 1（据え置き）。
   */
  friendlyCollisionDamage: number;
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
    // 敵機の速度は「ふつう」の 25%。旧値 0.5 からさらに半分に落とし、
    // 追いつけない・振り切られる状態を無くしている。
    enemySpeedScale: 0.25,
    playerSubsystemRate: 0.35,
    // 母艦・輸送船・ポッド・僚機との接触は無傷にする（07_更なる改善 W2）。
    // 敵機との体当たりは据え置き（Easy でも危険）。
    friendlyCollisionDamage: 0,
    playerGunSpeedScale: 1.35,
    playerGunHitRadiusScale: 1.8,
    playerMissileSpeedScale: 1.35,
    playerMissileTriggerScale: 1.5,
    playerMissileBlastScale: 1.25,
    playerMissileCountScale: 2,
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
    enemySpeedScale: 1,
    playerSubsystemRate: 0.7,
    friendlyCollisionDamage: 1,
    ...DEFAULT_PLAYER_WEAPON_MODIFIERS,
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
    enemySpeedScale: 1,
    playerSubsystemRate: 1.15,
    friendlyCollisionDamage: 1,
    ...DEFAULT_PLAYER_WEAPON_MODIFIERS,
  },
};

export function difficulty(): DifficultyProfile {
  return DIFFICULTIES[settings.difficulty] ?? DIFFICULTIES.normal;
}

/**
 * 照準アシストの強さ (0..1)。
 *
 * 設定の ON/OFF と、難易度の `strongAimHelp`（やさしいのみ true）を掛け合わせる。
 * **`settings` を直接読まない純関数**にしてあるのは、
 * 本番ループ (`app/game.ts`) と通しプレイのテストが同じ式を使えるようにするため。
 * ここが唯一の出所なので、テスト側で `0.45` などを写さない。
 */
export function aimAssistStrength(enabled: boolean, strongAimHelp: boolean): number {
  if (!enabled) return 0;
  return strongAimHelp ? 1 : 0.45;
}

// ───────── 効果音の設定を読む（W5-B） ─────────

/** カテゴリの設定を読む。壊れた保存データでも既定へ落ちる。 */
export function sfxSetting(category: SfxCategory, from: Settings = settings): SfxSetting {
  const value = from.sfx?.[category];
  if (!value || typeof value !== 'object') return DEFAULT_SFX[category];
  return value;
}

/**
 * カテゴリの音量倍率。鳴らさないときは null を返す。
 *
 * **`settings` を直接読まない純関数**にしてあるのは、`AudioManager` とテストが
 * 同じ式を使えるようにするため（`aimAssistStrength` と同じ方針）。
 * 「控えめ」は音量を `SFX_SOFT_GAIN` 倍にする（長さは `sfxDurationScale` 側）。
 */
export function sfxGain(category: SfxCategory, from: Settings = settings): number | null {
  const setting = sfxSetting(category, from);
  if (setting.source === 'off') return null;
  const gain = Number.isFinite(setting.gain) ? Math.max(0, Math.min(1, setting.gain)) : 1;
  if (gain <= 0) return null;
  return setting.source === 'soft' ? gain * SFX_SOFT_GAIN : gain;
}

/** カテゴリの長さ倍率。「控えめ」だけ短くする。 */
export function sfxDurationScale(category: SfxCategory, from: Settings = settings): number {
  return sfxSetting(category, from).source === 'soft' ? SFX_SOFT_DURATION : 1;
}

/** 同梱 wav（実音声）を使うカテゴリか。合成音・無音のときは false。 */
export function sfxUsesSample(category: SfxCategory, from: Settings = settings): boolean {
  return sfxSetting(category, from).source === 'sample';
}
