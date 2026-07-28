import { describe, it, expect } from "vitest";
import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyMods } from "../src/game/Settings";

/** DifficultyMods が持つべき全フィールド (T30 で追加した新規フィールドを含む)。 */
const REQUIRED_FIELDS: Array<keyof DifficultyMods> = [
  "label",
  "enemyHealthMul",
  "enemyDamageMul",
  "enemyFireIntervalMul",
  "enemyAggression",
  "playerHealthMul",
  "autoTarget",
  "aimAssist",
  "missileLockTimeMul",
  "maxSimultaneousAttackers",
  "enemyAccuracyMul",
  "waveDelayOnThreat",
  "initialThrottle",
];

describe("DifficultyMods: フィールド定義", () => {
  it("DIFFICULTY_ORDER に easy/normal/hard が揃っている", () => {
    expect(DIFFICULTY_ORDER).toEqual(["easy", "normal", "hard"]);
  });

  it.each(DIFFICULTY_ORDER)("%s は DifficultyMods の全フィールドを持つ", (d) => {
    const mods = DIFFICULTIES[d];
    for (const field of REQUIRED_FIELDS) {
      expect(mods).toHaveProperty(field);
      expect(mods[field]).not.toBeUndefined();
    }
  });
});

describe("DifficultyMods: Easy (AssistProfile)", () => {
  const mods = DIFFICULTIES.easy;

  it("autoTarget が有効", () => {
    expect(mods.autoTarget).toBe(true);
  });

  it("aimAssist が strong", () => {
    expect(mods.aimAssist).toBe("strong");
  });

  it("missileLockTimeMul が 0.6 (速くロック)", () => {
    expect(mods.missileLockTimeMul).toBe(0.6);
  });

  it("maxSimultaneousAttackers が 1", () => {
    expect(mods.maxSimultaneousAttackers).toBe(1);
  });

  it("enemyAccuracyMul が 0.5 (下手)", () => {
    expect(mods.enemyAccuracyMul).toBe(0.5);
  });

  it("waveDelayOnThreat が有効", () => {
    expect(mods.waveDelayOnThreat).toBe(true);
  });

  it("initialThrottle が 0.35", () => {
    expect(mods.initialThrottle).toBe(0.35);
  });
});

describe("DifficultyMods: Normal", () => {
  const mods = DIFFICULTIES.normal;

  it("autoTarget が無効", () => {
    expect(mods.autoTarget).toBe(false);
  });

  it("aimAssist が light", () => {
    expect(mods.aimAssist).toBe("light");
  });

  it("missileLockTimeMul / enemyAccuracyMul が等倍", () => {
    expect(mods.missileLockTimeMul).toBe(1.0);
    expect(mods.enemyAccuracyMul).toBe(1.0);
  });

  it("maxSimultaneousAttackers が 2", () => {
    expect(mods.maxSimultaneousAttackers).toBe(2);
  });

  it("waveDelayOnThreat が無効・initialThrottle が 0", () => {
    expect(mods.waveDelayOnThreat).toBe(false);
    expect(mods.initialThrottle).toBe(0);
  });
});

describe("DifficultyMods: Hard", () => {
  const mods = DIFFICULTIES.hard;

  it("autoTarget が無効・aimAssist が off", () => {
    expect(mods.autoTarget).toBe(false);
    expect(mods.aimAssist).toBe("off");
  });

  it("missileLockTimeMul が 1.2 (遅くロック)", () => {
    expect(mods.missileLockTimeMul).toBe(1.2);
  });

  it("maxSimultaneousAttackers が 99 (実質無制限)", () => {
    expect(mods.maxSimultaneousAttackers).toBe(99);
  });

  it("enemyAccuracyMul が 1.3 (上手)", () => {
    expect(mods.enemyAccuracyMul).toBe(1.3);
  });

  it("waveDelayOnThreat が無効・initialThrottle が 0", () => {
    expect(mods.waveDelayOnThreat).toBe(false);
    expect(mods.initialThrottle).toBe(0);
  });
});

describe("DifficultyMods: 難易度間の相対関係", () => {
  it("maxSimultaneousAttackers は easy <= normal <= hard", () => {
    expect(DIFFICULTIES.easy.maxSimultaneousAttackers).toBeLessThanOrEqual(
      DIFFICULTIES.normal.maxSimultaneousAttackers,
    );
    expect(DIFFICULTIES.normal.maxSimultaneousAttackers).toBeLessThanOrEqual(
      DIFFICULTIES.hard.maxSimultaneousAttackers,
    );
  });

  it("enemyAccuracyMul は easy < normal < hard", () => {
    expect(DIFFICULTIES.easy.enemyAccuracyMul).toBeLessThan(DIFFICULTIES.normal.enemyAccuracyMul);
    expect(DIFFICULTIES.normal.enemyAccuracyMul).toBeLessThan(DIFFICULTIES.hard.enemyAccuracyMul);
  });

  it("missileLockTimeMul は easy < normal < hard (Easyほど速くロック)", () => {
    expect(DIFFICULTIES.easy.missileLockTimeMul).toBeLessThan(DIFFICULTIES.normal.missileLockTimeMul);
    expect(DIFFICULTIES.normal.missileLockTimeMul).toBeLessThan(DIFFICULTIES.hard.missileLockTimeMul);
  });
});
