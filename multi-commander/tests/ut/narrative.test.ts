import { describe, expect, it } from 'vitest';
import {
  addReturnees,
  adjustNarrative,
  applyChoice,
  narrativeGrade,
  narrativeSummary,
  newNarrative,
  normalizeNarrative,
  returneeScore,
  supportLevel,
  type NarrativeState,
} from '../../src/app/narrative';

describe('NarrativeState — 管理する4状態', () => {
  it('初期値は信頼値が中庸（50）で、名簿と選択記録が空', () => {
    const s = newNarrative();
    expect(s.returnees).toEqual([]);
    expect(s.choices).toEqual({});
    expect(s.routeTrust).toBe(50);
    expect(s.commandTrust).toBe(50);
    expect(s.aceOath).toBe(50);
  });

  it('初期状態は呼び出しごとに独立している（参照を共有しない）', () => {
    const a = newNarrative();
    const b = newNarrative();
    addReturnees(a, ['ミラ・カーン']);
    a.choices['ch1'] = 'rescue';
    expect(b.returnees).toEqual([]);
    expect(b.choices).toEqual({});
  });
});

describe('normalizeNarrative — 保存データの復元', () => {
  it('null / undefined / 文字列 / 数値 / 配列 から初期値へ復帰する', () => {
    const base = newNarrative();
    for (const raw of [null, undefined, 'broken', 42, NaN, true]) {
      expect(normalizeNarrative(raw)).toEqual(base);
    }
  });

  it('値域外の数値は 0..100 へ丸められる', () => {
    const s = normalizeNarrative({ routeTrust: -30, commandTrust: 999, aceOath: 100.4 });
    expect(s.routeTrust).toBe(0);
    expect(s.commandTrust).toBe(100);
    expect(s.aceOath).toBe(100);
  });

  it('数値でない・NaN の信頼値は初期値（50）へ戻す', () => {
    const s = normalizeNarrative({ routeTrust: 'high', commandTrust: NaN, aceOath: null });
    expect(s.routeTrust).toBe(50);
    expect(s.commandTrust).toBe(50);
    expect(s.aceOath).toBe(50);
  });

  it('returnees が配列でない場合は空の名簿になる', () => {
    expect(normalizeNarrative({ returnees: 'ミラ' }).returnees).toEqual([]);
    expect(normalizeNarrative({ returnees: { 0: 'ミラ' } }).returnees).toEqual([]);
    expect(normalizeNarrative({ returnees: 3 }).returnees).toEqual([]);
  });

  it('returnees の混入した非文字列・空文字・重複を捨て、順序は保つ', () => {
    const s = normalizeNarrative({
      returnees: ['ミラ・カーン', 7, 'ミラ・カーン', '', '   ', null, 'ヴァルカーン'],
    });
    expect(s.returnees).toEqual(['ミラ・カーン', 'ヴァルカーン']);
  });

  it('choices が object でない場合は空になり、object なら文字列の組だけ残す', () => {
    expect(normalizeNarrative({ choices: 'ch1' }).choices).toEqual({});
    expect(normalizeNarrative({ choices: ['ch1'] }).choices).toEqual({});
    expect(normalizeNarrative({ choices: 5 }).choices).toEqual({});
    expect(normalizeNarrative({ choices: { ch1: 'rescue', ch2: 9, ch3: '' } }).choices).toEqual({
      ch1: 'rescue',
    });
  });

  it('正常な保存データはそのまま復元できる', () => {
    const src: NarrativeState = {
      returnees: ['ミラ・カーン', 'ラギティカ'],
      routeTrust: 72,
      commandTrust: 31,
      aceOath: 88,
      choices: { ch1: 'rescue', ch5: 'duel' },
    };
    expect(normalizeNarrative(JSON.parse(JSON.stringify(src)))).toEqual(src);
  });
});

describe('adjustNarrative — 値域クランプ', () => {
  it('0未満・100超は丸められる', () => {
    const s = newNarrative();
    adjustNarrative(s, { routeTrust: -80, commandTrust: 80, aceOath: -50 });
    expect(s.routeTrust).toBe(0);
    expect(s.commandTrust).toBe(100);
    expect(s.aceOath).toBe(0);
    adjustNarrative(s, { routeTrust: -10, commandTrust: 10 });
    expect(s.routeTrust).toBe(0);
    expect(s.commandTrust).toBe(100);
  });

  it('省略した項目は変化しない', () => {
    const s = newNarrative();
    adjustNarrative(s, { routeTrust: 5 });
    expect(s.routeTrust).toBe(55);
    expect(s.commandTrust).toBe(50);
    expect(s.aceOath).toBe(50);
  });

  it('帰還者も同時に追加できる', () => {
    const s = newNarrative();
    adjustNarrative(s, { returnees: ['ミラ・カーン'], aceOath: 3 });
    expect(s.returnees).toEqual(['ミラ・カーン']);
    expect(s.aceOath).toBe(53);
  });
});

