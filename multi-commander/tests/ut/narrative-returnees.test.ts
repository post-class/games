import { describe, expect, it } from 'vitest';
import {
  addReturneeEntries,
  addReturnees,
  newNarrative,
  normalizeNarrative,
  returneeEntries,
  adjustNarrative,
  returneeRollCall,
  returneeScore,
  returneeScoreLabel,
  type ReturneeEntry,
} from '../../src/app/narrative';
import { newStatistics, normalizeStatistics, recordReturnees } from '../../src/app/statistics';

describe('addReturneeEntries — 構造化記録の追加と重複排除', () => {
  it('名前と構造化記録の両方を更新する', () => {
    const s = newNarrative();
    expect(addReturneeEntries(s, [
      { name: '〈アストラ・メイ〉乗員', chapter: 1, kind: 'civilian' },
      { name: 'ラギティカ', chapter: 5, kind: 'enemy-ace', personId: 'kilrashi-03' },
    ])).toBe(2);
    expect(s.returnees).toEqual(['〈アストラ・メイ〉乗員', 'ラギティカ']);
    expect(s.returneeLog).toEqual([
      { name: '〈アストラ・メイ〉乗員', chapter: 1, kind: 'civilian' },
      { name: 'ラギティカ', chapter: 5, kind: 'enemy-ace', personId: 'kilrashi-03' },
    ]);
  });

  it('重複排除は personId 基準。同じ人物は章が違っても一度だけ', () => {
    const s = newNarrative();
    addReturneeEntries(s, [{ name: 'ラギティカ', chapter: 5, kind: 'enemy-ace', personId: 'kilrashi-03' }]);
    const added = addReturneeEntries(s, [
      { name: '決闘士ラギティカ', chapter: 9, kind: 'ally-faction', personId: 'kilrashi-03' },
    ]);
    expect(added).toBe(0);
    expect(s.returneeLog).toHaveLength(1);
    expect(s.returneeLog![0].chapter).toBe(5);
  });

  it('personId を持たない同名は名前で潰れるが、別 personId の同名は残る', () => {
    const s = newNarrative();
    addReturneeEntries(s, [
      { name: '避難民', chapter: 1, kind: 'civilian' },
      { name: '避難民', chapter: 4, kind: 'civilian' },
      { name: '避難民', chapter: 7, kind: 'civilian', personId: 'confed-30' },
    ]);
    expect(s.returneeLog).toHaveLength(2);
    expect(s.returneeLog!.map((e) => e.chapter)).toEqual([1, 7]);
    // 名前の配列（互換）は名前で一意
    expect(s.returnees).toEqual(['避難民']);
  });

  it('不正な要素は捨てる', () => {
    const s = newNarrative();
    const raw = [
      null,
      'ラギティカ',
      { name: '   ' },
      { name: 42 },
      { name: '有効な人', kind: '謎の立場', chapter: -3 },
    ] as unknown as ReturneeEntry[];
    expect(addReturneeEntries(s, raw)).toBe(1);
    // kind 不正は民間人、章の不正値は章外として省略
    expect(s.returneeLog).toEqual([{ name: '有効な人', kind: 'civilian' }]);
  });

  it('addReturnees（名前だけ）も構造化記録を作る。章と立場を渡せる', () => {
    const s = newNarrative();
    expect(addReturnees(s, ['民間人A', '民間人A', ''])).toBe(1);
    expect(addReturnees(s, ['マーカス・ジョンソン'], { chapter: 2, kind: 'wingman' })).toBe(1);
    expect(s.returnees).toEqual(['民間人A', 'マーカス・ジョンソン']);
    expect(s.returneeLog).toEqual([
      { name: '民間人A', chapter: undefined, kind: 'civilian' },
      { name: 'マーカス・ジョンソン', chapter: 2, kind: 'wingman' },
    ]);
  });
});

