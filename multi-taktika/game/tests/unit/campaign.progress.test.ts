/**
 * T-M16-06: セーブ（`localStorage`、進行と分岐履歴）
 *
 * 完了条件「**進行と分岐履歴が残る / ブラウザを閉じても続きから遊べる**」の検証。
 * 併せて手順書の要求:
 *  - 壊れた JSON / 保存できない環境でも**例外を投げず既定で動く**
 *  - `version` が合わなければ**黙って読まない**
 */

import { describe, expect, it } from 'vitest';

import {
  SAVE_STORAGE_KEY,
  SAVE_VERSION,
  clearProgress,
  currentMissionId,
  emptyProgress,
  firstMissionOfChapter,
  isMissionUnlocked,
  lastRecordOf,
  loadProgress,
  missionById,
  recordOutcome,
  saveProgress,
  vassalRecords,
} from '@/campaign';
import type { ProgressStorage } from '@/campaign';

/** テスト用の入れ物（`localStorage` と同じ形）。 */
function memoryStorage(initial?: string): ProgressStorage & { raw(): string | null } {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_k: string, v: string) => {
      value = v;
    },
    removeItem: () => {
      value = null;
    },
    raw: () => value,
  };
}

/** 何をしても失敗する入れ物（プライベートモード・容量超過の再現）。 */
function brokenStorage(): ProgressStorage {
  return {
    getItem: () => {
      throw new Error('getItem が使えない環境');
    },
    setItem: () => {
      throw new Error('容量超過');
    },
    removeItem: () => {
      throw new Error('消せない');
    },
  };
}

const first = firstMissionOfChapter(1)!;

describe('T-M16-06 セーブの読み書き', () => {
  it('保存して読み直すと同じ内容になる（ブラウザを閉じても続きから遊べる）', () => {
    const st = memoryStorage();
    const p = recordOutcome(emptyProgress(), first.id, 'victory', 1234);
    expect(saveProgress(p, st)).toBe(true);

    const loaded = loadProgress(st);
    expect(loaded.version).toBe(SAVE_VERSION);
    expect(loaded.current).toBe(first.onVictory);
    expect(loaded.cleared).toEqual([first.id]);
    expect(loaded.history.length).toBe(1);
    expect(loaded.history[0]).toEqual({
      mission: first.id,
      outcome: 'victory',
      route: 'main',
      tick: 1234,
    });
  });

  it('保存先のキーは _config.json のもの', () => {
    const st = memoryStorage();
    saveProgress(emptyProgress(), st);
    expect(SAVE_STORAGE_KEY.length).toBeGreaterThan(0);
    expect(st.raw()).not.toBeNull();
  });

  it('何も保存されていなければ既定値', () => {
    expect(loadProgress(memoryStorage())).toEqual(emptyProgress());
  });

  it('壊れた JSON は例外にならず既定値になる', () => {
    for (const broken of ['{', 'null', '[]', '"文字列"', '{"version":', 'ゴミ']) {
      expect(() => loadProgress(memoryStorage(broken))).not.toThrow();
      expect(loadProgress(memoryStorage(broken))).toEqual(emptyProgress());
    }
  });

  it('version が合わないセーブは黙って読まない', () => {
    const old = JSON.stringify({
      version: SAVE_VERSION + 1,
      current: first.id,
      cleared: [first.id],
      history: [{ mission: first.id, outcome: 'victory', route: 'main', tick: 1 }],
    });
    expect(loadProgress(memoryStorage(old))).toEqual(emptyProgress());
  });

  it('形が違うセーブ（履歴の型が壊れている）も既定値になる', () => {
    const bad = JSON.stringify({
      version: SAVE_VERSION,
      current: first.id,
      cleared: [first.id],
      history: [{ mission: first.id, outcome: 'なんとなく勝ち', route: 'main', tick: 1 }],
    });
    expect(loadProgress(memoryStorage(bad))).toEqual(emptyProgress());
  });

  it('定義から消えたミッション ID は捨てる（JSON を作り直しても壊れない）', () => {
    const stale = JSON.stringify({
      version: SAVE_VERSION,
      current: 'ここには無いミッション',
      cleared: ['ここには無いミッション', first.id],
      history: [
        { mission: 'ここには無いミッション', outcome: 'victory', route: 'main', tick: 1 },
        { mission: first.id, outcome: 'victory', route: 'main', tick: 2 },
      ],
    });
    const p = loadProgress(memoryStorage(stale));
    expect(p.current).toBeNull();
    expect(p.cleared).toEqual([first.id]);
    expect(p.history.map((r) => r.mission)).toEqual([first.id]);
  });

  it('保存できない環境でも例外を投げない（false を返すだけ）', () => {
    const st = brokenStorage();
    expect(() => loadProgress(st)).not.toThrow();
    expect(loadProgress(st)).toEqual(emptyProgress());
    expect(saveProgress(emptyProgress(), st)).toBe(false);
    expect(() => clearProgress(st)).not.toThrow();
  });

  it('localStorage が無い環境（storage = null）でも動く', () => {
    expect(loadProgress(null)).toEqual(emptyProgress());
    expect(saveProgress(emptyProgress(), null)).toBe(false);
    expect(() => clearProgress(null)).not.toThrow();
  });

  it('消すと既定値に戻る', () => {
    const st = memoryStorage();
    saveProgress(recordOutcome(emptyProgress(), first.id, 'victory', 1), st);
    clearProgress(st);
    expect(loadProgress(st)).toEqual(emptyProgress());
  });
});

