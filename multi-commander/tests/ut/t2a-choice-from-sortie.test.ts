import { describe, expect, it } from 'vitest';
import {
  resolveVeilChoice,
  veilChapter,
  veilChoiceOption,
  veilConditionMet,
  VEIL_CHAPTERS,
  type VeilSortieFacts,
} from '../../src/content/veil/chapters';
import { gateOutcomeFromChoice, isGateOutcome } from '../../src/content/campaign';
import { ChoiceScene } from '../../src/ui/ChoiceScene';
import { installFakeDom, type FakeElement } from './fake-dom';

/**
 * T2-④ 章末の選択を、その出撃から生やす。
 *
 * 守りたい不変条件は2つ。
 *   1. 出撃結果で選択肢の中身と状況説明の1行が変わる
 *   2. **どの出撃結果でも必ず2つ以上の選択肢が出る**（0個になると章が進まなくなる）
 */

const NOTHING: VeilSortieFacts = {
  rescued: 0,
  enemyRescued: 0,
  escortSurvivors: 0,
  escortTotal: 0,
  wingmenSurvived: 0,
  wingmenLost: 0,
  shotsFired: 0,
};
const facts = (over: Partial<VeilSortieFacts> = {}): VeilSortieFacts => ({ ...NOTHING, ...over });

/** 実際に起こりうる出撃結果の組み合わせ（網羅テストの入力） */
const CASES: Array<{ name: string; facts: VeilSortieFacts }> = [
  { name: '何もできなかった', facts: facts() },
  { name: '救助あり・撃った', facts: facts({ rescued: 3, shotsFired: 200 }) },
  { name: '救助あり・一発も撃たず', facts: facts({ rescued: 1 }) },
  { name: '敵側だけ救助', facts: facts({ enemyRescued: 2, shotsFired: 40 }) },
  { name: '救助なし・撃った', facts: facts({ shotsFired: 500 }) },
  { name: '護衛を守り切った', facts: facts({ escortSurvivors: 4, escortTotal: 4, shotsFired: 90 }) },
  { name: '護衛を失った', facts: facts({ escortSurvivors: 0, escortTotal: 4, shotsFired: 90 }) },
  { name: '僚機生還', facts: facts({ wingmenSurvived: 1, shotsFired: 10 }) },
  { name: '僚機戦死', facts: facts({ wingmenLost: 1, shotsFired: 10 }) },
  {
    name: '全部やった',
    facts: facts({ rescued: 3, enemyRescued: 1, escortSurvivors: 2, escortTotal: 2, wingmenSurvived: 1, shotsFired: 300 }),
  },
];

describe('T2-④ 条件判定', () => {
  it('救助は味方・敵側の合計で数える', () => {
    expect(veilConditionMet('rescuedAny', facts({ enemyRescued: 1 }))).toBe(true);
    expect(veilConditionMet('rescuedNone', facts({ rescued: 1 }))).toBe(false);
    expect(veilConditionMet('rescuedNone', facts())).toBe(true);
  });

  it('発砲・護衛・僚機の条件が出撃結果どおりに判定される', () => {
    expect(veilConditionMet('noShotsFired', facts())).toBe(true);
    expect(veilConditionMet('firedShots', facts({ shotsFired: 1 }))).toBe(true);
    expect(veilConditionMet('escortHeld', facts({ escortSurvivors: 2, escortTotal: 2 }))).toBe(true);
    expect(veilConditionMet('escortLostAny', facts({ escortSurvivors: 1, escortTotal: 2 }))).toBe(true);
    expect(veilConditionMet('wingmanHome', facts({ wingmenSurvived: 1 }))).toBe(true);
    expect(veilConditionMet('wingmanDown', facts({ wingmenLost: 1 }))).toBe(true);
  });

  it('護衛対象のない出撃は「守り切った」として扱う（喪失にしない）', () => {
    expect(veilConditionMet('escortHeld', facts())).toBe(true);
    expect(veilConditionMet('escortLostAny', facts())).toBe(false);
  });

  it('条件なし・未知の条件は常に出す（章データの追記で画面を壊さない）', () => {
    expect(veilConditionMet(undefined, facts())).toBe(true);
    expect(veilConditionMet('always', facts())).toBe(true);
    expect(veilConditionMet('unknown-condition' as never, facts())).toBe(true);
  });
});

