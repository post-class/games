/**
 * T-M12-05: 生産・建設パネル（`05§9`）
 *
 * DOM を触らない純関数だけを検証する（jsdom の無い環境でも走る）:
 *  - 3 段 12 スロットとキー `QWER/ASDF/ZXCV` が**位置で一対一**
 *  - 暗いボタンの理由が**3 種**（時代不足 / 資源不足 / その文明が持てない）に分類される
 *  - ヴァイキング・アステカの厩は `Civ`（**永久に暗い**）
 *  - 兵舎の生産一覧が `units.json:producedAt` から出る（`buildings.json:produces` は空）
 *  - 生産キューは既定 5 件、ローマ「軍団編成」で 10 件
 *  - 属性の研究ぶんが金色の加算（`bonus`）として出る
 */

import { describe, expect, it } from 'vitest';
import type { CivId } from '@/shared/types';
import { EntityKind, RESOURCE_IDS, resourceIndex } from '@/shared/types';
import { buildingDefById, techIndex, unitIndex } from '@/sim/core/defs';
import { markModifiersDirty } from '@/sim/core/effects';
import { spawnEntity } from '@/sim/core/entity';
import { fx, fxFromInt } from '@/sim/core/fx';
import { createWorld, type World } from '@/sim/core/world';
import { spawnBuilding } from '@/sim/systems/construction';
import {
  DisabledReason,
  GRID_COLS,
  GRID_KEYS,
  GRID_ROWS,
  buildCommandGrid,
  buildProductionPanelModel,
  buildRowOf,
  judgeBuild,
  lockGlyph,
} from '@/ui/hud/commandGrid';

function makeWorld(civ: CivId, age = 2, resources = 5000): World {
  const w = createWorld({
    seed: 7,
    playerCount: 1,
    mapWidthTiles: 64,
    mapHeightTiles: 64,
    civs: [civ],
  });
  const pl = w.players[0]!;
  pl.age = age;
  pl.popCap = 200;
  for (let r = 0; r < RESOURCE_IDS.length; r++) pl.resources[r] = fx(resources);
  return w;
}

/** 村人を 1 体出して EntityId を返す。 */
function spawnVillager(w: World): number {
  return spawnEntity(w.entities, {
    kind: EntityKind.Unit,
    owner: 0,
    typeId: unitIndex('villager'),
    x: fxFromInt(10),
    y: fxFromInt(10),
    hpMax: fx(40),
  });
}

describe('T-M12-05 グリッドの形', () => {
  it('スロットは常に 12 件で、キーは QWER/ASDF/ZXCV と位置で一対一', () => {
    const w = makeWorld('yamato');
    const v = spawnVillager(w);
    const model = buildProductionPanelModel(w, 0, [v]);
    expect(model.slots.length).toBe(GRID_KEYS.length);
    expect(GRID_ROWS * GRID_COLS).toBe(GRID_KEYS.length);
    model.slots.forEach((s, k) => {
      expect(s.key).toBe(GRID_KEYS[k]);
      expect(s.row).toBe(Math.floor(k / GRID_COLS));
      expect(s.col).toBe(k % GRID_COLS);
      if (s.button !== null) expect(s.button.key).toBe(GRID_KEYS[k]);
    });
  });

  it('選択が空なら 12 件すべて空きスロット', () => {
    const w = makeWorld('yamato');
    const model = buildProductionPanelModel(w, 0, []);
    expect(model.slots.every((s) => s.button === null)).toBe(true);
    expect(model.target).toBeNull();
  });

  it('段の意味はデータの性質で決まる（内政 / 生産・研究 / 防御・その他）', () => {
    expect(buildRowOf(buildingDefById('house'))).toBe(0);
    expect(buildRowOf(buildingDefById('lumber_camp'))).toBe(0);
    expect(buildRowOf(buildingDefById('barracks'))).toBe(1);
    expect(buildRowOf(buildingDefById('blacksmith'))).toBe(1);
    expect(buildRowOf(buildingDefById('palisade'))).toBe(2);
    expect(buildRowOf(buildingDefById('castle'))).toBe(2);
  });

  it('候補が 1 段 4 個を超えるとページが増える（段の意味は変わらない）', () => {
    const w = makeWorld('yamato', 3);
    const v = spawnVillager(w);
    const model = buildProductionPanelModel(w, 0, [v]);
    expect(model.pageCount).toBeGreaterThan(1);
    const page1 = buildProductionPanelModel(w, 0, [v], 1);
    expect(page1.page).toBe(1);
    expect(page1.rowLabels).toEqual(model.rowLabels);
    // ページを送っても 12 スロットの位置とキーは動かない
    page1.slots.forEach((s, k) => expect(s.key).toBe(GRID_KEYS[k]));
  });
});

