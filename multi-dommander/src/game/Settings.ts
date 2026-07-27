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
}

export const DIFFICULTIES: Record<Difficulty, DifficultyMods> = {
  easy: {
    label: "やさしい",
    enemyHealthMul: 0.6,
    enemyDamageMul: 0.45,
    enemyFireIntervalMul: 1.6,
    enemyAggression: 0.25,
    playerHealthMul: 1.6,
  },
  normal: {
    label: "ふつう",
    enemyHealthMul: 1.0,
    enemyDamageMul: 1.0,
    enemyFireIntervalMul: 1.0,
    enemyAggression: 0.5,
    playerHealthMul: 1.0,
  },
  hard: {
    label: "むずかしい",
    enemyHealthMul: 1.25,
    enemyDamageMul: 1.3,
    enemyFireIntervalMul: 0.85,
    enemyAggression: 0.75,
    playerHealthMul: 0.85,
  },
};

/** 難易度選択の表示順。 */
export const DIFFICULTY_ORDER: Difficulty[] = ["easy", "normal", "hard"];

const KEY = "multidommander.settings.v1";

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
