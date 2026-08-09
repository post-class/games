/**
 * tests/unit/ui.campaign.test.ts — キャンペーン章選択画面の純関数（T-M16-05 / `05§5`）
 *
 * この環境に DOM は無い（`vitest.config.ts` の `environment: 'node'`）ので、
 * 画面の判定と文言は**すべて DOM を触らない純関数**に分けてある。ここで見るのは
 *
 *  - 章の並べ方と解放判定（`05§5-2` / `05§5-3`）
 *  - ミッションプレートの状態（未挑戦・クリア・現在地・未解放。`05§5-6`）
 *  - **服属ルートを通った履歴が残ること**（`05§5-1` / `02`「この世界に滅亡はない」）
 *  - 目標（`victory`）が日本語 1 行になること（`05§5-6` の「目標が読める」）
 *
 * ミッション固有の数値・タイトルはこのファイルに書かない（定義から引く）。
 */

import { describe, expect, it } from 'vitest';

import {
  campaignChapters,
  emptyProgress,
  firstMissionOfChapter,
  mainMissionsOfChapter,
  missionById,
  missionsOfChapter,
  recordOutcome,
  MISSIONS,
} from '@/campaign';
import type { CampaignProgress } from '@/campaign';
import { AGE_IDS, MAP_TYPE_IDS } from '@/shared/types';
import {
  ageLabel,
  chapterState,
  chapterStateLabel,
  chapterViews,
  conditionText,
  hiddenChapterCount,
  isChapterUnlocked,
  mapLabel,
  missionHeading,
  missionState,
  missionStateLabel,
  missionViews,
  playableId,
  progressSummary,
  tickText,
  vassalLines,
  vassalRecordText,
} from '@/ui/screens/Campaign';

/** 何もしていない状態。 */
function fresh(): CampaignProgress {
  return emptyProgress();
}

/** そのミッションをクリアした状態にする（`recordOutcome` = 実装と同じ道を通す）。 */
function afterVictory(progress: CampaignProgress, id: string): CampaignProgress {
  return recordOutcome(progress, id, 'victory', 0);
}

/** そのミッションに負けた状態にする（服属ルートへ分岐する）。 */
function afterDefeat(progress: CampaignProgress, id: string, tick = 0): CampaignProgress {
  return recordOutcome(progress, id, 'defeat', tick);
}

const FIRST_CHAPTER = campaignChapters()[0]!.chapter;
const SECOND_CHAPTER = campaignChapters()[1]!.chapter;

// ---------------------------------------------------------------------------
// 章の並べ方と解放（05§5-2 / 05§5-3）
// ---------------------------------------------------------------------------

