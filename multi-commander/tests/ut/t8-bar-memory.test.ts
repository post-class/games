import { describe, expect, it } from 'vitest';
import {
  applySortie,
  BAR_MEMORY_LIMIT,
  barMemory,
  buyDrink,
  canBuyDrink,
  DRINKS_PER_SORTIE,
  newBarMemory,
  newRoster,
  normalizeRoster,
  relationBetween,
  relationKey,
  rememberBarTalk,
  rememberIntervention,
  shiftRelation,
  toastFallen,
  type RosterState,
  type SortieOutcome,
} from '../../src/app/roster';
import { bondKey } from '../../src/content/pilotBonds';

/**
 * T8-① 酒場の記憶（`RosterState.bar`）。
 *
 * 検証するのは「1回の帰艦で何回できるか」「出撃をまたいで何が残り何が戻るか」
 * 「壊れた保存データを読んでも存在しない相手の噂が出ないこと」。
 */

function sortie(over: Partial<SortieOutcome> = {}): SortieOutcome {
  return {
    wingmanLost: false,
    wingmanKills: 0,
    wingmanHullRatio: 1,
    rescued: false,
    abandoned: false,
    missionTitle: 'test',
    chapter: 1,
    ...over,
  };
}

/** 保存 → 復元の往復（localStorage と同じ経路にする） */
function roundTrip(roster: RosterState): RosterState {
  return normalizeRoster(JSON.parse(JSON.stringify(roster)));
}

describe('T8-① 酒場の記憶の初期値', () => {
  it('newRoster() の bar が初期化されている', () => {
    const roster = newRoster();
    // `toasted` は明示的に false。`bar` が欠けた保存データを正規化した形と揃えてある
    // （片方だけ undefined だと、追悼欄の案内文が保存データの世代で出たり出なかったりする）。
    expect(roster.bar).toEqual({ talkedWith: [], drinksThisSortie: 0, toasted: false });
    expect(newBarMemory()).toEqual({ talkedWith: [], drinksThisSortie: 0, toasted: false });
    // 初期状態ではまだ何もしていない
    expect(roster.bar!.intervened).toBeUndefined();
    expect(roster.bar!.boughtDrink).toBeUndefined();
    expect(canBuyDrink(roster)).toBe(true);
  });

  it('barMemory() は bar が無い名簿へ作って差し込む', () => {
    const roster = newRoster();
    delete roster.bar;
    const bar = barMemory(roster);
    expect(bar).toEqual(newBarMemory());
    // 差し込んだ実体をそのまま返す（呼ぶたびに新品にならない）
    expect(roster.bar).toBe(bar);
    bar.drinksThisSortie = 1;
    expect(barMemory(roster).drinksThisSortie).toBe(1);
  });
});

describe('T8-① 会話した相手の記憶', () => {
  it('新しい順に積む', () => {
    const roster = newRoster();
    rememberBarTalk(roster, 'sable');
    rememberBarTalk(roster, 'orion');
    expect(barMemory(roster).talkedWith).toEqual(['orion', 'sable']);
  });

  it('同じ相手をもう一度話すと先頭へ寄り、重複しない', () => {
    const roster = newRoster();
    for (const id of ['sable', 'orion', 'aster']) rememberBarTalk(roster, id);
    rememberBarTalk(roster, 'sable');
    expect(barMemory(roster).talkedWith).toEqual(['sable', 'aster', 'orion']);
  });

  it('最大 BAR_MEMORY_LIMIT 件で打ち切る（古い方から落ちる）', () => {
    const roster = newRoster();
    const ids = ['sable', 'tempest', 'orion', 'aster', 'vesper'];
    expect(ids.length).toBeGreaterThan(BAR_MEMORY_LIMIT);
    for (const id of ids) rememberBarTalk(roster, id);
    const kept = barMemory(roster).talkedWith;
    expect(kept).toHaveLength(BAR_MEMORY_LIMIT);
    expect(kept).toEqual([...ids].reverse().slice(0, BAR_MEMORY_LIMIT));
    // 最初に話した相手は落ちている
    expect(kept).not.toContain('sable');
  });

  it('bar が無い名簿へでも記憶できる（古い保存データ）', () => {
    const roster = newRoster();
    delete roster.bar;
    rememberBarTalk(roster, 'sable');
    expect(roster.bar!.talkedWith).toEqual(['sable']);
  });
});