describe('applyChoice — 二重適用防止', () => {
  it('1回目は適用され、2回目は false で状態が変わらない', () => {
    const s = newNarrative();
    expect(applyChoice(s, 'ch1', 'rescue', { routeTrust: 10, returnees: ['ミラ・カーン'] })).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(s));

    expect(applyChoice(s, 'ch1', 'pursue', { routeTrust: -20, returnees: ['ラギティカ'] })).toBe(false);
    expect(s).toEqual(snapshot);
    expect(s.choices['ch1']).toBe('rescue');
    expect(s.routeTrust).toBe(60);
    expect(s.returnees).toEqual(['ミラ・カーン']);
  });

  it('章が違えば独立に適用される', () => {
    const s = newNarrative();
    expect(applyChoice(s, 'ch1', 'rescue', { commandTrust: -5 })).toBe(true);
    expect(applyChoice(s, 'ch2', 'report', { commandTrust: -5 })).toBe(true);
    expect(s.commandTrust).toBe(40);
    expect(s.choices).toEqual({ ch1: 'rescue', ch2: 'report' });
  });

  it('効果を省略しても選択は記録される', () => {
    const s = newNarrative();
    expect(applyChoice(s, 'ch3', 'silent')).toBe(true);
    expect(s.choices['ch3']).toBe('silent');
    expect(s.routeTrust).toBe(50);
  });

  it('空の chapterId / choiceId は記録しない', () => {
    const s = newNarrative();
    expect(applyChoice(s, '', 'rescue', { routeTrust: 10 })).toBe(false);
    expect(applyChoice(s, 'ch4', '', { routeTrust: 10 })).toBe(false);
    expect(s.choices).toEqual({});
    expect(s.routeTrust).toBe(50);
  });
});

describe('addReturnees — 重複排除と順序保持', () => {
  it('章順・追加順を保ち、重複は無視する', () => {
    const s = newNarrative();
    expect(addReturnees(s, ['民間人A', '民間人B'])).toBe(2);
    expect(addReturnees(s, ['僚機マーベリック'])).toBe(1);
    expect(addReturnees(s, ['民間人A', 'ラギティカ', 'ラギティカ'])).toBe(1);
    expect(s.returnees).toEqual(['民間人A', '民間人B', '僚機マーベリック', 'ラギティカ']);
  });

  it('勢力を問わず同じ一覧に並ぶ（第1章の民間人と第5章の敵エース）', () => {
    const s = newNarrative();
    addReturnees(s, ['アストラ・メイ乗員']);
    addReturnees(s, ['ラギティカ']);
    expect(s.returnees).toEqual(['アストラ・メイ乗員', 'ラギティカ']);
  });

  it('空配列・空文字・非文字列は追加しない', () => {
    const s = newNarrative();
    expect(addReturnees(s, [])).toBe(0);
    expect(addReturnees(s, ['', '   '])).toBe(0);
    expect(addReturnees(s, [1 as unknown as string, null as unknown as string])).toBe(0);
    expect(s.returnees).toEqual([]);
  });
});

describe('narrativeSummary — 表示用の段階ラベル', () => {
  it('段階の境界値が仕様どおり', () => {
    expect(narrativeGrade(0)).toBe('最低');
    expect(narrativeGrade(24)).toBe('最低');
    expect(narrativeGrade(25)).toBe('低');
    expect(narrativeGrade(44)).toBe('低');
    expect(narrativeGrade(45)).toBe('中');
    expect(narrativeGrade(59)).toBe('中');
    expect(narrativeGrade(60)).toBe('高');
    expect(narrativeGrade(79)).toBe('高');
    expect(narrativeGrade(80)).toBe('最高');
    expect(narrativeGrade(100)).toBe('最高');
  });

  it('各状態の値とラベル、帰還者の人数と読み上げ順を返す', () => {
    const s = newNarrative();
    s.routeTrust = 90;
    s.commandTrust = 10;
    s.aceOath = 50;
    addReturnees(s, ['民間人A', '民間人B']);
    const sum = narrativeSummary(s);
    expect(sum.routeTrust).toEqual({ label: '航路信頼', value: 90, grade: '最高' });
    expect(sum.commandTrust).toEqual({ label: '軍令信用', value: 10, grade: '最低' });
    expect(sum.aceOath).toEqual({ label: '敵エースの誓約', value: 50, grade: '中' });
    expect(sum.returnees.count).toBe(2);
    expect(sum.returnees.names).toEqual(['民間人A', '民間人B']);
    expect(sum.returnees.value).toBe(20);
    expect(sum.returnees.grade).toBe('最低');
  });

  it('返す名簿は複製で、変更が状態へ漏れない', () => {
    const s = newNarrative();
    addReturnees(s, ['民間人A']);
    narrativeSummary(s).returnees.names.push('捏造された名前');
    expect(s.returnees).toEqual(['民間人A']);
  });
});

