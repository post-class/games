/** 難易度レベル。既定は easy (初見でも遊べるよう易しめ)。 */
export type Difficulty = "easy" | "normal" | "hard";

/**
 * 難易度ごとの補正値。spawn 時にステータスへ焼き込む方式。
 * - enemyHealthMul: 敵の耐久 (シールド/アーマー/ハル) 倍率。小さいほど脆い。
 * - enemyDamageMul: 敵の砲ダメージ倍率。小さいほど痛くない。
 * - enemyFireIntervalMul: 敵の連射間隔倍率。大きいほど連射が遅い (=手数が減る)。
 * - enemyAggression: 敵AIの攻撃性の基準値 (0..1)。低いほど早く離脱する。
 * - playerHealthMul: 自機の耐久倍率。大きいほど硬い。
 */
export interface DifficultyMods {
  label: string;
  enemyHealthMul: number;
  enemyDamageMul: number;
  enemyFireIntervalMul: number;
  enemyAggression: number;
  playerHealthMul: number;
  /** 自機ターゲット未選択時に前方最寄りの敵を自動選択するか。 */
  autoTarget: boolean;
  /** 照準アシストの強度 (発射方向をリード点方向へ小さく補正)。 */
  aimAssist: AimAssist;
  /** ミサイルロック所要時間の倍率。小さいほど速くロックする。 */
  missileLockTimeMul: number;
  /** プレイヤーを同時に攻撃対象とできる敵の最大数。超過分は別目標へ。 */
  maxSimultaneousAttackers: number;
  /** 敵の射撃判定 (aimDot 閾値) に掛かる精度倍率。小さいほど下手。 */
  enemyAccuracyMul: number;
  /** 前ウェーブの敵が残存中は次ウェーブのスポーンを遅延するか。 */
  waveDelayOnThreat: boolean;
  /** 出撃直後のスロットル初期値 (0..1)。 */
  initialThrottle: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyMods> = {
  easy: {
    label: "やさしい",
    enemyHealthMul: 0.6,
    enemyDamageMul: 0.45,
    enemyFireIntervalMul: 1.6,
    enemyAggression: 0.25,
    playerHealthMul: 1.6,
    autoTarget: true,
    aimAssist: "strong",
    missileLockTimeMul: 0.6,
    maxSimultaneousAttackers: 1,
    enemyAccuracyMul: 0.5,
    waveDelayOnThreat: true,
    initialThrottle: 0.35,
  },
  normal: {
    label: "ふつう",
    enemyHealthMul: 1.0,
    enemyDamageMul: 1.0,
    enemyFireIntervalMul: 1.0,
    enemyAggression: 0.5,
    playerHealthMul: 1.0,
    autoTarget: false,
    aimAssist: "light",
    missileLockTimeMul: 1.0,
    maxSimultaneousAttackers: 2,
    enemyAccuracyMul: 1.0,
    waveDelayOnThreat: false,
    initialThrottle: 0,
  },
  hard: {
    label: "むずかしい",
    enemyHealthMul: 1.25,
    enemyDamageMul: 1.3,
    enemyFireIntervalMul: 0.85,
    enemyAggression: 0.75,
    playerHealthMul: 0.85,
    autoTarget: false,
    aimAssist: "off",
    missileLockTimeMul: 1.2,
    maxSimultaneousAttackers: 99,
    enemyAccuracyMul: 1.3,
    waveDelayOnThreat: false,
    initialThrottle: 0,
  },
};

/** 難易度選択の表示順。 */
export const DIFFICULTY_ORDER: Difficulty[] = ["easy", "normal", "hard"];

const KEY = "multidommander.settings.v1";
const KEY_V2 = "multidommander.settings.v2";

/** 難易度設定の永続化 (localStorage)。失敗しても致命的でないよう握りつぶす。 */
export const SettingsStore = {
  load(): Difficulty {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw === "easy" || raw === "normal" || raw === "hard") return raw;
    } catch {
      // storage 無効時は既定へ。
    }
    return "easy";
  },

  save(d: Difficulty): void {
    try {
      localStorage.setItem(KEY, d);
    } catch {
      // 無視。
    }
  },
};

/** 照準アシストの強度。 */
export type AimAssist = "strong" | "light" | "off";

/**
 * 設定 v2: 難易度に加え、操作方式 (マウス操縦/感度/Y反転/高度な飛行)・
 * アシスト (照準/自動ターゲット/状況ヒント)・音量ミキサー・チュートリアル完了を保持する。
 */