describe('T8-① 介入の記憶', () => {
  it('ペアとどちらに味方したかを覚える（上書きは最新1件）', () => {
    const roster = newRoster();
    rememberIntervention(roster, bondKey('tempest', 'orion'), 'a');
    expect(barMemory(roster).intervened).toEqual({ bondKey: 'orion:tempest', side: 'a' });
    rememberIntervention(roster, bondKey('vesper', 'sable'), 'defuse');
    expect(barMemory(roster).intervened).toEqual({ bondKey: 'sable:vesper', side: 'defuse' });
  });
});

describe('T8-① 1回の帰艦で1回だけ', () => {
  it('buyDrink は DRINKS_PER_SORTIE 回まで。2回目は false で何も変えない', () => {
    expect(DRINKS_PER_SORTIE).toBe(1);
    const roster = newRoster();
    expect(canBuyDrink(roster)).toBe(true);
    expect(buyDrink(roster, 'sable')).toBe(true);
    expect(barMemory(roster).drinksThisSortie).toBe(1);
    expect(barMemory(roster).boughtDrink).toBe('sable');
    expect(canBuyDrink(roster)).toBe(false);

    const before = JSON.parse(JSON.stringify(barMemory(roster)));
    expect(buyDrink(roster, 'orion')).toBe(false);
    // 相手も回数も書き換わらない
    expect(barMemory(roster)).toEqual(before);
  });

  it('toastFallen は2回目に false', () => {
    const roster = newRoster();
    expect(toastFallen(roster)).toBe(true);
    expect(barMemory(roster).toasted).toBe(true);
    expect(toastFallen(roster)).toBe(false);
    expect(barMemory(roster).toasted).toBe(true);
  });
});

describe('T8-① 出撃をまたいだときに戻るもの・残るもの', () => {
  it('applySortie で回数枠は戻り、噂の種は残る', () => {
    const roster = newRoster();
    rememberBarTalk(roster, 'sable');
    rememberIntervention(roster, bondKey('tempest', 'orion'), 'defuse');
    buyDrink(roster, 'sable');
    toastFallen(roster);

    applySortie(roster, sortie({ wingmanId: 'sable' }));

    const bar = barMemory(roster);
    // 戻る: 1回の帰艦につき1回の枠
    expect(bar.drinksThisSortie).toBe(0);
    expect(bar.toasted).toBe(false);
    expect(canBuyDrink(roster)).toBe(true);
    // 残る: 誰と話したか／誰に味方したか（次の帰艦で噂として伝わる）
    expect(bar.talkedWith).toEqual(['sable']);
    expect(bar.intervened).toEqual({ bondKey: 'orion:tempest', side: 'defuse' });
    // 奢った相手も残る（噂の材料）
    expect(bar.boughtDrink).toBe('sable');
  });

  it('僚機を選ばない出撃でも枠は戻る', () => {
    const roster = newRoster();
    buyDrink(roster, 'sable');
    applySortie(roster, sortie());
    expect(canBuyDrink(roster)).toBe(true);
  });

  it('bar が無い名簿へ applySortie しても落ちない', () => {
    const roster = newRoster();
    delete roster.bar;
    expect(() => applySortie(roster, sortie({ wingmanId: 'sable' }))).not.toThrow();
    expect(roster.bar).toEqual({ talkedWith: [], drinksThisSortie: 0, toasted: false });
  });
});