describe('章の並べ方（05§5-2）', () => {
  it('最初は先頭の章だけが並び、残りは並ばない', () => {
    const p = fresh();
    const views = chapterViews(p);
    expect(views.map((v) => v.info.chapter)).toEqual([FIRST_CHAPTER]);
    expect(hiddenChapterCount(p)).toBe(campaignChapters().length - 1);
  });

  it('前の章の話を 1 つクリアすると次の章が開く（05§5-3）', () => {
    const p = afterVictory(fresh(), firstMissionOfChapter(FIRST_CHAPTER)!.id);
    expect(isChapterUnlocked(p, SECOND_CHAPTER)).toBe(true);
    expect(chapterViews(p).map((v) => v.info.chapter)).toEqual([FIRST_CHAPTER, SECOND_CHAPTER]);
    expect(hiddenChapterCount(p)).toBe(campaignChapters().length - 2);
  });

  it('章は時代順に並び、章 = 時代に対応する（05§5-2）', () => {
    // 全章を開けた状態を作る（各章の第 1 話をクリアしていく）。
    let p = fresh();
    for (const c of campaignChapters()) p = afterVictory(p, firstMissionOfChapter(c.chapter)!.id);
    const views = chapterViews(p);
    expect(views.length).toBe(campaignChapters().length);
    const ages = views.map((v) => v.info.age);
    // 時代 ID の並び（`AGE_IDS`）どおりに単調に進む。
    for (let i = 1; i < ages.length; i++) {
      expect(AGE_IDS.indexOf(ages[i]!)).toBeGreaterThan(AGE_IDS.indexOf(ages[i - 1]!));
    }
  });

  it('全話クリアした章は「達成」、途中の章は「進行中」（05§5-1 / 05§5-2）', () => {
    let p = fresh();
    for (const m of mainMissionsOfChapter(FIRST_CHAPTER)) p = afterVictory(p, m.id);
    expect(chapterState(p, FIRST_CHAPTER)).toBe('cleared');
    expect(chapterState(p, SECOND_CHAPTER)).toBe('current');
    expect(chapterStateLabel('cleared')).not.toBe(chapterStateLabel('current'));
  });

  it('碑の解読はクリアした話数ぶん進む（05§5-5）', () => {
    const first = firstMissionOfChapter(FIRST_CHAPTER)!;
    const p = afterVictory(fresh(), first.id);
    const v = chapterViews(p).find((x) => x.info.chapter === FIRST_CHAPTER)!;
    expect(v.total).toBe(mainMissionsOfChapter(FIRST_CHAPTER).length);
    expect(v.decoded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ミッションプレート（05§5-6）
// ---------------------------------------------------------------------------

describe('ミッションプレート（05§5-6）', () => {
  it('章が開いていれば第 1 話は挑戦でき、先の話は開いていない', () => {
    const p = fresh();
    const main = mainMissionsOfChapter(FIRST_CHAPTER);
    expect(missionState(p, main[0]!)).toBe('open');
    for (let i = 1; i < main.length; i++) expect(missionState(p, main[i]!)).toBe('locked');
  });

  it('クリア・現在地・未挑戦が見分けられる', () => {
    const main = mainMissionsOfChapter(FIRST_CHAPTER);
    const p = afterVictory(fresh(), main[0]!.id);
    expect(missionState(p, main[0]!)).toBe('cleared');
    // 勝ったら `onVictory` が現在地になる。
    expect(p.current).toBe(main[0]!.onVictory);
    expect(missionState(p, main[1]!)).toBe('current');
    const labels = (['cleared', 'current', 'open', 'locked'] as const).map(missionStateLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('未解放の章のミッションは開いていない', () => {
    const p = fresh();
    for (const m of mainMissionsOfChapter(SECOND_CHAPTER)) {
      expect(missionState(p, m)).toBe('locked');
    }
  });

  it('プレートは本線 5 枚で、話数昇順に並ぶ', () => {
    let p = fresh();
    for (const c of campaignChapters()) p = afterVictory(p, firstMissionOfChapter(c.chapter)!.id);
    for (const c of campaignChapters()) {
      const rows = missionViews(p, c.chapter);
      expect(rows.length).toBe(mainMissionsOfChapter(c.chapter).length);
      expect(rows.map((r) => r.mission.index)).toEqual(rows.map((_, i) => i + 1));
      for (const r of rows) expect(r.mission.route).toBe('main');
    }
  });
});

// ---------------------------------------------------------------------------
// 服属ルートの履歴（05§5-1 / 05§5-4 / 02）
// ---------------------------------------------------------------------------

describe('服属ルートの履歴（05§5-1 / 05§5-4）', () => {
  /** 服属ルートを持つ最初の本線ミッション。 */
  const branching = MISSIONS.find((m) => m.route === 'main' && m.onDefeat !== null)!;

  it('負けても終わらず、服属ルートが現在地になる（02 の服属）', () => {
    const p = afterDefeat(fresh(), branching.id);
    expect(p.current).toBe(branching.onDefeat);
    expect(missionById(p.current!)!.route).toBe('vassal');
  });

  it('服属ルートを通ると、その話のプレートに二股が出る（05§5-4）', () => {
    const before = missionViews(fresh(), branching.chapter).find(
      (r) => r.mission.id === branching.id,
    )!;
    expect(before.branched).toBe(false);
    expect(before.vassal).not.toBeNull();

    const p = afterDefeat(fresh(), branching.id);
    const after = missionViews(p, branching.chapter).find((r) => r.mission.id === branching.id)!;
    expect(after.branched).toBe(true);
    expect(after.vassal!.id).toBe(branching.onDefeat);
  });

  it('服属ルートの記録が残り、旗を巻いた / 旗を戻したが読み分けられる', () => {
    const vassalId = branching.onDefeat!;
    let p = afterDefeat(fresh(), branching.id);
    expect(vassalLines(p)).toEqual([]); // まだ服属ルートを「決着」していない
    p = afterDefeat(p, vassalId, 1000);
    const lostLines = vassalLines(p);
    expect(lostLines.length).toBe(1);
    expect(lostLines[0]).toContain('旗を巻いたまま');

    let q = afterDefeat(fresh(), branching.id);
    q = afterVictory(q, vassalId);
    const wonLines = vassalLines(q);
    expect(wonLines.length).toBe(1);
    expect(wonLines[0]).toContain('旗を戻して本線に復帰');
    // 勝ったら本線に戻る（`02`「そこで勝てば旗を戻して本線に復帰」）。
    expect(missionById(q.current!)!.route).toBe('main');
  });

  it('記録は新しいものが先に並ぶ', () => {
    const chapter = branching.chapter;
    const vassals = missionsOfChapter(chapter).filter((m) => m.route === 'vassal');
    expect(vassals.length).toBeGreaterThan(1);
    let p = fresh();
    p = afterDefeat(p, vassals[0]!.id, 100);
    p = afterDefeat(p, vassals[1]!.id, 200);
    const lines = vassalLines(p);
    expect(lines[0]).toContain(vassals[1]!.title);
    expect(lines[1]).toContain(vassals[0]!.title);
  });

  it('1 件の記録は「どこで・どうなったか・いつか」を含む', () => {
    const vassal = MISSIONS.find((m) => m.route === 'vassal')!;
    const text = vassalRecordText({ mission: vassal.id, outcome: 'defeat', route: 'vassal', tick: 0 });
    expect(text).toContain(vassal.title);
    expect(text.length).toBeGreaterThan(vassal.title.length);
  });

  it('服属ルートに居るときは「はじめる」が服属ルートを指す', () => {
    const p = afterDefeat(fresh(), branching.id);
    expect(playableId(p, branching)).toBe(branching.onDefeat);
  });

  it('開いていない話は「はじめる」で遊べない', () => {
    const p = fresh();
    const locked = mainMissionsOfChapter(SECOND_CHAPTER)[0]!;
    expect(playableId(p, locked)).toBeNull();
    expect(playableId(p, mainMissionsOfChapter(FIRST_CHAPTER)[0]!)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 文言（目標が読めること）
// ---------------------------------------------------------------------------

describe('目標と説明の文言（05§5-6）', () => {
  it('全ミッションの勝利条件・敗北条件が日本語 1 行になる（ID が素で出ない）', () => {
    for (const m of MISSIONS) {
      for (const c of [...m.victory, ...m.defeat]) {
        const text = conditionText(m, c);
        expect(text.length, `${m.id}: ${c.type}`).toBeGreaterThan(0);
        // 条件の型名がそのまま出ていない（= 未知の型を素で流していない）。
        expect(text).not.toContain(c.type);
        expect(text).not.toContain('undefined');
        expect(text).not.toContain('NaN');
      }
    }
  });

  it('条件の型が全種類とも文章になる（定義に出てくる型を網羅）', () => {
    const seen = new Set<string>();
    for (const m of MISSIONS) for (const c of [...m.victory, ...m.defeat]) seen.add(c.type);
    // 第 1〜4 章を通して 4 種類以上の条件型が使われている。
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('見出しに章・話・タイトルが入り、服属ルートはそれが分かる', () => {
    const main = MISSIONS.find((m) => m.route === 'main')!;
    const vassal = MISSIONS.find((m) => m.route === 'vassal')!;
    expect(missionHeading(main)).toContain(main.title);
    expect(missionHeading(main)).not.toContain('服属ルート');
    expect(missionHeading(vassal)).toContain('服属ルート');
  });

  it('時代とマップ型が ID ではなく名前で出る', () => {
    for (const age of AGE_IDS) expect(ageLabel(age)).not.toBe(age);
    for (const map of MAP_TYPE_IDS) expect(mapLabel(map)).not.toBe(map);
  });

  it('tick は Date.now() ではなく試合内の時間として読める', () => {
    expect(tickText(0)).toContain('秒');
    expect(tickText(3000)).toContain('分');
  });

  it('ヘッダの 1 行が「まだ始めていない」と「次はどこか」を出し分ける', () => {
    const p = fresh();
    expect(progressSummary(p)).toContain('まだ始めていません');
    const q = afterVictory(p, firstMissionOfChapter(FIRST_CHAPTER)!.id);
    expect(progressSummary(q)).toContain(missionById(q.current!)!.title);
    // 服属の記録があると件数が出る。
    const branching = MISSIONS.find((m) => m.route === 'main' && m.onDefeat !== null)!;
    let r = afterDefeat(fresh(), branching.id);
    r = afterDefeat(r, branching.onDefeat!, 500);
    expect(progressSummary(r)).toContain('服属の記録');
  });
});
