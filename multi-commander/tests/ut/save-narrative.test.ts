import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSave,
  loadSave,
  loadSaveSlot,
  newCampaignSave,
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

const KEY = 'multi-commander.campaign.v4';
/** 旧版のキー。戦役を THE VEIL FRONT だけにしたとき、読まずに捨てる扱いにした */
const KEY_V3 = 'multi-commander.campaign.v3';
const KEY_V2 = 'multi-commander.campaign.v2';

beforeEach(() => {
  vi.stubGlobal('localStorage', localStorageMock);
  storage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('newCampaignSave — 物語状態の初期化', () => {
  it('veil-ch01 から始まり、narrative が既定値で入る', () => {
    const save = newCampaignSave();
    expect(save.node).toBe('veil-ch01');
    expect(save.narrative).toEqual(newNarrative());
    // 主人公と門の結末は選択前なので未定義
    expect(save.protagonistId).toBeUndefined();
    expect(save.gateOutcome).toBeUndefined();
    expect(save.seenChapters).toEqual([]);
  });
});

/**
 * 旧版のセーブは読まない。
 *
 * v3 / v2 は canon / expanded で進めたものを含み、そのノードは今のグラフに無い。
 * 読み替えても第1章へ戻るだけで進行の意味が残らないので、キーごと無視して
 * 「続きから」に出さない（`loadSave()` が undefined を返す）。
 */
describe('旧セーブ（v3 / v2）は読まない', () => {
  it('v3 のセーブは無視される', () => {
    storage.set(KEY_V3, JSON.stringify({
      node: 'veil-ch04',
      campaignMode: 'veil',
      totalKills: 12,
      savedAt: 1,
    }));
    expect(loadSave()).toBeUndefined();
  });

  it('v2 のセーブは無視される', () => {
    storage.set(KEY_V2, JSON.stringify({ node: 'mccaffrey-1' }));
    expect(loadSave()).toBeUndefined();
  });

  it('narrative が不正な型でも既定値へ落ちる', () => {
    for (const narrative of ['壊れた文字列', 42, null, [], { routeTrust: 'x', returnees: 3 }]) {
      storage.set(KEY, JSON.stringify({ node: 'veil-ch01', narrative }));
      const loaded = loadSave();
      expect(loaded!.narrative.routeTrust).toBe(50);
      expect(loaded!.narrative.returnees).toEqual([]);
      expect(loaded!.narrative.choices).toEqual({});
    }
  });

  it('今のグラフに無いノードは第1章へ落とす', () => {
    storage.set(KEY, JSON.stringify({ node: 'm1-patrol' }));
    expect(loadSave()!.node).toBe('veil-ch01');
  });
});

describe('protagonistId / gateOutcome の正規化', () => {
  function loadWith(fields: Record<string, unknown>) {
    storage.set(KEY, JSON.stringify({ node: 'veil-ch01', ...fields }));
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
    const save = newCampaignSave();
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
    const save = newCampaignSave();
    save.protagonistId = 'confed-05';
    save.narrative.commandTrust = 12;
    addReturneeEntries(save.narrative, [{ name: '相沢 紗良', chapter: 3, kind: 'wingman', personId: 'confed-13' }]);
    saveToSlot(save, 2);

    expect(loadSaveSlot(1)).toBeUndefined();
    const loaded = loadSaveSlot(2)!;
    expect(loaded.protagonistId).toBe('confed-05');
    expect(loaded.narrative.commandTrust).toBe(12);
    expect(loaded.narrative.returnees).toEqual(['相沢 紗良']);
    expect(loaded.narrative.returneeLog).toEqual([
      { name: '相沢 紗良', chapter: 3, kind: 'wingman', personId: 'confed-13' },
    ]);
  });

  it('clearSave は通常キーとスロットを消す', () => {
    writeSave(newCampaignSave());
    saveToSlot(newCampaignSave(), 0);
    clearSave();
    expect(loadSave()).toBeUndefined();
    expect(loadSaveSlot(0)).toBeUndefined();
  });
});