export interface GameSettingsV2 {
  version: 2;
  difficulty: Difficulty;
  controls: {
    preset: "wingCommander";
    /** マウス操縦 ON/OFF (M で切替)。 */
    mouseEnabled: boolean;
    /** マウス感度。0.5..2.0, 既定 1.0。 */
    mouseSensitivity: number;
    /** マウス Y 軸反転。既定 false。 */
    invertMouseY: boolean;
    /** Newton (慣性) 飛行モード切替を許可するか。 */
    advancedFlight: boolean;
  };
  assists: {
    aimAssist: AimAssist;
    autoTarget: boolean;
    contextualHints: boolean;
  };
  audio: {
    master: number;
    music: number;
    sfx: number;
  };
  tutorialCompleted: boolean;
}

/** v2 設定の既定値。初見でも遊びやすいよう、アシスト類は強めに倒す。 */
export const DEFAULT_SETTINGS_V2: GameSettingsV2 = {
  version: 2,
  difficulty: "easy",
  controls: {
    preset: "wingCommander",
    mouseEnabled: true,
    mouseSensitivity: 1.0,
    invertMouseY: false,
    advancedFlight: false,
  },
  assists: {
    aimAssist: "strong",
    autoTarget: true,
    contextualHints: true,
  },
  audio: {
    master: 1.0,
    music: 0.7,
    sfx: 1.0,
  },
  tutorialCompleted: false,
};

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 欠損フィールドをデフォルトで補完しつつ、値の範囲を検証・クランプする。 */
function normalizeV2(partial: unknown): GameSettingsV2 {
  const p = (partial ?? {}) as Partial<GameSettingsV2>;
  const controlsP: Partial<GameSettingsV2["controls"]> = p.controls ?? {};
  const assistsP: Partial<GameSettingsV2["assists"]> = p.assists ?? {};
  const audioP: Partial<GameSettingsV2["audio"]> = p.audio ?? {};
  const difficulty =
    p.difficulty === "easy" || p.difficulty === "normal" || p.difficulty === "hard"
      ? p.difficulty
      : DEFAULT_SETTINGS_V2.difficulty;
  const aimAssist =
    assistsP.aimAssist === "strong" || assistsP.aimAssist === "light" || assistsP.aimAssist === "off"
      ? assistsP.aimAssist
      : DEFAULT_SETTINGS_V2.assists.aimAssist;

  return {
    version: 2,
    difficulty,
    controls: {
      preset: "wingCommander",
      mouseEnabled: controlsP.mouseEnabled ?? DEFAULT_SETTINGS_V2.controls.mouseEnabled,
      mouseSensitivity: clamp(
        controlsP.mouseSensitivity ?? DEFAULT_SETTINGS_V2.controls.mouseSensitivity,
        0.5,
        2.0,
      ),
      invertMouseY: controlsP.invertMouseY ?? DEFAULT_SETTINGS_V2.controls.invertMouseY,
      advancedFlight: controlsP.advancedFlight ?? DEFAULT_SETTINGS_V2.controls.advancedFlight,
    },
    assists: {
      aimAssist,
      autoTarget: assistsP.autoTarget ?? DEFAULT_SETTINGS_V2.assists.autoTarget,
      contextualHints: assistsP.contextualHints ?? DEFAULT_SETTINGS_V2.assists.contextualHints,
    },
    audio: {
      master: clamp(audioP.master ?? DEFAULT_SETTINGS_V2.audio.master, 0, 1),
      music: clamp(audioP.music ?? DEFAULT_SETTINGS_V2.audio.music, 0, 1),
      sfx: clamp(audioP.sfx ?? DEFAULT_SETTINGS_V2.audio.sfx, 0, 1),
    },
    tutorialCompleted: p.tutorialCompleted ?? DEFAULT_SETTINGS_V2.tutorialCompleted,
  };
}

/** v1 (難易度のみ) からの移行: v1 キーがあれば difficulty のみ引き継ぐ。 */
function migrateFromV1(): Partial<GameSettingsV2> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "easy" || raw === "normal" || raw === "hard") {
      return { difficulty: raw };
    }
  } catch {
    // storage 無効時は無視。
  }
  return {};
}

/**
 * 設定 v2 の永続化 (localStorage)。不正 JSON や欠損フィールドはデフォルトで補完する。
 * v2 キーが存在しない場合は v1 (難易度のみ) からの移行を試みる。
 */
export const SettingsStoreV2 = {
  load(): GameSettingsV2 {
    try {
      const raw = localStorage.getItem(KEY_V2);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        return normalizeV2(parsed);
      }
    } catch {
      // 不正 JSON 等は握りつぶしてデフォルト/移行にフォールバック。
    }
    const migrated = migrateFromV1();
    return normalizeV2(migrated);
  },

  save(s: GameSettingsV2): void {
    try {
      localStorage.setItem(KEY_V2, JSON.stringify(s));
    } catch {
      // 無視。
    }
  },

  reset(): GameSettingsV2 {
    const defaults = { ...DEFAULT_SETTINGS_V2 };
    this.save(defaults);
    return defaults;
  },
};