describe('T-M12-05 暗いボタンの理由は 3 種', () => {
  it('その文明が持てない（ヴァイキングの厩は永久に暗い）', () => {
    for (const civ of ['viking', 'azteca'] as const) {
      const w = makeWorld(civ, 3);
      const v = judgeBuild(w, 0, buildingDefById('stable'));
      expect(v.enabled).toBe(false);
      expect(v.reason).toBe(DisabledReason.Civ);
      // 資源をいくら積んでも時代を上げても変わらない
      expect(judgeBuild(makeWorld(civ, 3, 99999), 0, buildingDefById('stable')).reason).toBe(
        DisabledReason.Civ
      );
    }
    // 騎兵を持つ文明では暗くない
    expect(judgeBuild(makeWorld('yamato', 3), 0, buildingDefById('stable')).enabled).toBe(true);
  });

  it('時代が足りない', () => {
    const w = makeWorld('yamato', 0);
    const v = judgeBuild(w, 0, buildingDefById('barracks'));
    expect(v.enabled).toBe(false);
    expect(v.reason).toBe(DisabledReason.Age);
    expect(v.detail).toContain('青銅');
  });

  it('資源が足りない（足りない資源の index を返す）', () => {
    const w = makeWorld('yamato', 2, 0);
    const v = judgeBuild(w, 0, buildingDefById('barracks'));
    expect(v.enabled).toBe(false);
    expect(v.reason).toBe(DisabledReason.Resource);
    expect(v.lacking).toContain(resourceIndex('wood'));
  });

  it('建設上限（市場 1 棟）は「今は無理」= 資源側に分類する', () => {
    const w = makeWorld('yamato', 2);
    spawnBuilding(w, 0, 'market', fxFromInt(20), fxFromInt(20));
    markModifiersDirty(w, 0);
    const v = judgeBuild(w, 0, buildingDefById('market'));
    expect(v.enabled).toBe(false);
    expect(v.reason).toBe(DisabledReason.Resource);
    expect(v.detail).toContain('棟まで');
  });

  it('理由 3 種は錠の記号で区別できる（色に頼らない）', () => {
    expect(lockGlyph(DisabledReason.Civ)).not.toBe(lockGlyph(DisabledReason.Age));
    expect(lockGlyph(DisabledReason.Age)).not.toBe(lockGlyph(DisabledReason.Resource));
    expect(lockGlyph(DisabledReason.None)).toBe('');
  });

  it('村人のグリッドに出る暗いボタンは必ず 3 種のどれか', () => {
    const w = makeWorld('viking', 1, 100);
    const v = spawnVillager(w);
    const model = buildProductionPanelModel(w, 0, [v]);
    const reasons = new Set<string>();
    for (const s of model.slots) {
      if (s.button === null || s.button.enabled) continue;
      reasons.add(s.button.reason);
      expect(s.button.detail.length).toBeGreaterThan(0); // 「なんとなく押せない」を作らない
    }
    for (const r of reasons) {
      expect([DisabledReason.Age, DisabledReason.Resource, DisabledReason.Civ]).toContain(r);
    }
  });
});

