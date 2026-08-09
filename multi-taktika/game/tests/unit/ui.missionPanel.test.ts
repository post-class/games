/**
 * ミッション HUD の検証（M16 の HUD 側）。
 *
 * ■ ここで守りたいこと
 *  1. 目標の日本語が**章選択画面と同じ言い方**（2 か所で違うと別の要求に読める）
 *  2. **満たした目標を消さない**（何が残っているかは対比で分かる）
 *  3. ヒントは**いちばん新しい 1 件だけ**（全部並べると今どれに従うか分からない）
 *  4. 継続条件の残りが秒で読める
 *
 * DOM は触らない（`objectiveLines` / `latestHint` / `remainingText` の 3 つが判断の全部）。
 */

import { describe, expect, it } from 'vitest';
import { latestHint, objectiveLines, remainingText } from '@/ui/hud/missionPanel';
import { conditionText } from '@/ui/screens/Campaign';
import { MISSIONS, missionById } from '@/campaign';
import type { ObjectiveProgress } from '@/campaign';
import { TICK_RATE } from '@/sim';

const m1 = missionById('ch1_m1')!;

/** 全条件を「未達・継続なし」で並べた進捗。 */
function freshProgress(mission = m1): ObjectiveProgress[] {
  return mission.victory.map((condition) => ({ condition, met: false, remainingTicks: 0 }));
}

describe('remainingText', () => {
  it('継続条件でなければ何も出さない', () => {
    expect(remainingText(0)).toBe('');
    expect(remainingText(-5)).toBe('');
  });

  it('残り tick を秒に切り上げる（0.1 秒でも「あと 1 秒」）', () => {
    expect(remainingText(TICK_RATE)).toBe('あと 1 秒');
    expect(remainingText(1)).toBe('あと 1 秒');
    expect(remainingText(TICK_RATE * 10)).toBe('あと 10 秒');
  });
});

describe('objectiveLines', () => {
  it('章選択画面と同じ文になる（言い方を 2 つ持たない）', () => {
    const lines = objectiveLines(m1, freshProgress());
    expect(lines).toHaveLength(m1.victory.length);
    lines.forEach((l, i) => {
      expect(l.text).toBe(conditionText(m1, m1.victory[i]!));
    });
  });

  it('満たした目標も行として残る（消さずに印を変えるだけ）', () => {
    const p = freshProgress();
    const done = p.map((x, i) => (i === 0 ? { ...x, met: true } : x));
    const lines = objectiveLines(m1, done);
    expect(lines).toHaveLength(p.length);
    expect(lines[0]!.met).toBe(true);
    expect(lines[1]!.met).toBe(false);
  });

  it('継続条件の残りが行に載る', () => {
    const p = freshProgress();
    const lines = objectiveLines(m1, [{ ...p[0]!, remainingTicks: TICK_RATE * 3 }]);
    expect(lines[0]!.remaining).toBe('あと 3 秒');
  });

  it('進捗が空なら行も空（例外を出さない）', () => {
    expect(objectiveLines(m1, [])).toEqual([]);
  });

  it('全 30 ミッションの目標が ID を素で出さずに日本語になる', () => {
    for (const mission of MISSIONS) {
      for (const line of objectiveLines(mission, freshProgress(mission))) {
        expect(line.text.length, `${mission.id} の目標が空`).toBeGreaterThan(0);
        // `ch1_m1` や `y-nagae` のような ID がそのまま出ていないこと
        expect(line.text, `${mission.id}: ${line.text}`).not.toMatch(/[a-z]+_[a-z0-9]+/);
      }
    }
  });
});

describe('latestHint', () => {
  it('ヒントが無ければ null', () => {
    expect(latestHint([])).toBeNull();
  });

  it('いちばん新しい 1 件だけを返す', () => {
    const hints = [
      { tick: 0, text: '最初の指示' },
      { tick: 500, text: '次の指示' },
    ];
    expect(latestHint(hints)?.text).toBe('次の指示');
  });

  it('同じ tick に複数出たら最後のものを採る', () => {
    const hints = [
      { tick: 100, text: 'A' },
      { tick: 100, text: 'B' },
    ];
    expect(latestHint(hints)?.text).toBe('B');
  });
});
