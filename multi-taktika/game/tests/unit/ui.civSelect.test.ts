/**
 * tests/unit/ui.civSelect.test.ts — 文明選択画面の純関数（T-M12-11 / `05§4`）
 *
 * いちばん大事なのは「**持たない役割の枠が暗くなる**」判定
 * （完了条件: ヴァイキング・アステカの騎兵枠が暗い）。
 * 文明の中身は `civs.json` から引いているので、この検証は JSON と実装の整合も兼ねる。
 */

import { describe, expect, it } from 'vitest';

import { CIV_IDS } from '@/shared/types';
import { CIV_DEFS, civDefById, orderDefById } from '@/sim/core/defs';
import {
  CIV_ASSETS,
  CIV_GRID,
  RANDOM_CIV,
  THUMB_LINES,
  civEconBonusText,
  civEliteName,
  civInitial,
  civLabel,
  civUniqueOrder,
  mainRoleThumbs,
  pickRandomCiv,
  resolveCivSlot,
} from '@/ui/screens/CivSelect';

describe('CIV_GRID — 紋章グリッド 9 枠（05§4-1）', () => {
  it('9 枠で、末尾がランダム枠', () => {
    expect(CIV_GRID).toHaveLength(9);
    expect(CIV_GRID[8]).toBe(RANDOM_CIV);
  });

  it('8 文明がちょうど 1 回ずつ入っている', () => {
    const civs = CIV_GRID.filter((x) => x !== RANDOM_CIV);
    expect(new Set(civs).size).toBe(8);
    for (const id of CIV_IDS) expect(civs).toContain(id);
  });

  it('並びは資料どおり（左上から ヤマト／唐／ローマ／ヴァイキング／マリ／アステカ／ペルシア／モンゴル）', () => {
    expect(CIV_GRID.slice(0, 8).map((x) => civLabel(x))).toEqual([
      'ヤマト',
      '唐',
      'ローマ',
      'ヴァイキング',
      'マリ',
      'アステカ',
      'ペルシア',
      'モンゴル',
    ]);
  });
});

describe('mainRoleThumbs — 主力兵サムネイル（05§4-5）', () => {
  it('必ず 近接・遠隔・騎兵 の 3 枠', () => {
    for (const civ of CIV_IDS) {
      const t = mainRoleThumbs(civ);
      expect(t.map((x) => x.line)).toEqual([...THUMB_LINES]);
    }
  });

  it('ヴァイキングとアステカの騎兵枠は暗い（持たない役割）', () => {
    for (const civ of ['viking', 'azteca'] as const) {
      const cav = mainRoleThumbs(civ).find((x) => x.line === 'cavalry')!;
      expect(cav.has).toBe(false);
      expect(cav.unitId).toBeNull();
      expect(cav.label).toBe('騎兵を持たない');
    }
  });

  it('モンゴルは徒歩の遠隔を持たない（03§5 の「穴」）', () => {
    const ranged = mainRoleThumbs('mongol').find((x) => x.line === 'ranged')!;
    expect(ranged.has).toBe(false);
  });

  it('ローマは 3 系統すべて揃う（穴なし）', () => {
    expect(mainRoleThumbs('roma').every((x) => x.has)).toBe(true);
  });

  it('代表はその系統の最上段で、持つ役割には必ず名前が付く', () => {
    for (const civ of CIV_IDS) {
      for (const t of mainRoleThumbs(civ)) {
        if (!t.has) continue;
        const tiers = civDefById(civ).unitTree[t.line] ?? [];
        const flat = tiers
          .map((v) => (Array.isArray(v) ? (v[0] ?? null) : v))
          .filter((v) => v !== null && v !== undefined);
        expect(t.unitId).toBe(flat[flat.length - 1]);
        expect(t.label.length).toBeGreaterThan(0);
        expect(t.label).not.toContain('持たない');
      }
    }
  });

  it('「持たない役割」の判定は civs.json の unitTree と一致する（UI に書き写していない）', () => {
    for (const def of CIV_DEFS) {
      for (const line of THUMB_LINES) {
        const tiers = def.unitTree[line] ?? [];
        const hasAny = tiers.some((v) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined));
        const thumb = mainRoleThumbs(def.id).find((x) => x.line === line)!;
        expect(thumb.has).toBe(hasAny);
      }
    }
  });
});