describe('supportLevel — 次章の援護内容（難易度は変えない）', () => {
  function withTrust(value: number, returneeCount: number): NarrativeState {
    const s = newNarrative();
    s.routeTrust = value;
    s.commandTrust = value;
    s.aceOath = value;
    for (let i = 0; i < returneeCount; i += 1) addReturnees(s, [`帰還者${i}`]);
    return s;
  }

  it('すべて 0（帰還者ゼロ）— 単機・援護なし・搭載最小', () => {
    const sup = supportLevel(withTrust(0, 0));
    expect(sup.wingmanSlots).toBe(0);
    expect(sup.serecionEscort).toBe(false);
    expect(sup.ordoGravityLock).toBe(false);
    expect(sup.missileBudget).toBe(0.6);
    expect(sup.kilrashiSupport).toBe('none');
    expect(sup.commandRadioTone).toBe('cold');
  });

  it('すべて 50（帰還者5名）— 僚機1機・護衛なし・停戦のみ', () => {
    const sup = supportLevel(withTrust(50, 5));
    expect(returneeScore(withTrust(50, 5))).toBe(50);
    expect(sup.wingmanSlots).toBe(1);
    expect(sup.serecionEscort).toBe(false);
    expect(sup.ordoGravityLock).toBe(false);
    expect(sup.missileBudget).toBe(0.9);
    expect(sup.kilrashiSupport).toBe('ceasefire');
    expect(sup.commandRadioTone).toBe('formal');
  });

  it('すべて 100（帰還者10名）— 僚機2機・全援護・共同作戦', () => {
    const sup = supportLevel(withTrust(100, 10));
    expect(returneeScore(withTrust(100, 10))).toBe(100);
    expect(sup.wingmanSlots).toBe(2);
    expect(sup.serecionEscort).toBe(true);
    expect(sup.ordoGravityLock).toBe(true);
    expect(sup.missileBudget).toBe(1.2);
    expect(sup.kilrashiSupport).toBe('joint');
    expect(sup.commandRadioTone).toBe('warm');
  });

  it('僚機数のしきい値 — 帰還者指標 30 / 60 の境界', () => {
    const slots = (count: number) => {
      const s = newNarrative();
      for (let i = 0; i < count; i += 1) addReturnees(s, [`帰還者${i}`]);
      return supportLevel(s).wingmanSlots;
    };
    expect(slots(2)).toBe(0); // 20
    expect(slots(3)).toBe(1); // 30
    expect(slots(5)).toBe(1); // 50
    expect(slots(6)).toBe(2); // 60
    expect(slots(20)).toBe(2); // 飽和して 100
  });

  it('航路信頼のしきい値 — 60 で護衛船、80 で重力固定', () => {
    const route = (v: number) => {
      const s = newNarrative();
      s.routeTrust = v;
      return supportLevel(s);
    };
    expect(route(59).serecionEscort).toBe(false);
    expect(route(60).serecionEscort).toBe(true);
    expect(route(79).ordoGravityLock).toBe(false);
    expect(route(80).ordoGravityLock).toBe(true);
  });

  it('敵エースの誓約のしきい値 — 40 で停戦、75 で共同作戦', () => {
    const oath = (v: number) => {
      const s = newNarrative();
      s.aceOath = v;
      return supportLevel(s).kilrashiSupport;
    };
    expect(oath(39)).toBe('none');
    expect(oath(40)).toBe('ceasefire');
    expect(oath(74)).toBe('ceasefire');
    expect(oath(75)).toBe('joint');
  });

  it('搭載倍率は 0.6..1.2 の範囲を出ない', () => {
    for (let v = 0; v <= 100; v += 1) {
      const s = newNarrative();
      s.commandTrust = v;
      const budget = supportLevel(s).missileBudget;
      expect(budget).toBeGreaterThanOrEqual(0.6);
      expect(budget).toBeLessThanOrEqual(1.2);
    }
  });

  it('派生値に難易度パラメータを含めない（キーが援護・搭載・僚機・無線に限られる）', () => {
    expect(Object.keys(supportLevel(newNarrative())).sort()).toEqual(
      [
        'commandRadioTone',
        'kilrashiSupport',
        'missileBudget',
        'ordoGravityLock',
        'serecionEscort',
        'wingmanSlots',
      ].sort(),
    );
  });
});
