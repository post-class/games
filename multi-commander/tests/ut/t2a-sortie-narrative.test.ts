import { describe, expect, it } from 'vitest';
import {
  adjustNarrative,
  narrativeGrade,
  newNarrative,
  returneeScore,
  sortieNarrative,
  supportLevel,
  SORTIE_HEAD_CAP,
  SORTIE_TRUST_CAP,
  type SortieFacts,
} from '../../src/app/narrative';
import { DIFFICULTIES } from '../../src/app/settings';
import { VEIL_CHAPTERS } from '../../src/content/veil/chapters';

/**
 * T2-③ 状態値を行動と接続する。
 *
 * 検証したいのは「数値を見れば自分の飛び方が読める」こと。具体的には
 *   - 救助した／しなかったで4状態の動きが変わる
 *   - 動いた理由が内訳（gains / losses）として1行ずつ取り出せる
 *   - 章末の選択より飛んだ結果のほうが重い
 *   - 4状態は難易度パラメータに一切触らない（README の実装規約）
 */

/** 何もしていない出撃（第1章で「輸送船を守らず帰投」した状態に近い） */
const NOTHING: SortieFacts = {
  rescued: 0,
  enemyRescued: 0,
  escortSurvivors: 0,
  escortTotal: 0,
  wingmenSurvived: 0,
  wingmenLost: 0,
  civilianLosses: 0,
  friendlyFireHits: 0,
  shotsFired: 0,
  playerLost: false,
  objectivesFailed: 0,
  grade: 'failed',
};

const facts = (over: Partial<SortieFacts> = {}): SortieFacts => ({ ...NOTHING, ...over });

/** 第1章を「3名救助・輸送船1隻を守り切り・僚機生還」で飛んだ結果 */
const GOOD_CH01 = facts({
  rescued: 3,
  escortSurvivors: 1,
  escortTotal: 1,
  wingmenSurvived: 1,
  shotsFired: 240,
  grade: 'complete',
});
/** 同じ第1章を「救助0・輸送船喪失・僚機戦死」で飛んだ結果 */
const BAD_CH01 = facts({
  rescued: 0,
  escortSurvivors: 0,
  escortTotal: 1,
  wingmenLost: 1,
  shotsFired: 240,
  objectivesFailed: 3,
  grade: 'failed',
});

const lineOf = (result: ReturnType<typeof sortieNarrative>, key: string) =>
  result.lines.find((l) => l.key === key);

describe('T2-③ 出撃結果が4状態を動かす', () => {
  it('救助した出撃と、しなかった出撃で帰還者の増減が逆になる', () => {
    const good = sortieNarrative(GOOD_CH01);
    const bad = sortieNarrative(BAD_CH01);
    expect(lineOf(good, 'returnees')!.delta).toBeGreaterThan(0);
    expect(lineOf(bad, 'returnees')!.delta).toBeLessThan(0);
  });

  it('救助0・僚機戦死・輸送船喪失では4状態すべてが下がるか動かない', () => {
    const bad = sortieNarrative(BAD_CH01);
    for (const line of bad.lines) expect(line.delta, line.label).toBeLessThanOrEqual(0);
    expect(bad.delta.commandTrust).toBeLessThan(0);
    expect(bad.delta.routeTrust).toBeLessThan(0);
  });

  it('内訳に「なぜ動いたか」が理由ごとに並ぶ（合計だけにしない）', () => {
    const heads = lineOf(sortieNarrative(GOOD_CH01), 'returnees')!;
    const texts = heads.gains.map((g) => g.text);
    expect(texts).toContain('救助 3名');
    expect(texts).toContain('護衛対象 1隻を生存');
    expect(texts).toContain('僚機 1名が生還');
    expect(heads.losses).toHaveLength(0);

    const bad = lineOf(sortieNarrative(BAD_CH01), 'returnees')!;
    expect(bad.losses.map((l) => l.text)).toEqual(
      expect.arrayContaining(['僚機 1名が戦死', '護衛対象 1隻を喪失']),
    );
  });

  it('誤射・民間損害・自機喪失がそれぞれ理由として現れる', () => {
    const r = sortieNarrative(facts({ shotsFired: 100, friendlyFireHits: 2, civilianLosses: 1, playerLost: true }));
    const route = lineOf(r, 'routeTrust')!;
    expect(route.losses.map((l) => l.text)).toEqual(
      expect.arrayContaining(['誤射 2発', '民間損害 1隻']),
    );
    expect(lineOf(r, 'commandTrust')!.losses.map((l) => l.text)).toContain('機体喪失');
    expect(lineOf(r, 'aceOath')!.losses.map((l) => l.text)).toContain('誤射 2発');
  });

  it('一発も撃たずに守り切った出撃は航路信頼が上がる（第3章・第7章の飛び方）', () => {
    const quiet = sortieNarrative(facts({ escortSurvivors: 18, escortTotal: 18, grade: 'complete' }));
    const route = lineOf(quiet, 'routeTrust')!;
    expect(route.gains.map((g) => g.text)).toEqual(
      expect.arrayContaining(['一発も撃たずに完了', '誤射・民間損害なし', '護衛対象 18隻すべて生存']),
    );
    expect(route.delta).toBeGreaterThan(0);
  });

  it('達成度3段階が軍令信用の理由に出て、失敗はマイナスになる', () => {
    for (const [grade, sign] of [['complete', 1], ['partial', 1], ['failed', -1]] as const) {
      const line = lineOf(sortieNarrative(facts({ grade })), 'commandTrust')!;
      expect(Math.sign(line.delta), grade).toBe(sign);
    }
    expect(lineOf(sortieNarrative(facts({ grade: 'partial' })), 'commandTrust')!.gains[0].text).toBe('部分達成');
  });

  it('1出撃の振れ幅は上限でクランプされる（暴走しない）', () => {
    const huge = sortieNarrative(
      facts({ rescued: 50, enemyRescued: 50, escortSurvivors: 50, escortTotal: 50, grade: 'complete' }),
    );
    expect(lineOf(huge, 'returnees')!.delta).toBe(SORTIE_HEAD_CAP);
    for (const key of ['routeTrust', 'commandTrust', 'aceOath']) {
      const line = lineOf(huge, key);
      if (line) expect(Math.abs(line.delta), key).toBeLessThanOrEqual(SORTIE_TRUST_CAP);
    }
  });

  it('生還した僚機はクレジットから差し引かれる（名簿の名前と二重計上しない）', () => {
    const r = sortieNarrative(facts({ rescued: 2, wingmenSurvived: 1, grade: 'complete' }));
    expect(lineOf(r, 'returnees')!.delta).toBe(3);
    expect(r.namedHeads).toBe(1);
    // 名簿へ1名載るぶんを引いた残りがクレジット
    expect(r.delta.returneeCredit).toBe(2);
  });

  it('壊れた値でも例外にせず、既定として扱う', () => {
    const broken = sortieNarrative({ ...NOTHING, rescued: Number.NaN, grade: 'x' } as unknown as SortieFacts);
    expect(broken.lines.every((l) => Number.isFinite(l.delta))).toBe(true);
  });
});

