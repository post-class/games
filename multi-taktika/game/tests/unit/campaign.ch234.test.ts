/**
 * T-M16-04: 第 2〜4 章（各 5 ミッション + 服属ルート）
 *
 * 完了条件は「**全 4 章 20 ミッション（+ 服属ルート）が定義され、検証を通り、
 * 勝利条件に到達できる**」こと。ここで見るのは
 *
 *  1. 構造 ―― 章 = 時代（青銅 / 鉄器 / 帝国）に対応し、各章に本線 5 話がある
 *  2. 分岐 ―― 本線は次の話へ、服属ルートは勝てば本線に戻る（`02` の「旗を戻す」）
 *  3. 中身 ―― 章ごとにマップ型・相手の文明・勝利条件が変わる（同じことの繰り返しにしない）
 *  4. **プレイ可能性** ―― 令と生産の `Command` だけで勝利条件に到達できる
 *
 * 4 は第 1 章のテスト（`campaign.runner.test.ts`）と**同じ方式**にしてある
 * （「不足している令を立っている戦域に渡す + 村人を出す」だけの `Command` 列）。
 * World を直接いじって勝たせるのでは「遊べる」ことの証明にならないため。
 *
 * ミッション固有の数値はこのファイルに書かない（すべて定義から引く）。
 */

import { describe, expect, it } from 'vitest';

import {
  campaignChapters,
  createMissionRun,
  mainMissionsOfChapter,
  missionById,
  missionsOfChapter,
} from '@/campaign';
import type { Mission, MissionRun } from '@/campaign';
import { EntityKind, ageIndex } from '@/shared/types';
import type { OrderId } from '@/shared/types';
import type { Command } from '@/sim';
import { MAX_FRONTS, idOfIndex } from '@/sim';
import { buildingIndex } from '@/sim/core/defs';

/** 本編の章（第 1 章は `campaign.runner.test.ts` が見ているのでここでは第 2 章以降）。 */
const STORY_CHAPTERS: readonly number[] = [2, 3, 4];

/** 1 ミッションに与える tick 予算。 */
const TICK_BUDGET = 30000;

/** 村人の生産を発注する間隔（tick）。 */
const PRODUCE_INTERVAL = 100;

// ---------------------------------------------------------------------------
// 純関数（DOM も World も触らない）
// ---------------------------------------------------------------------------

/** まだ満たしていない `holdFrontsWithOrder` が要求する令を、要求順に並べる。 */
function neededOrders(run: MissionRun): OrderId[] {
  const out: OrderId[] = [];
  for (const o of run.objectives()) {
    if (o.condition.type !== 'holdFrontsWithOrder' || o.met) continue;
    for (let k = 0; k < o.condition.count; k++) out.push(o.condition.order);
  }
  return out;
}

/** そのミッションが要求する令の集合（定義だけから決まる）。 */
function requiredOrders(m: Mission): string[] {
  const out: string[] = [];
  for (const c of m.victory) {
    if (c.type === 'holdFrontsWithOrder' && !out.includes(c.order)) out.push(c.order);
  }
  return out;
}

/** 勝利条件の「型」の並び（章ごとに違うことを見るのに使う）。 */
function victoryShape(m: Mission): string {
  return m.victory.map((c) => c.type).join('+');
}

// ---------------------------------------------------------------------------
// 実際に遊ぶ
// ---------------------------------------------------------------------------

/** 自軍の町の中心の EntityId（無ければ -1）。 */
function ownTownCenter(run: MissionRun): number {
  const e = run.world.entities;
  const typeId = buildingIndex('town_center');
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.typeId[i] !== typeId || e.owner[i] !== run.self) continue;
    return idOfIndex(e, i);
  }
  return -1;
}

/**
 * 「求められている令を、立っている戦域へ順に渡す」だけの操作でミッションを進める
 * （第 1 章のテストと同じ関数）。
 */
