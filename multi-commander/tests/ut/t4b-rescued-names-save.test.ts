import { describe, expect, it } from 'vitest';
import { loadSave, newSave, writeSave, type CampaignSave } from '../../src/app/save';

/**
 * T4-⑮ の「連れ帰った者」を累積で保存する配線のテスト。
 *
 * 第10章の読み上げは過去章の分まで読む必要があるので、名前は出撃をまたいで積む。
 * ここで検証するのは保存・復元の側（名前の解決は `MissionRunner` の担当）。
 */

/** localStorage を持たない環境でも動くよう、最小の実装を用意する。 */
function installFakeStorage(): void {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

installFakeStorage();

describe('T4-⑮ 連れ帰った者は累積で保存される', () => {
  it('新規セーブでは空配列から始まる', () => {
    expect(newSave('veil').rescuedNames).toEqual([]);
  });

  it('書き込んだ名前が復元される', () => {
    localStorage.clear();
    const save = newSave('veil');
    save.rescuedNames.push('相沢 紗良', '水城 玲奈');
    writeSave(save);
    expect(loadSave()?.rescuedNames).toEqual(['相沢 紗良', '水城 玲奈']);
  });

  it('旧セーブ（項目が無い JSON）でも空配列になり、読み込みが壊れない', () => {
    localStorage.clear();
    const save = newSave('veil') as CampaignSave & { rescuedNames?: unknown };
    save.rescuedNames = ['柊 奏'];
    writeSave(save as CampaignSave);
    // 保存後に項目を削って「旧セーブ」を作る
    const key = localStorage.key(0)!;
    const raw = JSON.parse(localStorage.getItem(key)!);
    delete raw.rescuedNames;
    localStorage.setItem(key, JSON.stringify(raw));

    const loaded = loadSave();
    expect(loaded).toBeTruthy();
    expect(loaded!.rescuedNames).toEqual([]);
  });

  it('型が違う値・空文字は捨てる', () => {
    localStorage.clear();
    const save = newSave('veil');
    writeSave(save);
    const key = localStorage.key(0)!;
    const raw = JSON.parse(localStorage.getItem(key)!);
    raw.rescuedNames = ['柊 奏', 42, null, '   ', '水城 玲奈'];
    localStorage.setItem(key, JSON.stringify(raw));

    expect(loadSave()!.rescuedNames).toEqual(['柊 奏', '水城 玲奈']);
  });

  it('配列でない値が入っていても空配列に落ちる', () => {
    localStorage.clear();
    const save = newSave('veil');
    writeSave(save);
    const key = localStorage.key(0)!;
    const raw = JSON.parse(localStorage.getItem(key)!);
    raw.rescuedNames = { '0': '柊 奏' };
    localStorage.setItem(key, JSON.stringify(raw));

    expect(loadSave()!.rescuedNames).toEqual([]);
  });
});