describe('civEconBonusText — 内政ボーナス 1 行（05§4-6）', () => {
  it('全文明で空文字にならない', () => {
    for (const civ of CIV_IDS) {
      expect(civEconBonusText(civ).length).toBeGreaterThan(0);
    }
  });

  it('econBonus が空の文明は「内政ボーナスなし」と明示する', () => {
    const empty = CIV_DEFS.filter((c) => c.econBonus.length === 0);
    expect(empty.length).toBeGreaterThan(0); // 唐
    for (const c of empty) expect(civEconBonusText(c.id)).toBe('内政ボーナスなし');
  });

  it('倍率は %、開始資源は加算で出る', () => {
    expect(civEconBonusText('yamato')).toContain('+15%');
    expect(civEconBonusText('persia')).toContain('開始資源');
  });
});

describe('civUniqueOrder — 固有令 1 枚（05§4-6）', () => {
  it('文明の uniqueOrder（orders.json）と一致する', () => {
    for (const civ of CIV_IDS) {
      const info = civUniqueOrder(civ);
      const def = orderDefById(civDefById(civ).uniqueOrder);
      expect(info.id).toBe(def.id);
      expect(info.name).toBe(def.name);
      expect(info.key).toBe(def.key);
      expect(['上段', '下段']).toContain(info.tierLabel);
    }
  });

  it('固有令は 8 文明で全部違う', () => {
    expect(new Set(CIV_IDS.map((c) => civUniqueOrder(c).id)).size).toBe(8);
  });

  it('エリートユニット名が引ける', () => {
    for (const civ of CIV_IDS) expect(civEliteName(civ).length).toBeGreaterThan(0);
  });
});

describe('ランダム枠（05§4-3）', () => {
  it('同じ seed からは必ず同じ文明（決定論）', () => {
    for (let s = 0; s < 20; s++) expect(pickRandomCiv(s)).toBe(pickRandomCiv(s));
  });

  it('8 文明すべてが出る', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 64; s++) seen.add(pickRandomCiv(s));
    expect(seen.size).toBe(8);
  });

  it('負のシード・小数でも文明 ID を返す', () => {
    expect(CIV_IDS).toContain(pickRandomCiv(-7));
    expect(CIV_IDS).toContain(pickRandomCiv(3.9));
  });

  it('resolveCivSlot は文明枠をそのまま、ランダム枠だけ解決する', () => {
    expect(resolveCivSlot('mali', 123)).toBe('mali');
    expect(CIV_IDS).toContain(resolveCivSlot(RANDOM_CIV, 123));
  });
});

describe('プレースホルダとアセット差し替え口', () => {
  it('既定では画像アセットを返さない（M17 まで文字と図形で描く）', () => {
    expect(CIV_ASSETS.emblem('yamato')).toBeNull();
    expect(CIV_ASSETS.portrait('yamato')).toBeNull();
    expect(CIV_ASSETS.unit('y-nagae')).toBeNull();
  });

  it('差し替えたら以降その URL が返る（M17 の入口）', () => {
    const orig = CIV_ASSETS.emblem;
    CIV_ASSETS.emblem = (civ) => `/assets/emblem/${civ}.png`;
    expect(CIV_ASSETS.emblem('mongol')).toBe('/assets/emblem/mongol.png');
    CIV_ASSETS.emblem = orig;
    expect(CIV_ASSETS.emblem('mongol')).toBeNull();
  });

  it('紋章プレースホルダの文字は文明名の 1 文字目、ランダム枠は ？', () => {
    expect(civInitial('yamato')).toBe('ヤ');
    expect(civInitial(RANDOM_CIV)).toBe('？');
    expect(civLabel(RANDOM_CIV)).toBe('ランダム');
  });
});