describe('T2-④ 第1章 — 救助した／しなかったで選択肢が変わる', () => {
  const ch01 = veilChapter(1);

  it('救助していれば「救難」が選べ、していなければ別の選択肢に差し替わる', () => {
    const rescued = resolveVeilChoice(ch01.choice, facts({ rescued: 2, shotsFired: 100 }));
    const empty = resolveVeilChoice(ch01.choice, facts({ shotsFired: 100 }));
    const ids = (c: { options: Array<{ id: string }> }) => c.options.map((o) => o.id);

    expect(ids(rescued)).toContain('rescue');
    expect(ids(rescued)).not.toContain('port-request');
    expect(ids(empty)).not.toContain('rescue');
    expect(ids(empty)).toContain('port-request');
    // 追撃はどちらでも選べる（方針の表明として残す）
    expect(ids(rescued)).toContain('pursue');
    expect(ids(empty)).toContain('pursue');
    expect(rescued.options).toHaveLength(2);
    expect(empty.options).toHaveLength(2);
  });

  it('選択肢の前の1行が出撃結果で差し替わる', () => {
    const rescued = resolveVeilChoice(ch01.choice, facts({ rescued: 2 }));
    const empty = resolveVeilChoice(ch01.choice, facts());
    expect(rescued.note).not.toBe(empty.note);
    expect(rescued.note).toContain('名簿');
    expect(empty.note).toContain('空白');
    // 問いと見出しは差し替えない（章の同一性を保つ）
    expect(rescued.kind).toBe(ch01.choice.kind);
    expect(rescued.question).toBe(ch01.choice.question);
  });

  it('差し替わった選択肢は4状態への効果も別物になる', () => {
    const rescue = veilChoiceOption(1, 'rescue');
    const fallback = veilChoiceOption(1, 'port-request');
    expect(fallback.effects).not.toEqual(rescue.effects);
    // 救助していない章では帰還者の伸びが小さい
    expect(fallback.effects.returnees ?? 0).toBeLessThan(rescue.effects.returnees ?? 0);
  });
});

describe('T2-④ 10章すべて — どの出撃結果でも選択肢が2つ以上出る', () => {
  it('全10章 × 全ケースで選択肢が2つ以上、idが重複しない', () => {
    for (const chapter of VEIL_CHAPTERS) {
      for (const c of CASES) {
        const resolved = resolveVeilChoice(chapter.choice, c.facts);
        expect(
          resolved.options.length,
          `第${chapter.chapter}章 / ${c.name} の選択肢が ${resolved.options.length} 個`,
        ).toBeGreaterThanOrEqual(2);
        const ids = resolved.options.map((o) => o.id);
        expect(new Set(ids).size, `第${chapter.chapter}章 / ${c.name} で id が重複`).toBe(ids.length);
        // 出た選択肢はすべて id で引ける（保存データから復元できる）
        for (const id of ids) expect(() => veilChoiceOption(chapter.chapter, id)).not.toThrow();
        // 状況説明は必ず1行ある
        expect(resolved.note.length, `第${chapter.chapter}章 / ${c.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('条件付きの選択肢を持つ章には、必ず裏返しの代替が用意されている', () => {
    for (const chapter of VEIL_CHAPTERS) {
      const conditioned = chapter.choice.options.filter((o) => o.when && o.when !== 'always');
      if (conditioned.length === 0) continue;
      expect(
        (chapter.choice.fallbackOptions ?? []).length,
        `第${chapter.chapter}章 に fallbackOptions がない`,
      ).toBeGreaterThanOrEqual(1);
      // 条件付きが消える出撃結果でも、選択肢の数は変わらない
      const held = resolveVeilChoice(chapter.choice, facts({ rescued: 2, shotsFired: 100 })).options.length;
      const none = resolveVeilChoice(chapter.choice, facts()).options.length;
      expect(held, `第${chapter.chapter}章`).toBe(none);
    }
  });

  it('第10章の3択は出撃結果で消えない（結末idと1対1のため）', () => {
    const ch10 = veilChapter(10);
    for (const c of CASES) {
      const resolved = resolveVeilChoice(ch10.choice, c.facts);
      expect(resolved.options.map((o) => o.id), c.name).toEqual([
        'seal-gate',
        'limited-open',
        'joint-custody',
      ]);
      for (const option of resolved.options) {
        expect(isGateOutcome(gateOutcomeFromChoice(option.id))).toBe(true);
      }
    }
    // 状況説明だけが出撃結果で変わる
    expect(resolveVeilChoice(ch10.choice, facts({ rescued: 1 })).note).not.toBe(
      resolveVeilChoice(ch10.choice, facts()).note,
    );
  });

  it('第9章は錨の選択が常に3つ以上ある', () => {
    for (const c of CASES) {
      expect(resolveVeilChoice(veilChapter(9).choice, c.facts).options.length, c.name).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('T2-④ 差し替えた選択肢が画面に出る', () => {
  it('救助しなかった第1章の選択画面に代替の選択肢が描かれ、選べる', () => {
    const dom = installFakeDom();
    try {
      const resolved = resolveVeilChoice(veilChapter(1).choice, facts({ shotsFired: 100 }));
      const picked: string[] = [];
      const scene = new ChoiceScene({ choice: resolved, onSelect: (id) => picked.push(id) });
      const root = scene.el as unknown as FakeElement;
      const options = dom.findAll(root, 'mc-choice-option');
      expect(options.map((el) => el.dataset.choiceId)).toEqual(['pursue', 'port-request']);
      // 状況説明の1行も差し替え後のものが出る
      expect(dom.text(root)).toContain(resolved.note);
      expect(dom.text(root)).toContain('救難隊の派遣を要請');
      options[1].fire('click');
      expect(picked).toEqual(['port-request']);
    } finally {
      dom.restore();
    }
  });
});
