/**
 * T-M16-03: 分岐（負けたら服属ルート、勝てば本線復帰）
 *
 * 上流資料 `02`「戦のあと ― この世界に『滅亡』はない」:
 *   > キャンペーンでミッションに失敗してもゲームオーバーにはならず、
 *   > 服属した状態から始まる「立場の悪いルート」へ分岐します。そこで勝てば旗を戻して本線に復帰できます。
 *
 * 完了条件「**負けても次に進める。分岐した側のルートも記録に残る**」を、
 * 定義のグラフとして検証する（コードに分岐が無いので、確かめる場所は定義しかない）。
 */

import { describe, expect, it } from 'vitest';

import { MISSIONS, emptyProgress, mainMissionsOfChapter, missionById, recordOutcome, vassalRecords } from '@/campaign';
import type { Mission } from '@/campaign';

/** 終端（勝っても負けても次が無い = 章の最後）か。 */
function isTerminal(m: Mission): boolean {
  return m.onVictory === null && m.onDefeat === null;
}

describe('T-M16-03 負けても次に進める', () => {
  it('敗北条件を持つミッションには必ず行き先がある（終端を除く）', () => {
    for (const m of MISSIONS) {
      if (m.defeat.length === 0) continue;
      if (isTerminal(m)) continue;
      expect(m.onDefeat, `${m.id} に負けたときの行き先が無い`).not.toBeNull();
    }
  });

  it('負けた先は服属ルート（立場の悪いルート）', () => {
    for (const m of MISSIONS) {
      if (m.onDefeat === null) continue;
      const next = missionById(m.onDefeat)!;
      expect(next.route, `${m.id} の敗北分岐先 ${next.id}`).toBe('vassal');
    }
  });

  it('服属ルートは「開始資源が少ない / 寄せ手が多い」を定義で表している（コードに分岐が無い）', () => {
    const vassals = MISSIONS.filter((m) => m.route === 'vassal');
    expect(vassals.length).toBeGreaterThan(0);
    for (const v of vassals) {
      // 分岐元（同じ章・同じ話数の本線）と比べる。
      const base = MISSIONS.find(
        (m) => m.route === 'main' && m.chapter === v.chapter && m.index === v.index,
      );
      expect(base, `${v.id} の分岐元が見つからない`).toBeDefined();
      const ownUnits = (m: Mission): number =>
        m.setup.units.filter((u) => u.player === m.setup.player).reduce((n, u) => n + u.count, 0);
      const enemyUnits = (m: Mission): number =>
        m.setup.units.filter((u) => u.player !== m.setup.player).reduce((n, u) => n + u.count, 0);
      const waveUnits = (m: Mission): number => {
        let n = 0;
        for (const ev of m.events) {
          if (ev.action.type !== 'spawnEnemyWave' && ev.action.type !== 'spawnUnits') continue;
          if (ev.action.player === m.setup.player) continue;
          for (const g of ev.action.units) n += g.count;
        }
        return n;
      };
      const harder =
        v.setup.startResources !== base!.setup.startResources ||
        ownUnits(v) < ownUnits(base!) ||
        enemyUnits(v) > enemyUnits(base!) ||
        waveUnits(v) > waveUnits(base!);
      expect(harder, `${v.id} が分岐元より易しくなっている`).toBe(true);
    }
  });

  it('服属ルートで勝つと本線に復帰する（旗を戻す）', () => {
    for (const v of MISSIONS.filter((m) => m.route === 'vassal')) {
      if (v.onVictory === null) continue; // 章の終端
      expect(missionById(v.onVictory)!.route).toBe('main');
    }
  });

  it('敗北を辿り続けても必ず終端に着く（詰まない・巡回しない）', () => {
    for (const start of MISSIONS) {
      const seen: string[] = [];
      let cur: Mission | null = start;
      while (cur !== null) {
        expect(seen, `${start.id} からの敗北連鎖が巡回している`).not.toContain(cur.id);
        seen.push(cur.id);
        cur = cur.onDefeat === null ? null : missionById(cur.onDefeat);
      }
      expect(seen.length).toBeLessThanOrEqual(MISSIONS.length);
    }
  });

  it('本線を勝ち続けると 06§13 の 5 話を順に通る', () => {
    const main = mainMissionsOfChapter(1);
    let cur: Mission | null = main[0]!;
    const visited: string[] = [];
    while (cur !== null) {
      visited.push(cur.id);
      cur = cur.onVictory === null ? null : missionById(cur.onVictory);
    }
    expect(visited).toEqual(main.map((m) => m.id));
  });

  it('全部負け続けても章の最後まで進める（ゲームオーバーが無い）', () => {
    const main = mainMissionsOfChapter(1);
    // 敗北条件を持つ最初の話から負け続ける。
    const start = main.find((m) => m.defeat.length > 0)!;
    let progress = emptyProgress();
    let cur: Mission | null = start;
    let steps = 0;
    while (cur !== null && steps < MISSIONS.length * 2) {
      progress = recordOutcome(progress, cur.id, 'defeat', steps);
      cur = progress.current === null ? null : missionById(progress.current);
      steps += 1;
    }
    // 途中で行き止まりにならず、履歴には服属ルートが並ぶ。
    expect(progress.history.length).toBeGreaterThan(1);
    expect(vassalRecords(progress).length).toBeGreaterThan(0);
    expect(progress.current).toBeNull(); // 章の終端まで進んだ
  });
});