describe('T8-① 隊員同士の関係値', () => {
  it('shiftRelation は -1..+1 に収まる', () => {
    const roster = newRoster();
    for (let i = 0; i < 20; i++) shiftRelation(roster, 'sable', 'orion', 0.3);
    expect(relationBetween(roster, 'sable', 'orion')).toBe(1);
    for (let i = 0; i < 40; i++) shiftRelation(roster, 'sable', 'orion', -0.3);
    expect(relationBetween(roster, 'sable', 'orion')).toBe(-1);
  });

  it('relationKey は順序に依らない', () => {
    expect(relationKey('sable', 'orion')).toBe(relationKey('orion', 'sable'));
    expect(relationKey('sable', 'orion')).toBe(bondKey('sable', 'orion'));
    const roster = newRoster();
    shiftRelation(roster, 'sable', 'orion', 0.4);
    expect(relationBetween(roster, 'orion', 'sable')).toBeCloseTo(0.4);
    // 逆順で足しても同じ鍵に積まれる
    shiftRelation(roster, 'orion', 'sable', 0.2);
    expect(Object.keys(roster.relations)).toEqual([relationKey('sable', 'orion')]);
    expect(relationBetween(roster, 'sable', 'orion')).toBeCloseTo(0.6);
  });

  it('自分自身との関係は作らない', () => {
    const roster = newRoster();
    shiftRelation(roster, 'sable', 'sable', 0.5);
    expect(roster.relations).toEqual({});
  });

  it('relations が無い名簿でも動かせる（古い保存データ）', () => {
    const roster = newRoster();
    delete (roster as { relations?: unknown }).relations;
    shiftRelation(roster, 'sable', 'orion', 0.5);
    expect(relationBetween(roster, 'sable', 'orion')).toBeCloseTo(0.5);
  });
});