describe('T-M16-06 進行と分岐履歴', () => {
  it('負けた記録も残り、次のミッションへ進む', () => {
    const second = missionById(first.onVictory!)!;
    let p = recordOutcome(emptyProgress(), first.id, 'victory', 10);
    p = recordOutcome(p, second.id, 'defeat', 20);

    expect(p.current).toBe(second.onDefeat);
    expect(p.current).not.toBeNull();
    expect(p.cleared).toEqual([first.id]); // 負けた話はクリア扱いにしない
    expect(p.history.map((r) => r.outcome)).toEqual(['victory', 'defeat']);
    expect(lastRecordOf(p, second.id)?.outcome).toBe('defeat');
  });

  it('服属ルートを通った記録が残る（分岐した側のルートも記録に残る）', () => {
    const second = missionById(first.onVictory!)!;
    const vassal = missionById(second.onDefeat!)!;
    expect(vassal.route).toBe('vassal');

    let p = recordOutcome(emptyProgress(), second.id, 'defeat', 20);
    p = recordOutcome(p, vassal.id, 'victory', 30);

    expect(vassalRecords(p).map((r) => r.mission)).toEqual([vassal.id]);
    // 服属ルートで勝つと本線に戻る（旗を戻して復帰）。
    expect(missionById(p.current!)?.route).toBe('main');
    expect(isMissionUnlocked(p, vassal.id)).toBe(true);
  });

  it('未知のミッション ID を渡しても何も起きない', () => {
    const p = emptyProgress();
    expect(recordOutcome(p, '無いミッション', 'victory', 1)).toBe(p);
  });

  it('tick が壊れていても 0 に丸めて記録する', () => {
    const p = recordOutcome(emptyProgress(), first.id, 'victory', Number.NaN);
    expect(p.history[0]!.tick).toBe(0);
  });

  it('現在地と解放状態が引ける', () => {
    const p = recordOutcome(emptyProgress(), first.id, 'victory', 1);
    expect(currentMissionId(p)).toBe(first.onVictory);
    expect(isMissionUnlocked(p, first.id)).toBe(true);
    expect(isMissionUnlocked(p, first.onVictory!)).toBe(true);
    expect(isMissionUnlocked(emptyProgress(), first.onVictory!)).toBe(false);
  });
});