function play(missionId: string, budget = TICK_BUDGET): MissionRun {
  const mission = missionById(missionId);
  expect(mission, `ミッション ${missionId} が定義にありません`).not.toBeNull();
  const run = createMissionRun(mission!);
  const w = run.world;
  const tc = ownTownCenter(run);
  for (let n = 0; n < budget && run.outcome() === 'running'; n++) {
    const cmds: Command[] = [];
    const want = neededOrders(run);
    let wi = 0;
    for (let s = 0; s < MAX_FRONTS && wi < want.length; s++) {
      const f = w.fronts[run.self * MAX_FRONTS + s]!;
      if (!f.active) continue;
      const order = want[wi]!;
      wi += 1;
      if (f.order === order || f.pendingOrder !== null) continue;
      cmds.push({ t: 'setOrder', p: run.self, front: f.slot, order, tier: 'upper' });
    }
    if (want.length === 0 && tc >= 0 && w.tick % PRODUCE_INTERVAL === 0) {
      cmds.push({ t: 'produce', p: run.self, building: tc, unit: 'villager', count: 1 });
    }
    run.step(cmds);
  }
  return run;
}

// ---------------------------------------------------------------------------
// 1. 構造
// ---------------------------------------------------------------------------

describe('T-M16-04 第 2〜4 章の構造', () => {
  it('全 4 章が並び、章 = 時代に対応している', () => {
    const chapters = campaignChapters();
    // 章番号は 1 から連番（章選択画面が「時代順」に並べられること）。
    expect(chapters.map((c) => c.chapter)).toEqual(chapters.map((_, i) => i + 1));
    // 章が進むと開始時代も進む（同じ時代を 2 章続けない）。
    const ages = chapters.map((c) => c.age);
    expect(new Set(ages).size).toBe(chapters.length);
    // どの章も本線 5 話。
    for (const c of chapters) expect(c.missionCount).toBe(chapters[0]!.missionCount);
  });

  for (const ch of STORY_CHAPTERS) {
    describe(`第 ${ch} 章`, () => {
      const main = mainMissionsOfChapter(ch);
      const info = campaignChapters().find((c) => c.chapter === ch);

      it('本線が 5 話あり、話数が 1 から連番', () => {
        expect(main.length).toBe(5);
        expect(main.map((m) => m.index)).toEqual([1, 2, 3, 4, 5]);
      });

      it('開始時代が章の時代と一致する', () => {
        expect(info).toBeDefined();
        for (const m of main) expect(m.setup.startAge).toBe(info!.age);
      });

      it('全話に服属ルートがある（負けても先へ進める）', () => {
        const vassal = missionsOfChapter(ch).filter((m) => m.route === 'vassal');
        expect(vassal.map((m) => m.index)).toEqual([1, 2, 3, 4, 5]);
        for (const m of main) {
          expect(m.defeat.length, `${m.id} に敗北条件がありません`).toBeGreaterThan(0);
          expect(m.onDefeat, `${m.id}.onDefeat が空です`).not.toBeNull();
          expect(missionById(m.onDefeat!)!.route).toBe('vassal');
        }
      });

      it('本線は次の話へ進み、最後の話で章が終わる', () => {
        for (let i = 0; i < main.length - 1; i++) {
          expect(main[i]!.onVictory).toBe(main[i + 1]!.id);
        }
        expect(main[main.length - 1]!.onVictory).toBeNull();
      });

      it('服属ルートは勝てば本線に戻る（旗を戻す）', () => {
        for (const v of missionsOfChapter(ch).filter((m) => m.route === 'vassal')) {
          if (v.onVictory === null) continue; // 章の終端
          const next = missionById(v.onVictory)!;
          expect(next.route).toBe('main');
          expect(next.chapter).toBe(ch);
          // 服属で勝ったら「その次の話」に復帰する（同じ話をもう一度やらせない）。
          expect(next.index).toBe(v.index + 1);
        }
      });

      it('服属ルートは本線より立場が悪い（開始資源か兵が減っている）', () => {
        for (const v of missionsOfChapter(ch).filter((m) => m.route === 'vassal')) {
          const base = main.find((m) => m.index === v.index)!;
          const own = (m: Mission): number =>
            m.setup.units.filter((u) => u.player === m.setup.player).reduce((n, u) => n + u.count, 0);
          const worse = v.setup.startResources !== base.setup.startResources || own(v) < own(base);
          expect(worse, `${v.id} が本線より易しくなっています`).toBe(true);
        }
      });

      it('操作説明ではなく状況説明の brief / hints が入っている', () => {
        for (const m of missionsOfChapter(ch)) {
          expect(m.brief.length).toBeGreaterThan(0);
          expect(m.hints.length).toBeGreaterThan(0);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. 章が進むと戦域が増え、同じことの繰り返しにならない
// ---------------------------------------------------------------------------

describe('T-M16-04 章ごとの作り分け', () => {
  it('章が進むと「一度に抱えられる戦域」が増える', () => {
    /**
     * 定義から測れる戦域スロット数（`03§2`）。時代で 1..4、城 1 棟ごとに +1。
     * 第 1 章は操作の練習で時代を先取りしている（第 5 話が鉄器）ので、
     * 本編の第 2 章以降だけで単調増加を見る。
     */
    const slots = (m: Mission): number => {
      const castles = m.setup.buildings.filter(
        (b) => b.player === m.setup.player && b.building === 'castle',
      ).length;
      return ageIndex(m.setup.startAge) + 1 + castles;
    };
    const maxSlots = (ch: number): number =>
      mainMissionsOfChapter(ch).reduce((n, m) => Math.max(n, slots(m)), 0);
    expect(maxSlots(2)).toBeLessThan(maxSlots(3));
    expect(maxSlots(3)).toBeLessThan(maxSlots(4));
    // 第 4 章は上限（`MAX_FRONTS`）まで抱えられる。
    expect(maxSlots(4)).toBe(MAX_FRONTS);
  });

  it('章が進むと要求される令の種類が増える', () => {
    const kinds = (ch: number): number => {
      const s = new Set<string>();
      for (const m of mainMissionsOfChapter(ch)) for (const o of requiredOrders(m)) s.add(o);
      return s.size;
    };
    expect(kinds(3)).toBeGreaterThanOrEqual(kinds(2));
    expect(kinds(4)).toBeGreaterThanOrEqual(kinds(3));
  });

  it('章の中でマップ型・相手の文明・勝利条件の形が使い回されすぎていない', () => {
    for (const ch of STORY_CHAPTERS) {
      const main = mainMissionsOfChapter(ch);
      // マップ型は 5 話中 3 種類以上。
      expect(new Set(main.map((m) => m.setup.map)).size, `第 ${ch} 章のマップ型`).toBeGreaterThanOrEqual(3);
      // 相手の文明も 3 種類以上（自分の文明は除く）。
      const foes = new Set<string>();
      for (const m of main) {
        m.setup.civs.forEach((c, i) => {
          if (i !== m.setup.player) foes.add(c);
        });
      }
      expect(foes.size, `第 ${ch} 章の相手の文明`).toBeGreaterThanOrEqual(3);
      // 勝利条件の形も 3 種類以上。
      expect(new Set(main.map(victoryShape)).size, `第 ${ch} 章の勝利条件`).toBeGreaterThanOrEqual(3);
    }
  });

  it('攻城の令は鉄器の世から出てくる（03§2 の解禁時期）', () => {
    for (const m of mainMissionsOfChapter(2)) {
      expect(requiredOrders(m), `${m.id} で包囲を要求しています`).not.toContain('siege');
    }
    const later = [...mainMissionsOfChapter(3), ...mainMissionsOfChapter(4)];
    expect(later.some((m) => requiredOrders(m).includes('siege'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. プレイ可能性（勝利条件に到達できる）
// ---------------------------------------------------------------------------

for (const ch of STORY_CHAPTERS) {
  describe(`T-M16-04 第 ${ch} 章はプレイ可能`, () => {
    for (const m of missionsOfChapter(ch)) {
      const label = m.route === 'vassal' ? '服属' : '本線';
      it(`第 ${m.index} 話「${m.title}」（${label}）で勝利条件が満たせる`, () => {
        const run = play(m.id);
        expect(
          run.outcome(),
          `残り目標: ${JSON.stringify(run.objectives().filter((o) => !o.met))}`,
        ).toBe('victory');
      });
    }
  });
}