describe('T-M12-05 建物を選んだとき', () => {
  it('兵舎の生産一覧が producedAt から出る（buildings.json の produces は空）', () => {
    const w = makeWorld('yamato', 2);
    const b = spawnBuilding(w, 0, 'barracks', fxFromInt(12), fxFromInt(12));
    const model = buildProductionPanelModel(w, 0, [b]);
    const produce = model.slots
      .map((s) => s.button)
      .filter((x) => x !== null && x.kind === 'produce');
    expect(buildingDefById('barracks').produces.length).toBe(0);
    expect(produce.length).toBeGreaterThan(0);
    expect(produce.some((x) => x!.enabled)).toBe(true);
    expect(model.rowLabels[0]).toBe('生産');
  });

  it('鍛冶場では研究が中段に並び、研究済みは消える', () => {
    const w = makeWorld('yamato', 2);
    const b = spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    const before = buildProductionPanelModel(w, 0, [b]);
    const names = before.slots
      .filter((s) => s.button?.kind === 'research')
      .map((s) => s.button!.label);
    expect(names).toContain('打刃');
    for (const s of before.slots) {
      if (s.button?.kind === 'research') expect(s.row).toBe(1);
    }
    w.players[0]!.researched[techIndex('uchiba')] = 1;
    markModifiersDirty(w, 0);
    const after = buildProductionPanelModel(w, 0, [b]);
    expect(
      after.slots.filter((s) => s.button?.kind === 'research').map((s) => s.button!.label)
    ).not.toContain('打刃');
  });

  it('前提研究を飛び越せない（未研究なら Age + 前提名を出す）', () => {
    const w = makeWorld('yamato', 2);
    const b = spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    const model = buildProductionPanelModel(w, 0, [b]);
    const kouba = model.slots.map((s) => s.button).find((x) => x?.label === '鋼刃');
    expect(kouba).toBeDefined();
    expect(kouba!.enabled).toBe(false);
    expect(kouba!.reason).toBe(DisabledReason.Age);
    expect(kouba!.detail).toContain('打刃');
  });

  it('生産キューは既定 5 件、ローマ「軍団編成」で 10 件', () => {
    const w = makeWorld('yamato', 2);
    const b = spawnBuilding(w, 0, 'barracks', fxFromInt(12), fxFromInt(12));
    expect(buildProductionPanelModel(w, 0, [b]).queueLimit).toBe(5);

    const r = makeWorld('roma', 2);
    const rb = spawnBuilding(r, 0, 'barracks', fxFromInt(12), fxFromInt(12));
    expect(buildProductionPanelModel(r, 0, [rb]).queueLimit).toBe(5);
    r.players[0]!.researched[techIndex('guntan')] = 1;
    markModifiersDirty(r, 0);
    expect(buildProductionPanelModel(r, 0, [rb]).queueLimit).toBe(10);
  });

  it('人口上限は「資源側」に分類する（作れていたボタンが資源理由で暗くなる）', () => {
    const w = makeWorld('yamato', 2);
    const b = spawnBuilding(w, 0, 'barracks', fxFromInt(12), fxFromInt(12));
    const enabledLabel = buildProductionPanelModel(w, 0, [b])
      .slots.map((s) => s.button)
      .find((x) => x?.kind === 'produce' && x.enabled)!.label;

    const pl = w.players[0]!;
    pl.pop = pl.popCap;
    const after = buildProductionPanelModel(w, 0, [b])
      .slots.map((s) => s.button)
      .find((x) => x?.label === enabledLabel)!;
    expect(after.enabled).toBe(false);
    expect(after.reason).toBe(DisabledReason.Resource);
    expect(after.detail).toContain('人口上限');
  });

  it('時代進化は解読できる建物にだけ出る', () => {
    const w = makeWorld('yamato', 0);
    const tc = spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    const model = buildProductionPanelModel(w, 0, [tc]);
    const adv = model.slots.map((s) => s.button).find((x) => x?.kind === 'advanceAge');
    expect(adv).toBeDefined();
    expect(adv!.hint).toContain('戦域スロット');

    const b = spawnBuilding(w, 0, 'barracks', fxFromInt(30), fxFromInt(30));
    const m2 = buildProductionPanelModel(w, 0, [b]);
    expect(m2.slots.map((s) => s.button).some((x) => x?.kind === 'advanceAge')).toBe(false);
  });
});