describe('T2-③ 飛んだ結果 > 章末の選択', () => {
  it('章末の選択は1状態あたり最大5で、1出撃の上限12より小さい', () => {
    const all = VEIL_CHAPTERS.flatMap((c) => [...c.choice.options, ...(c.choice.fallbackOptions ?? [])]);
    for (const option of all) {
      for (const [key, value] of Object.entries(option.effects)) {
        if (typeof value !== 'number') continue;
        // 帰還者は人数、他3つは 0..100 の指標
        const limit = key === 'returnees' ? 2 : 5;
        expect(Math.abs(value), `${option.id} の ${key}`).toBeLessThanOrEqual(limit);
      }
    }
    expect(SORTIE_TRUST_CAP).toBeGreaterThan(5);
    expect(SORTIE_HEAD_CAP).toBeGreaterThan(2);
  });

  it('選択肢の増減の絶対値の合計は8で揃っている（fallback も含む）', () => {
    for (const chapter of VEIL_CHAPTERS) {
      for (const option of [...chapter.choice.options, ...(chapter.choice.fallbackOptions ?? [])]) {
        const total = Object.values(option.effects)
          .filter((v): v is number => typeof v === 'number')
          .reduce((a, v) => a + Math.abs(v), 0);
        expect(total, `第${chapter.chapter}章 ${option.id}`).toBe(8);
      }
    }
  });

  it('選択だけで帰還者が最低から最高へ飛ばない（報告された 0→80 の再発防止）', () => {
    const state = newNarrative();
    expect(narrativeGrade(returneeScore(state))).toBe('最低');
    // 第1章の選択で最も帰還者が上がるものを適用しても「最高」にはならない
    const best = Math.max(
      ...VEIL_CHAPTERS[0].choice.options.map((o) => o.effects.returnees ?? 0),
      ...(VEIL_CHAPTERS[0].choice.fallbackOptions ?? []).map((o) => o.effects.returnees ?? 0),
    );
    adjustNarrative(state, { returneeCredit: best });
    expect(narrativeGrade(returneeScore(state))).not.toBe('最高');

    // 飛んだ結果（3名救助・輸送船1隻・僚機生還）のほうが大きく動く
    const flown = newNarrative();
    const result = sortieNarrative(GOOD_CH01);
    adjustNarrative(flown, result.delta);
    adjustNarrative(flown, { returneeCredit: result.namedHeads });
    expect(returneeScore(flown)).toBeGreaterThan(returneeScore(state));
  });
});

describe('T2-③ 4状態は難易度を動かさない（README の実装規約）', () => {
  const extreme = (v: number) => ({ ...newNarrative(), routeTrust: v, commandTrust: v, aceOath: v });

  it('難易度プロファイルは4状態を参照しない（低い状態でも高い状態でも同一）', () => {
    const before = JSON.stringify(DIFFICULTIES);
    const low = supportLevel(extreme(0));
    const high = supportLevel(extreme(100));
    expect(JSON.stringify(DIFFICULTIES)).toBe(before);
    // 状態が変えるのは味方の顔ぶれ・援護・搭載兵装・無線だけ
    expect(Object.keys(low).sort()).toEqual([
      'commandRadioTone',
      'kilrashiSupport',
      'missileBudget',
      'ordoGravityLock',
      'serecionEscort',
      'wingmanSlots',
    ]);
    expect(Object.keys(high)).toEqual(Object.keys(low));
  });

  it('派生値に敵の強さ・数・命中に関わる項目がない', () => {
    const keys = Object.keys(supportLevel(extreme(50))).join(' ').toLowerCase();
    for (const forbidden of ['enemy', 'skill', 'damage', 'attackers', 'wave', 'hull', 'accuracy', 'aim']) {
      expect(keys.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('出撃結果からの増減も4状態だけを返す', () => {
    const delta = sortieNarrative(GOOD_CH01).delta;
    for (const key of Object.keys(delta)) {
      expect(['returnees', 'returneeCredit', 'routeTrust', 'commandTrust', 'aceOath']).toContain(key);
    }
  });
});