describe('returneeRollCall — 最終無線の読み上げ順', () => {
  it('章順に並び、第1章の民間人と第5章の敵エースが同じ一覧に並ぶ', () => {
    const s = newNarrative();
    addReturneeEntries(s, [
      { name: 'ラギティカ', chapter: 5, kind: 'enemy-ace', personId: 'kilrashi-03' },
      { name: '〈アストラ・メイ〉乗員', chapter: 1, kind: 'civilian' },
      { name: 'ネメ', chapter: 3, kind: 'ally-faction', personId: 'serecion-03' },
    ]);
    expect(returneeRollCall(s).map((e) => e.name)).toEqual([
      '〈アストラ・メイ〉乗員',
      'ネメ',
      'ラギティカ',
    ]);
    expect(returneeRollCall(s).map((e) => e.kind)).toEqual(['civilian', 'ally-faction', 'enemy-ace']);
  });

  it('同じ章の中は 民間人 → 僚機 → 敵エース → 他勢力 の順', () => {
    const s = newNarrative();
    addReturneeEntries(s, [
      { name: 'アーク', chapter: 4, kind: 'ally-faction', personId: 'ordo-01' },
      { name: 'ヴァルカーン', chapter: 4, kind: 'enemy-ace', personId: 'kilrashi-01' },
      { name: '相沢 紗良', chapter: 4, kind: 'wingman', personId: 'confed-13' },
      { name: '採掘船乗員', chapter: 4, kind: 'civilian' },
    ]);
    expect(returneeRollCall(s).map((e) => e.name)).toEqual([
      '採掘船乗員',
      '相沢 紗良',
      'ヴァルカーン',
      'アーク',
    ]);
  });

  it('同じ章・同じ立場の中では追加順を保つ', () => {
    const s = newNarrative();
    addReturneeEntries(s, [
      { name: '民間人C', chapter: 2, kind: 'civilian' },
      { name: '民間人A', chapter: 2, kind: 'civilian' },
      { name: '民間人B', chapter: 2, kind: 'civilian' },
    ]);
    expect(returneeRollCall(s).map((e) => e.name)).toEqual(['民間人C', '民間人A', '民間人B']);
  });

  it('章外（訓練出撃など）は最後に読み上げる', () => {
    const s = newNarrative();
    addReturneeEntries(s, [
      { name: '訓練生', kind: 'civilian' },
      { name: '第10章の民間人', chapter: 10, kind: 'civilian' },
      { name: '第1章の民間人', chapter: 1, kind: 'civilian' },
    ]);
    expect(returneeRollCall(s).map((e) => e.name)).toEqual([
      '第1章の民間人',
      '第10章の民間人',
      '訓練生',
    ]);
  });

  it('名簿が空なら空配列', () => {
    expect(returneeRollCall(newNarrative())).toEqual([]);
  });
});

describe('normalizeNarrative — returneeLog の欠落・不正からの復帰', () => {
  it('returneeLog が無い旧セーブは returnees から復元して読み上げられる', () => {
    const s = normalizeNarrative({ returnees: ['ミラ・カーン', 'ラギティカ'] });
    // 旧セーブの形を変えないため、キー自体は増やさない
    expect(s.returneeLog).toBeUndefined();
    expect(returneeEntries(s).map((e) => e.name)).toEqual(['ミラ・カーン', 'ラギティカ']);
    expect(returneeRollCall(s)).toHaveLength(2);
    expect(returneeScoreLabel(s)).toBe('帰還者 2名');
  });

  it('returneeLog が配列でない場合も例外にならない', () => {
    for (const returneeLog of ['壊れた', 42, null, { 0: { name: 'X', kind: 'civilian' } }]) {
      const s = normalizeNarrative({ returnees: ['ミラ・カーン'], returneeLog });
      expect(returneeRollCall(s).map((e) => e.name)).toEqual(['ミラ・カーン']);
    }
  });

  it('要素が不正な returneeLog は不正分だけ捨てて、returnees と整合させる', () => {
    const s = normalizeNarrative({
      returnees: [],
      returneeLog: [
        { name: 'ラギティカ', chapter: 5, kind: 'enemy-ace', personId: 'kilrashi-03' },
        { name: 'ラギティカ改名', chapter: 6, kind: 'enemy-ace', personId: 'kilrashi-03' },
        { name: '', kind: 'civilian' },
        null,
        { name: '避難民', chapter: 1.9, kind: 'unknown' },
      ],
    });
    expect(s.returneeLog).toEqual([
      { name: 'ラギティカ', chapter: 5, kind: 'enemy-ace', personId: 'kilrashi-03' },
      { name: '避難民', chapter: 1, kind: 'civilian' },
    ]);
    // returnees（互換の文字列配列）は log から補完される
    expect(s.returnees).toEqual(['ラギティカ', '避難民']);
    expect(returneeRollCall(s).map((e) => e.name)).toEqual(['避難民', 'ラギティカ']);
  });

  it('JSON 往復で returnees と returneeLog が整合する', () => {
    const s = newNarrative();
    addReturneeEntries(s, [
      { name: '〈アストラ・メイ〉乗員', chapter: 1, kind: 'civilian' },
      { name: 'ラギティカ', chapter: 5, kind: 'enemy-ace', personId: 'kilrashi-03' },
    ]);
    const restored = normalizeNarrative(JSON.parse(JSON.stringify(s)));
    expect(restored.returnees).toEqual(s.returnees);
    expect(restored.returneeLog).toEqual(s.returneeLog);
    expect(restored.returneeLog!.map((e) => e.name)).toEqual(restored.returnees);
  });
});

