import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSave,
  loadSave,
  loadSaveSlot,
  newCampaignSave,
  newSave,
  saveToSlot,
  writeSave,
} from '../../src/app/save';
import { addReturneeEntries, newNarrative } from '../../src/app/narrative';

/** localStorage を持たない Node 環境で save.ts を動かすためのモック */
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};

const KEY_V3 = 'multi-commander.campaign.v3';
const KEY_V2 = 'multi-commander.campaign.v2';

beforeEach(() => {
  vi.stubGlobal('localStorage', localStorageMock);
  storage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('newCampaignSave — veil モードと物語状態の初期化', () => {
  it('veil は veil-ch01 から始まり、narrative が既定値で入る', () => {
    const save = newCampaignSave('veil');
    expect(save.campaignMode).toBe('veil');
    expect(save.node).toBe('veil-ch01');
    expect(save.narrative).toEqual(newNarrative());
    // 主人公と門の結末は選択前なので未定義
    expect(save.protagonistId).toBeUndefined();
    expect(save.gateOutcome).toBeUndefined();
  });

  it('既存の newSave() は expanded のまま。narrative は追加されている', () => {
    const save = newSave();
    expect(save.campaignMode).toBe('expanded');
    expect(save.narrative).toEqual(newNarrative());
  });
});

describe('旧セーブ互換 — 追加フィールドが無いJSONを読める', () => {
  it('v3 相当（narrative / protagonistId / gateOutcome なし）でも既定値で埋まる', () => {
    storage.set(KEY_V3, JSON.stringify({
      node: 'enyo-1',
      campaignMode: 'canon',
      seriesScore: 4,
      totalKills: 12,
      sorties: 3,
      cleared: ['m1'],
      savedAt: 1,
    }));
    const loaded = loadSave();
    expect(loaded).toBeDefined();
    expect(loaded!.narrative).toEqual(newNarrative());
    expect(loaded!.protagonistId).toBeUndefined();
    expect(loaded!.gateOutcome).toBeUndefined();
    // 既存の値は失われない
    expect(loaded!.totalKills).toBe(12);
    expect(loaded!.seriesScore).toBe(4);
  });

  it('v2 相当（レガシーキー・最小フィールド）でも例外にならない', () => {
    storage.set(KEY_V2, JSON.stringify({ node: 'mccaffrey-1' }));
    const loaded = loadSave();
    expect(loaded).toBeDefined();
    expect(loaded!.campaignMode).toBe('expanded');
    expect(loaded!.narrative).toEqual(newNarrative());
  });

  it('narrative が不正な型でも既定値へ落ちる', () => {
    for (const narrative of ['壊れた文字列', 42, null, [], { routeTrust: 'x', returnees: 3 }]) {
      storage.set(KEY_V3, JSON.stringify({ node: 'mccaffrey-1', narrative }));
      const loaded = loadSave();
      expect(loaded!.narrative.routeTrust).toBe(50);
      expect(loaded!.narrative.returnees).toEqual([]);
      expect(loaded!.narrative.choices).toEqual({});
    }
  });
});

describe('protagonistId / gateOutcome の正規化', () => {
  function loadWith(fields: Record<string, unknown>) {
    storage.set(KEY_V3, JSON.stringify({ node: 'veil-ch01', campaignMode: 'veil', ...fields }));
    return loadSave()!;
  }

  it('未知の主人公idは undefined に落ちる', () => {
    expect(loadWith({ protagonistId: 'confed-99' }).protagonistId).toBeUndefined();
    expect(loadWith({ protagonistId: 3 }).protagonistId).toBeUndefined();
    expect(loadWith({ protagonistId: null }).protagonistId).toBeUndefined();
    expect(loadWith({ protagonistId: '' }).protagonistId).toBeUndefined();
    // 名簿にはいるが主人公候補ではない人物も拒否する
    expect(loadWith({ protagonistId: 'confed-24' }).protagonistId).toBeUndefined();
  });

  it('主人公候補の confed-03 は保持される', () => {
    expect(loadWith({ protagonistId: 'confed-03' }).protagonistId).toBe('confed-03');
  });

  it('不正な gateOutcome は undefined、正しい値は保持される', () => {
    expect(loadWith({ gateOutcome: 'open' }).gateOutcome).toBeUndefined();
    expect(loadWith({ gateOutcome: 7 }).gateOutcome).toBeUndefined();
    expect(loadWith({ gateOutcome: 'joint-custody' }).gateOutcome).toBe('joint-custody');
    expect(loadWith({ gateOutcome: 'closed' }).gateOutcome).toBe('closed');
    expect(loadWith({ gateOutcome: 'limited-open' }).gateOutcome).toBe('limited-open');
  });
});

describe('保存と読込の往復', () => {
  it('通常キーの往復で narrative / protagonistId / gateOutcome が残る', () => {
    const save = newCampaignSave('veil');
    save.protagonistId = 'confed-01';
    save.gateOutcome = 'limited-open';
    save.narrative.routeTrust = 71;
    addReturneeEntries(save.narrative, [
      { name: '〈アストラ・メイ〉乗員', chapter: 1, kind: 'civilian' },
      { name: 'ラギティカ', chapter: 5, kind: 'enemy-ace', personId: 'kilrashi-03' },
    ]);
    writeSave(save);

    const loaded = loadSave()!;
    expect(loaded.node).toBe('veil-ch01');
    expect(loaded.protagonistId).toBe('confed-01');
    expect(loaded.gateOutcome).toBe('limited-open');
    expect(loaded.narrative.routeTrust).toBe(71);
    expect(loaded.narrative.returnees).toEqual(['〈アストラ・メイ〉乗員', 'ラギティカ']);
    expect(loaded.narrative.returneeLog).toEqual(save.narrative.returneeLog);
  });

  it('スロット保存・読込を経ても narrative が保持される', () => {
    const save = newCampaignSave('veil');
    save.protagonistId = 'confed-05';
    save.narrative.commandTrust = 12;
    addReturneeEntries(save.narrative, [{ name: '相沢 紗良', chapter: 3, kind: 'wingman', personId: 'confed-13' }]);
    saveToSlot(save, 2);

    expect(loadSaveSlot(1)).toBeUndefined();
    const loaded = loadSaveSlot(2)!;
    expect(loaded.campaignMode).toBe('veil');
    expect(loaded.protagonistId).toBe('confed-05');
    expect(loaded.narrative.commandTrust).toBe(12);
    expect(loaded.narrative.returnees).toEqual(['相沢 紗良']);
    expect(loaded.narrative.returneeLog).toEqual([
      { name: '相沢 紗良', chapter: 3, kind: 'wingman', personId: 'confed-13' },
    ]);
  });

  it('clearSave は通常キー・レガシーキー・スロットを消す', () => {
    storage.set(KEY_V2, JSON.stringify({ node: 'mccaffrey-1' }));
    writeSave(newCampaignSave('veil'));
    saveToSlot(newCampaignSave('veil'), 0);
    clearSave();
    expect(loadSave()).toBeUndefined();
    expect(loadSaveSlot(0)).toBeUndefined();
  });
});