describe('T-M12-05 選択中の対象と属性', () => {
  it('体力バーと建設中の進捗が出る', () => {
    const w = makeWorld('yamato', 2);
    const b = spawnBuilding(w, 0, 'barracks', fxFromInt(12), fxFromInt(12));
    const t = buildProductionPanelModel(w, 0, [b]).target;
    expect(t).not.toBeNull();
    expect(t!.name).toBe('兵舎');
    expect(t!.hpRatio).toBeGreaterThan(0);
    expect(t!.underConstruction).toBe(false);
  });

  it('研究で伸びた分が金色の加算（bonus）として出る', () => {
    const w = makeWorld('yamato', 2);
    const u = spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner: 0,
      typeId: unitIndex('y-ashigaru'),
      x: fxFromInt(10),
      y: fxFromInt(10),
      hpMax: fx(60),
    });
    const before = buildProductionPanelModel(w, 0, [u]).target!;
    expect(before.attrs.find((a) => a.label === '攻撃')!.bonus).toBe(0);

    w.players[0]!.researched[techIndex('uchiba')] = 1; // 近接兵の攻撃 +1
    markModifiersDirty(w, 0);
    const after = buildProductionPanelModel(w, 0, [u]).target!;
    expect(after.attrs.find((a) => a.label === '攻撃')!.bonus).toBeGreaterThan(0);
    // 素の値は動かない（金色の加算表示は「伸びた分」だけ）
    expect(after.attrs.find((a) => a.label === '攻撃')!.base).toBe(
      before.attrs.find((a) => a.label === '攻撃')!.base
    );
  });

  it('文明での呼び名で出る（ヤマトの見張り塔は櫓）', () => {
    const w = makeWorld('yamato', 2);
    const y = spawnBuilding(w, 0, 'yagura', fxFromInt(14), fxFromInt(14));
    expect(buildProductionPanelModel(w, 0, [y]).target!.name).toBe('櫓');
  });

  it('村人が持てない建物は候補から消えず、置換元だけが消える', () => {
    const w = makeWorld('yamato', 2);
    const v = spawnVillager(w);
    const labels: string[] = [];
    for (let page = 0; page < 4; page++) {
      for (const s of buildProductionPanelModel(w, 0, [v], page).slots) {
        if (s.button !== null) labels.push(s.button.label);
      }
    }
    expect(labels).toContain('櫓'); // 置換先
    expect(labels).not.toContain('見張り塔'); // 置換元は出さない
  });
});

describe('T-M12-05 旧 API（Hud.ts 用）', () => {
  it('詰めた配列を返し、添字がそのままキーになる', () => {
    const w = makeWorld('yamato', 2);
    const v = spawnVillager(w);
    const grid = buildCommandGrid(w, 0, [v]);
    expect(grid.length).toBeGreaterThan(0);
    expect(grid.length).toBeLessThanOrEqual(GRID_KEYS.length);
    grid.forEach((b, k) => expect(b.key).toBe(GRID_KEYS[k]));
  });
});

describe('T-M12-05 sim を書き換えない', () => {
  it('モデルを何度作っても資源も研究状態も動かない', () => {
    const w = makeWorld('yamato', 2);
    const b = spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    const before = Array.from(w.players[0]!.resources);
    const beforeTech = Array.from(w.players[0]!.researched);
    for (let k = 0; k < 5; k++) buildProductionPanelModel(w, 0, [b], k);
    expect(Array.from(w.players[0]!.resources)).toEqual(before);
    expect(Array.from(w.players[0]!.researched)).toEqual(beforeTech);
  });
});
