/**
 * T-M16-01 / T-M16-02: ミッション定義フォーマットと第 1 章 5 ミッション
 *
 * 完了条件の検証:
 *  - T-M16-01「**JSON で完結し、コードにミッション固有分岐がない**」
 *      → `src/campaign/*.ts` にミッション ID・話数固有の語が 1 つも出てこないことを機械的に確認する
 *      → 壊れた定義は**起動時に例外**（`DataValidationError`）
 *  - T-M16-02「5 ミッションが `06§13` の練習メニューどおり」
 *      → 順序・タイトル・使う令（突撃 / 死守 + 突撃 / 後退 / 略奪 + 包囲）を定義から照合する
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  MISSIONS,
  campaignChapters,
  firstMissionOfChapter,
  mainMissionsOfChapter,
  missionById,
  missionsOfChapter,
  parseMission,
} from '@/campaign';
import type { Mission, MissionCondition } from '@/campaign';
import { DataValidationError } from '@/data/validate';

/** 第 1 章の本線の話数（`06§13` の練習メニューは 5 つ）。 */
const CHAPTER1_MAIN_COUNT = 5;

/** `06§13` の練習メニューの順序（タイトルの一部で照合する）。 */
const PRACTICE_MENU_ORDER = ['最初の 5 分', '戦域が 1 つ立つ', '2 つ目が立つ', '捨てる判断', '攻城'];

/**
 * `06§13` の各話で覚える令。
 * 1 話は内政のみ（令なし）、2 話は突撃、3 話は死守 + 突撃、4 話は後退、5 話は略奪 + 包囲。
 */
const PRACTICE_MENU_ORDERS: readonly (readonly string[])[] = [
  [],
  ['charge'],
  ['hold', 'charge'],
  ['retreat'],
  ['raid', 'siege'],
];

function ordersRequiredBy(m: Mission): string[] {
  const out: string[] = [];
  for (const c of m.victory) {
    if (c.type === 'holdFrontsWithOrder') out.push(c.order);
  }
  return out;
}

function conditionTypes(cs: readonly MissionCondition[]): string[] {
  return cs.map((c) => c.type);
}

/** 検証を通る最小の定義（壊し方を 1 つずつ試すための土台）。 */
function baseRaw(): Record<string, unknown> {
  return {
    id: 'test_m1',
    chapter: 9,
    index: 1,
    route: 'main',
    title: 'テスト',
    brief: 'テスト用の定義',
    hints: ['何かしてください'],
    setup: {
      map: 'plain',
      seed: 1,
      playerCount: 2,
      player: 0,
      civs: ['yamato', 'tou'],
      startAge: 'reimei',
      startResources: 'standard',
    },
    victory: [{ type: 'surviveTicks', ticks: 100 }],
    defeat: [],
    events: [],
    onVictory: null,
    onDefeat: null,
  };
}