describe('returneeScoreLabel — 撃墜数ではなく帰還者数を戦績にする', () => {
  it('人数だけを表示する', () => {
    const s = newNarrative();
    expect(returneeScoreLabel(s)).toBe('帰還者 0名');
    addReturnees(s, ['民間人A', '民間人B', '民間人C']);
    expect(returneeScoreLabel(s)).toBe('帰還者 3名');
  });
});

describe('statistics — 帰還者の累計', () => {
  it('新規統計は 0 から始まり、立場ごとに積み上がる', () => {
    const stats = newStatistics();
    expect(stats.returneesTotal).toBe(0);
    expect(stats.returneesByKind).toEqual({ civilian: 0, wingman: 0, 'enemy-ace': 0, 'ally-faction': 0 });

    const s = newNarrative();
    addReturneeEntries(s, [
      { name: '〈アストラ・メイ〉乗員', chapter: 1, kind: 'civilian' },
      { name: 'ラギティカ', chapter: 5, kind: 'enemy-ace', personId: 'kilrashi-03' },
      { name: '相沢 紗良', chapter: 5, kind: 'wingman', personId: 'confed-13' },
    ]);
    expect(recordReturnees(stats, returneeRollCall(s))).toBe(3);
    expect(stats.returneesTotal).toBe(3);
    expect(stats.returneesByKind).toEqual({ civilian: 1, wingman: 1, 'enemy-ace': 1, 'ally-faction': 0 });
    // 既存の救出カウンタの意味は変えない
    expect(stats.rescuedWingmen).toBe(0);
  });

  it('normalizeStatistics は帰還者項目の欠落・不正から復帰する', () => {
    const legacy = normalizeStatistics({ shotsFired: 10, hits: 4 });
    expect(legacy.returneesTotal).toBe(0);
    expect(legacy.returneesByKind).toEqual({ civilian: 0, wingman: 0, 'enemy-ace': 0, 'ally-faction': 0 });
    expect(legacy.shotsFired).toBe(10);

    const broken = normalizeStatistics({
      returneesTotal: -5,
      returneesByKind: { civilian: 2.7, wingman: 'x', 'enemy-ace': -1 },
    });
    expect(broken.returneesTotal).toBe(0);
    expect(broken.returneesByKind).toEqual({ civilian: 2, wingman: 0, 'enemy-ace': 0, 'ally-faction': 0 });
  });
});

describe('帰還者クレジットの符号', () => {
  it('名簿が空でも「帰せなかった」マイナスが指標に効く', () => {
    // 序盤（名簿0名）で追撃を選んだときに減点が消えないこと。
    // クレジットを 0 で切り上げていた実装では、この差が出なかった。
    const kept = newNarrative();
    const lost = newNarrative();
    adjustNarrative(lost, { returneeCredit: -5 });
    expect(returneeScore(lost)).toBeLessThanOrEqual(returneeScore(kept));
    expect(lost.returneeCredit).toBe(-5);
  });

  it('クレジットが負でも指標は 0 未満にならない', () => {
    const n = newNarrative();
    adjustNarrative(n, { returneeCredit: -99 });
    expect(returneeScore(n)).toBe(0);
  });

  it('名簿の人数と符号付きクレジットの合計が指標になる', () => {
    const n = newNarrative();
    addReturneeEntries(n, [
      { name: 'テスト民間人 A', chapter: 1, kind: 'civilian' },
      { name: 'テスト民間人 B', chapter: 1, kind: 'civilian' },
      { name: 'テスト民間人 C', chapter: 1, kind: 'civilian' },
    ]);
    adjustNarrative(n, { returneeCredit: -1 });
    // (3 名 - 1) * 10 = 20
    expect(returneeScore(n)).toBe(20);
    // 名簿の読み上げはクレジットに影響されない（名前は消えない）
    expect(returneeRollCall(n)).toHaveLength(3);
  });
});
