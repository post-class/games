/**
 * tests/unit/ui.title.test.ts — タイトル画面の純関数（T-M12-09 / `05§2`）
 *
 * vitest の environment は `node`（jsdom なし）なので、**DOM を触らない部分だけ**を試す。
 * セーブの読み取り・メニューの有効/無効・空の色の 3 つ。
 */

import { describe, expect, it } from 'vitest';

import type { ScreenId } from '@/ui/screens/router';
import {
  CONTINUE_KEY,
  buildSubButtons,
  buildTitleMenu,
  readTitleSave,
  skyPalette,
  sunPosition,
  type ReadOnlyStore,
} from '@/ui/screens/Title';
import { LAST_CIV_KEY } from '@/ui/screens/CivSelect';

/** テスト用の `localStorage` 代替。 */
function store(map: Record<string, string>): ReadOnlyStore {
  return { getItem: (k) => map[k] ?? null };
}

/** 「この画面だけ登録済み」を作る。 */
function registered(...ids: ScreenId[]): (id: ScreenId) => boolean {
  return (id) => ids.includes(id);
}

describe('readTitleSave — 前回の文明と続き（05§2-1, 05§2-3）', () => {
  it('セーブが無ければ紋章は無地（lastCiv = null）で続きも無い', () => {
    const s = readTitleSave(store({}));
    expect(s.lastCiv).toBeNull();
    expect(s.hasContinue).toBe(false);
    expect(s.continueLabel).toBeNull();
  });

  it('前回選んだ文明を読む', () => {
    const s = readTitleSave(store({ [LAST_CIV_KEY]: 'mongol' }));
    expect(s.lastCiv).toBe('mongol');
  });

  it('未知の文明 ID は無地に落とす（JSON を書き換えた後の古いセーブ対策）', () => {
    expect(readTitleSave(store({ [LAST_CIV_KEY]: 'atlantis' })).lastCiv).toBeNull();
  });

  it('続きの章名を読む', () => {
    const s = readTitleSave(store({ [CONTINUE_KEY]: '{"label":"第 2 章 青銅の世"}' }));
    expect(s.hasContinue).toBe(true);
    expect(s.continueLabel).toBe('第 2 章 青銅の世');
  });

  it('続きの JSON が壊れていても「続きはある」扱いで例外を出さない', () => {
    const s = readTitleSave(store({ [CONTINUE_KEY]: '{壊れた' }));
    expect(s.hasContinue).toBe(true);
    expect(s.continueLabel).toBeNull();
  });
});

describe('buildTitleMenu — メニュー 4 項目（05§2-3）', () => {
  const noSave = { lastCiv: null, hasContinue: false, continueLabel: null };

  it('常に 4 項目（キャンペーン / スカーミッシュ / オンライン / リプレイ）', () => {
    const m = buildTitleMenu(noSave, registered('matchSetup'));
    expect(m.map((x) => x.id)).toEqual(['campaign', 'skirmish', 'online', 'replay']);
  });

  it('続きがあると最上段が「つづきから」に変わる（項目数は 4 のまま）', () => {
    const m = buildTitleMenu(
      { lastCiv: 'yamato', hasContinue: true, continueLabel: '第 1 章' },
      registered('matchSetup', 'campaign'),
    );
    expect(m).toHaveLength(4);
    expect(m[0]!.id).toBe('continue');
    expect(m[0]!.label).toBe('つづきから');
    expect(m[0]!.enabled).toBe(true);
  });

  it('未登録の画面は押せず、理由が付く（暗くする材料）', () => {
    const m = buildTitleMenu(noSave, registered('matchSetup'));
    const campaign = m[0]!;
    const replay = m[3]!;
    expect(campaign.enabled).toBe(false);
    expect(campaign.reason).toContain('M16');
    expect(replay.enabled).toBe(false);
    expect(replay.reason).toContain('M15');
  });

  it('スカーミッシュは対戦設定が登録されていれば押せる', () => {
    expect(buildTitleMenu(noSave, registered('matchSetup'))[1]!.enabled).toBe(true);
    expect(buildTitleMenu(noSave, registered())[1]!.enabled).toBe(false);
  });

  it('オンラインは画面があっても通信が未実装なので押せない（M14 待ち）', () => {
    const online = buildTitleMenu(noSave, registered('matchSetup'))[2]!;
    expect(online.enabled).toBe(false);
    expect(online.reason).toContain('M14');
  });

  it('押せる項目には理由が付かない', () => {
    for (const item of buildTitleMenu(noSave, registered('matchSetup', 'campaign', 'replay'))) {
      if (item.enabled) expect(item.reason).toBeNull();
      else expect(item.reason).not.toBeNull();
    }
  });
});

describe('buildSubButtons — 補助ボタン（05§2-4）', () => {
  it('設定とクレジットの 2 つだけ（ログイン項目は無い）', () => {
    const b = buildSubButtons(registered('settings'));
    expect(b.map((x) => x.id)).toEqual(['settings', 'credits']);
    expect(b.some((x) => x.label.includes('ログイン'))).toBe(false);
  });

  it('設定画面が未登録なら押せない', () => {
    expect(buildSubButtons(registered())[0]!.enabled).toBe(false);
    expect(buildSubButtons(registered('settings'))[0]!.enabled).toBe(true);
  });

  it('クレジットは画面 ID を持たない（タイトル内のパネル）', () => {
    expect(buildSubButtons(registered())[1]!.target).toBeNull();
  });
});

describe('skyPalette — 時刻とともに空の色が変わる（05§2-2）', () => {
  it('全時刻で #rrggbb を返す', () => {
    for (let h = 0; h < 24; h += 0.25) {
      const p = skyPalette(h);
      for (const c of [p.top, p.bottom, p.sun, p.sea, p.silhouette]) {
        expect(c).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it('昼と夜で色が違う（静止画ではない）', () => {
    expect(skyPalette(12).top).not.toBe(skyPalette(0).top);
    expect(skyPalette(12).sea).not.toBe(skyPalette(20).sea);
  });

  it('1 時間ごとに少しずつ変わる（隣接時刻で必ず差が出る）', () => {
    for (let h = 0; h < 24; h++) {
      expect(skyPalette(h).top).not.toBe(skyPalette(h + 1).top);
    }
  });

  it('24 時をまたいで輪として繋がる（0 時と 24 時が同じ）', () => {
    expect(skyPalette(24)).toEqual(skyPalette(0));
    expect(skyPalette(-1)).toEqual(skyPalette(23));
  });

  it('sunPosition は昼が太陽・夜が月で、高さは 0..1', () => {
    expect(sunPosition(12).isMoon).toBe(false);
    expect(sunPosition(2).isMoon).toBe(true);
    for (let h = 0; h < 24; h += 0.5) {
      const s = sunPosition(h);
      expect(s.y).toBeGreaterThanOrEqual(-0.001);
      expect(s.y).toBeLessThanOrEqual(1.001);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(1);
    }
  });
});