describe('T8-① normalizeRoster の bar 正規化', () => {
  it('bar が無い保存データでも初期化される', () => {
    // bar ごと欠けている保存データは newBarMemory() そのままへ落ちる
    const legacy = normalizeRoster({ pilots: [{ id: 'sable' }] });
    expect(legacy.bar).toEqual(newBarMemory());
    expect(canBuyDrink(legacy)).toBe(true);
    // pilots ごと壊れている保存データは newRoster() へ落ちるので、そこでも bar はある
    expect(normalizeRoster(null).bar).toEqual(newBarMemory());
    expect(normalizeRoster({ pilots: 'broken' }).bar).toEqual(newBarMemory());
    expect(normalizeRoster({ pilots: [{ id: 'sable' }], bar: 'broken' }).bar).toEqual(newBarMemory());
    // bar が空オブジェクトなら、各項目を既定値で埋めた形になる
    expect(normalizeRoster({ pilots: [{ id: 'sable' }], bar: {} }).bar).toEqual({
      talkedWith: [],
      drinksThisSortie: 0,
      toasted: false,
    });
  });

  it('未知の隊員 id は talkedWith と boughtDrink から落ちる', () => {
    const restored = normalizeRoster({
      pilots: [{ id: 'sable' }, { id: 'orion' }],
      bar: { talkedWith: ['orion', 'nobody', 'sable', 'nova'], boughtDrink: 'nobody', drinksThisSortie: 0 },
    });
    // 'nova' は人物としては存在するが、この名簿にいないので落ちる
    expect(restored.bar!.talkedWith).toEqual(['orion', 'sable']);
    expect(restored.bar!.boughtDrink).toBeUndefined();

    const kept = normalizeRoster({
      pilots: [{ id: 'sable' }],
      bar: { talkedWith: ['sable'], boughtDrink: 'sable', drinksThisSortie: 0 },
    });
    expect(kept.bar!.boughtDrink).toBe('sable');
  });

  it('talkedWith の重複・非文字列を捨て、上限で打ち切る', () => {
    const restored = normalizeRoster({
      pilots: ['sable', 'tempest', 'orion', 'aster', 'vesper'].map((id) => ({ id })),
      bar: {
        talkedWith: ['sable', 'sable', 42, null, 'tempest', 'orion', 'aster', 'vesper'],
        drinksThisSortie: 0,
      },
    });
    expect(restored.bar!.talkedWith).toEqual(['sable', 'tempest', 'orion', 'aster'].slice(0, BAR_MEMORY_LIMIT));
    expect(restored.bar!.talkedWith).toHaveLength(BAR_MEMORY_LIMIT);
  });

  it('intervened.side が不正なら undefined になる', () => {
    const bad = (bar: unknown) => normalizeRoster({ pilots: [{ id: 'sable' }], bar }).bar!.intervened;
    expect(bad({ intervened: { bondKey: 'a:b', side: 'both' } })).toBeUndefined();
    expect(bad({ intervened: { bondKey: 'a:b' } })).toBeUndefined();
    expect(bad({ intervened: { side: 'a' } })).toBeUndefined();
    expect(bad({ intervened: 'broken' })).toBeUndefined();
    for (const side of ['a', 'b', 'defuse']) {
      expect(bad({ intervened: { bondKey: 'a:b', side } })).toEqual({ bondKey: 'a:b', side });
    }
  });

  it('drinksThisSortie は 0..DRINKS_PER_SORTIE に丸める', () => {
    const drinks = (v: unknown) =>
      normalizeRoster({ pilots: [{ id: 'sable' }], bar: { drinksThisSortie: v } }).bar!.drinksThisSortie;
    expect(drinks(9)).toBe(DRINKS_PER_SORTIE);
    expect(drinks(-3)).toBe(0);
    expect(drinks(0.9)).toBe(0);
    expect(drinks('one')).toBe(0);
    expect(drinks(Number.NaN)).toBe(0);
    expect(drinks(undefined)).toBe(0);
  });

  it('toasted は真偽値へ寄せる（bar があれば undefined を残さない）', () => {
    const toasted = (v: unknown) =>
      normalizeRoster({ pilots: [{ id: 'sable' }], bar: { drinksThisSortie: 0, toasted: v } }).bar!.toasted;
    expect(toasted(true)).toBe(true);
    expect(toasted(false)).toBe(false);
    expect(toasted(undefined)).toBe(false);
    expect(toasted('yes')).toBe(false);
  });

  it('保存 → 復元で酒場の記憶が保たれる', () => {
    const roster = newRoster();
    rememberBarTalk(roster, 'sable');
    rememberBarTalk(roster, 'orion');
    rememberIntervention(roster, bondKey('tempest', 'orion'), 'b');
    buyDrink(roster, 'orion');
    toastFallen(roster);
    const restored = roundTrip(roster);
    expect(restored.bar).toEqual({
      talkedWith: ['orion', 'sable'],
      intervened: { bondKey: 'orion:tempest', side: 'b' },
      boughtDrink: 'orion',
      drinksThisSortie: 1,
      toasted: true,
    });
  });

  it('正規化したものを再度正規化しても同じ（冪等）', () => {
    const dirty = {
      pilots: [{ id: 'sable' }, { id: 'orion' }, { id: 'nobody' }],
      relations: { 'orion:sable': 5, broken: 'x' },
      bar: {
        talkedWith: ['orion', 'nova', 'orion', 'sable'],
        intervened: { bondKey: 'orion:sable', side: 'zzz' },
        boughtDrink: 'nova',
        drinksThisSortie: 7,
        toasted: 'yes',
      },
    };
    const once = normalizeRoster(dirty);
    const twice = normalizeRoster(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
    // 正規化後の値そのものも確認しておく（冪等でも中身が壊れていては意味がない）
    expect(once.bar).toEqual({
      talkedWith: ['orion', 'sable'],
      intervened: undefined,
      boughtDrink: undefined,
      drinksThisSortie: DRINKS_PER_SORTIE,
      // 'yes' は真偽値ではないので false へ寄る
      toasted: false,
    });
    expect(once.relations).toEqual({ 'orion:sable': 1 });
  });
});
