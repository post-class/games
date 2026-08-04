import type { FlightMode } from '../sim/flight';

export type DifficultyId = 'easy' | 'normal' | 'hard';

export interface Settings {
  difficulty: DifficultyId;
  /** マウス操縦を使うか */
  mouseFlight: boolean;
  mouseSensitivity: number;
  invertY: boolean;
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
  /** 訓練を見たか */
  tutorialDone: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  difficulty: 'normal',
  mouseFlight: true,
  mouseSensitivity: 1,
  invertY: false,
  aimAssist: true,
  flightMode: 'wc',
  advanced: false,
  volumeMaster: 0.8,
  volumeMusic: 0.5,
  volumeSfx: 0.9,
  radioDuration: 9,
  cockpitDecorations: false,
  tutorialDone: false,
};

const KEY = 'multi-commander.settings.v1';

export const settings: Settings = { ...DEFAULT_SETTINGS };

const listeners = new Set<(s: Settings) => void>();

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    for (const k of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      if (parsed[k] !== undefined) {
        (settings as unknown as Record<string, unknown>)[k] = parsed[k];
      }
    }
  } catch {
    /* 壊れた保存データは無視して既定値で動かす */
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
  Object.assign(settings, patch);
  saveSettings();
  for (const l of listeners) l(settings);
}

export function resetSettings(): void {
  Object.assign(settings, DEFAULT_SETTINGS);
  saveSettings();
  for (const l of listeners) l(settings);
}

export function onSettingsChanged(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
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