describe('T-M16-01 ミッション定義フォーマット', () => {
  it('起動時に全定義が検証を通っている（通らなければ import で例外になる）', () => {
    expect(MISSIONS.length).toBeGreaterThan(0);
    for (const m of MISSIONS) {
      expect(m.hints.length).toBeGreaterThan(0);
      expect(m.victory.length).toBeGreaterThan(0);
      expect(m.setup.civs.length).toBe(m.setup.playerCount);
      expect(m.setup.teams.length).toBe(m.setup.playerCount);
      expect(m.setup.player).toBeLessThan(m.setup.playerCount);
    }
  });

  it('id が一意で、章 → 話数 → ルートの順に並んでいる', () => {
    const ids = MISSIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const rank = (m: Mission): number =>
      // 章 → 話数 → ルート（本線が先）を 1 つの単調増加な数にする。
      m.chapter * MISSIONS.length * 2 + m.index * 2 + (m.route === 'main' ? 0 : 1);
    for (let i = 1; i < MISSIONS.length; i++) {
      expect(rank(MISSIONS[i - 1]!)).toBeLessThan(rank(MISSIONS[i]!));
    }
  });

  it('src/data/campaign の JSON ファイル数とミッション数が一致する（読み落としが無い）', () => {
    const files = readdirSync('src/data/campaign').filter(
      (f) => f.endsWith('.json') && !f.startsWith('_'),
    );
    expect(MISSIONS.length).toBe(files.length);
  });

  it('コードにミッション固有の分岐が無い（campaign/*.ts にミッション ID が出てこない）', () => {
    const sources = readdirSync('src/campaign').filter((f) => f.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(0);
    for (const f of sources) {
      const text = readFileSync(`src/campaign/${f}`, 'utf8');
      for (const m of MISSIONS) {
        // ドキュメンテーションコメントの使用例だけは許す（`ch1_m1` を例に挙げている）。
        const codeOnly = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(codeOnly.includes(m.id), `${f} に ${m.id} が書かれています`).toBe(false);
      }
    }
  });

  it('壊れた定義は例外になる（未知の条件型 / 未知のユニット / 参照切れ）', () => {
    const brokenCases: readonly (readonly [string, (r: Record<string, unknown>) => void])[] = [
      ['未知の条件型', (r) => (r['victory'] = [{ type: 'winSomehow' }])],
      ['未知のユニット', (r) => (r['victory'] = [{ type: 'unitCountAtLeast', unit: 'dragon', count: 1 }])],
      ['未知の令', (r) => (r['victory'] = [{ type: 'holdFrontsWithOrder', order: 'banzai', count: 1, ticks: 1 }])],
      ['未知のマップ型', (r) => ((r['setup'] as Record<string, unknown>)['map'] = 'moon')],
      ['未知の開始資源プリセット', (r) => ((r['setup'] as Record<string, unknown>)['startResources'] = 'infinite')],
      ['範囲外のプレイヤー', (r) => (r['victory'] = [{ type: 'destroyAllTownCenters', target: 7 }])],
      ['勝利条件が空', (r) => (r['victory'] = [])],
      ['ヒントが無い', (r) => (r['hints'] = [])],
      ['未知のキー', (r) => (r['sutoorii'] = 'あらすじ')],
      ['atTick と when の同時指定', (r) => (r['events'] = [{ atTick: 1, when: { type: 'atTick', tick: 2 }, type: 'showHint', text: 'x' }])],
      ['発火条件が無いイベント', (r) => (r['events'] = [{ type: 'showHint', text: 'x' }])],
      ['敗北条件があるのに onDefeat が無い', (r) => {
        r['defeat'] = [{ type: 'loyaltyAtMostPercent', percent: 0 }];
        r['onVictory'] = 'test_m2';
        r['onDefeat'] = null;
      }],
    ];
    for (const [label, broke] of brokenCases) {
      const raw = baseRaw();
      broke(raw);
      expect(() => parseMission(raw, 'broken.json'), label).toThrow(DataValidationError);
    }
  });

  it('正しい定義は例外にならない', () => {
    expect(() => parseMission(baseRaw(), 'ok.json')).not.toThrow();
  });

  it('イベントは tick 番号か World の状態だけで発火する（時計に依存しない）', () => {
    for (const m of MISSIONS) {
      for (const ev of m.events) {
        expect(['atTick', 'frontOpened', 'condition']).toContain(ev.trigger.type);
      }
    }
  });
});

describe('T-M16-02 第 1 章 5 ミッション（06§13 の練習メニューそのまま）', () => {
  const main = mainMissionsOfChapter(1);

  it('本線は 5 話で、06§13 の順序どおり', () => {
    expect(main.length).toBe(CHAPTER1_MAIN_COUNT);
    main.forEach((m, i) => {
      expect(m.index).toBe(i + 1);
      expect(m.title).toContain(PRACTICE_MENU_ORDER[i]!);
    });
  });

  it('各話で覚える令が練習メニューと一致する（1 話は戦闘なし）', () => {
    main.forEach((m, i) => {
      const want = PRACTICE_MENU_ORDERS[i]!;
      const got = ordersRequiredBy(m);
      for (const order of want) expect(got, `第 ${i + 1} 話に ${order} が無い`).toContain(order);
      if (want.length === 0) {
        // 第 1 話は内政のみ = 敵プレイヤーを置かない。
        expect(m.setup.playerCount).toBe(1);
        expect(got.length).toBe(0);
      } else {
        expect(m.setup.playerCount).toBeGreaterThan(1);
      }
    });
  });

  it('第 1 話は内政の勝利条件（村人と採集）だけを持つ', () => {
    const m = main[0]!;
    expect(conditionTypes(m.victory).sort()).toEqual(['gatherResource', 'unitCountAtLeast']);
    // 戦闘が無いので敗北条件も無い（負けようがない）。
    expect(m.defeat.length).toBe(0);
  });

  it('第 5 話は攻城（門を落とす）', () => {
    const m = main[4]!;
    const gate = m.victory.find((c) => c.type === 'buildingCountAtMost');
    expect(gate).toBeDefined();
    // 門は敵側の建物として初期配置に置かれている。
    expect(m.setup.buildings.some((b) => b.player !== m.setup.player)).toBe(true);
  });

  it('各ミッションにヒント文が入っている', () => {
    for (const m of missionsOfChapter(1)) {
      expect(m.hints.length).toBeGreaterThan(0);
      expect(m.brief.length).toBeGreaterThan(0);
      for (const h of m.hints) expect(h.length).toBeGreaterThan(0);
    }
  });

  it('章の見出しと最初のミッションが引ける（章選択画面用）', () => {
    const chapters = campaignChapters();
    expect(chapters.length).toBeGreaterThan(0);
    expect(chapters[0]!.chapter).toBe(1);
    expect(chapters[0]!.missionCount).toBe(CHAPTER1_MAIN_COUNT);
    const first = firstMissionOfChapter(1);
    expect(first?.id).toBe(main[0]!.id);
    expect(missionById(main[0]!.id)).toBe(main[0]!);
    expect(missionById('存在しない')).toBeNull();
  });
});
