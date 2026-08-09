/**
 * T-M12-06: 学舎（研究）パネル（`05§10`）
 *
 * DOM を触らない純関数だけを検証する:
 *  - 系統タブ 4 つ（鍛冶場 / 学舎 / 採集 / その他）と、**建てていない系統は開けない**
 *  - 研究済み = 金メダル / 研究可能 / 研究中 / 未解禁（錠）の 4 状態
 *  - 錠の理由は 3 種に分類（時代不足・前提未了は Age / 文明制限は Civ / 資源は Resource）
 *  - **前提線は飛び越せない**（前提未了なら開始できず、前提名が出る）
 *  - 文明置換（唐の翰林院）でも学舎タブが開く
 *  - 説明プレート（効果 / 効く場面 / 画面上での見え方）が data から出る
 */

import { describe, expect, it } from 'vitest';
import type { CivId } from '@/shared/types';
import { RESOURCE_IDS, resourceIndex } from '@/shared/types';
import { techDefById, techIndex } from '@/sim/core/defs';
import { markModifiersDirty } from '@/sim/core/effects';
import { fx, fxFromInt } from '@/sim/core/fx';
import { createWorld, type World } from '@/sim/core/world';
import { spawnBuilding } from '@/sim/systems/construction';
import { startResearch } from '@/sim/systems/production';
import { DisabledReason } from '@/ui/hud/commandGrid';
import {
  TECH_TAB_IDS,
  buildTechPanelModel,
  findResearchBuildingIndex,
  hasCompletedBuilding,
  judgeTech,
  lookTextOf,
  missingRequireNames,
  splitNote,
  tabBuildingIds,
  techTabOf,
} from '@/ui/hud/techPanel';

function makeWorld(civ: CivId, age = 2, resources = 5000): World {
  const w = createWorld({
    seed: 11,
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

describe('T-M12-06 系統タブ', () => {
  it('タブは 4 つ（鍛冶場 / 学舎 / 採集 / その他）', () => {
    expect(TECH_TAB_IDS).toEqual(['blacksmith', 'academy', 'gather', 'other']);
  });

  it('研究は `at` の建物でタブに割り振られる', () => {
    expect(techTabOf(techDefById('uchiba'))).toBe('blacksmith');
    expect(techTabOf(techDefById('hatazao'))).toBe('academy');
    expect(techTabOf(techDefById('ryotebono'))).toBe('gather');
    expect(techTabOf(techDefById('suki'))).toBe('gather');
    expect(techTabOf(techDefById('nida'))).toBe('other');
    expect(techTabOf(techDefById('zousen'))).toBe('other');
  });

  it('タブに載る建物が techs.json から出る', () => {
    expect(tabBuildingIds('blacksmith')).toEqual(['blacksmith']);
    expect(tabBuildingIds('academy')).toEqual(['academy']);
    expect(tabBuildingIds('gather').sort()).toEqual(['lumber_camp', 'mining_camp', 'town_center']);
    expect(tabBuildingIds('other').length).toBeGreaterThan(0);
  });

  it('建てていない系統のタブは暗く開けない', () => {
    const w = makeWorld('yamato');
    const before = buildTechPanelModel(w, 0, 'blacksmith');
    expect(before.tabs.find((t) => t.id === 'blacksmith')!.enabled).toBe(false);
    expect(before.tabs.find((t) => t.id === 'blacksmith')!.detail).toContain('鍛冶場');

    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    markModifiersDirty(w, 0);
    const after = buildTechPanelModel(w, 0, 'blacksmith');
    expect(after.tabs.find((t) => t.id === 'blacksmith')!.enabled).toBe(true);
  });

  it('文明置換でも開く（唐は翰林院が学舎タブを開ける）', () => {
    const w = makeWorld('tou');
    expect(hasCompletedBuilding(w, 0, 'academy')).toBe(false);
    spawnBuilding(w, 0, 'kanrin', fxFromInt(12), fxFromInt(12));
    expect(hasCompletedBuilding(w, 0, 'academy')).toBe(true);
    expect(buildTechPanelModel(w, 0, 'academy').tabs.find((t) => t.id === 'academy')!.enabled).toBe(
      true
    );
  });

  it('タブに研究済みの件数が出る', () => {
    const w = makeWorld('yamato');
    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    w.players[0]!.researched[techIndex('uchiba')] = 1;
    markModifiersDirty(w, 0);
    const tab = buildTechPanelModel(w, 0, 'blacksmith').tabs.find((t) => t.id === 'blacksmith')!;
    expect(tab.researched).toBe(1);
    expect(tab.total).toBeGreaterThan(1);
  });
});

describe('T-M12-06 メダルの状態と錠の理由', () => {
  it('研究できるなら available（クリックで即開始する Command が付く）', () => {
    const w = makeWorld('yamato');
    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    markModifiersDirty(w, 0);
    expect(judgeTech(w, 0, techDefById('uchiba')).state).toBe('available');
    const node = buildTechPanelModel(w, 0, 'blacksmith').columns
      .flat()
      .find((n) => n.id === 'uchiba')!;
    expect(node.command).not.toBeNull();
    expect(node.command).toMatchObject({ t: 'research', p: 0, tech: 'uchiba' });
  });

  it('研究済みは金メダル（researched）', () => {
    const w = makeWorld('yamato');
    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    w.players[0]!.researched[techIndex('uchiba')] = 1;
    markModifiersDirty(w, 0);
    const v = judgeTech(w, 0, techDefById('uchiba'));
    expect(v.state).toBe('researched');
  });

  it('研究中は inProgress（内政と戦闘は止まらない）', () => {
    const w = makeWorld('yamato');
    const b = spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    markModifiersDirty(w, 0);
    expect(startResearch(w, 0, b, 'uchiba')).toBe(true);
    const model = buildTechPanelModel(w, 0, 'blacksmith');
    const node = model.columns.flat().find((n) => n.id === 'uchiba')!;
    expect(node.state).toBe('inProgress');
    expect(model.runningLabel).toContain('打刃');
    expect(model.runningLabel).toContain('止まりません');
  });

  it('その文明が研究できない項目は Civ（アステカの鉄鎧系は永久に錠）', () => {
    const w = makeWorld('azteca', 3);
    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    w.players[0]!.researched[techIndex('kawayoroi')] = 1;
    markModifiersDirty(w, 0);
    const v = judgeTech(w, 0, techDefById('kusariyoroi'));
    expect(v.state).toBe('locked');
    expect(v.reason).toBe(DisabledReason.Civ);
    // ヤマトなら同じ状況で研究できる
    const y = makeWorld('yamato', 3);
    spawnBuilding(y, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    y.players[0]!.researched[techIndex('kawayoroi')] = 1;
    markModifiersDirty(y, 0);
    expect(judgeTech(y, 0, techDefById('kusariyoroi')).state).toBe('available');
  });

  it('時代が足りなければ Age', () => {
    const w = makeWorld('yamato', 1);
    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    markModifiersDirty(w, 0);
    const v = judgeTech(w, 0, techDefById('kouba'));
    expect(v.reason).toBe(DisabledReason.Age);
    expect(v.detail).toContain('鉄器');
  });

  it('前提を飛び越せない（前提未了は Age + 前提名 + 「飛び越せない」）', () => {
    const w = makeWorld('yamato', 2);
    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    markModifiersDirty(w, 0);
    expect(missingRequireNames(w, 0, techDefById('kouba'))).toEqual(['打刃']);
    const v = judgeTech(w, 0, techDefById('kouba'));
    expect(v.state).toBe('locked');
    expect(v.reason).toBe(DisabledReason.Age);
    expect(v.detail).toContain('打刃');
    expect(v.detail).toContain('飛び越せない');

    // 前提を満たすと開く
    w.players[0]!.researched[techIndex('uchiba')] = 1;
    markModifiersDirty(w, 0);
    expect(judgeTech(w, 0, techDefById('kouba')).state).toBe('available');
  });

  it('その建物が無ければ Age（建てると開く）', () => {
    const w = makeWorld('yamato', 2);
    const v = judgeTech(w, 0, techDefById('uchiba'));
    expect(v.state).toBe('locked');
    expect(v.reason).toBe(DisabledReason.Age);
    expect(v.detail).toContain('鍛冶場');
    expect(findResearchBuildingIndex(w, 0, techDefById('uchiba'))).toBe(-1);
  });

  it('資源が足りなければ Resource（足りない資源の index を返す）', () => {
    const w = makeWorld('yamato', 2, 0);
    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    markModifiersDirty(w, 0);
    const v = judgeTech(w, 0, techDefById('uchiba'));
    expect(v.reason).toBe(DisabledReason.Resource);
    expect(v.lacking).toContain(resourceIndex('food'));
  });

  it('錠の理由は必ず 3 種のどれか（学舎タブ全件）', () => {
    const w = makeWorld('viking', 1, 50);
    spawnBuilding(w, 0, 'academy', fxFromInt(12), fxFromInt(12));
    markModifiersDirty(w, 0);
    for (const n of buildTechPanelModel(w, 0, 'academy').columns.flat()) {
      if (n.state !== 'locked') continue;
      expect([DisabledReason.Age, DisabledReason.Resource, DisabledReason.Civ]).toContain(n.reason);
      expect(n.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('T-M12-06 前提線と列', () => {
  it('前提線は親子で張られ、親が研究済みかで satisfied が変わる', () => {
    const w = makeWorld('yamato', 3);
    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    markModifiersDirty(w, 0);
    const before = buildTechPanelModel(w, 0, 'blacksmith');
    const edge = before.edges.find((e) => e.to === 'kouba')!;
    expect(edge.from).toBe('uchiba');
    expect(edge.satisfied).toBe(false);

    w.players[0]!.researched[techIndex('uchiba')] = 1;
    markModifiersDirty(w, 0);
    expect(buildTechPanelModel(w, 0, 'blacksmith').edges.find((e) => e.to === 'kouba')!.satisfied).toBe(
      true
    );
  });

  it('列は時代（右へ進むほど後の時代）で分かれる', () => {
    const w = makeWorld('yamato', 3);
    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    const model = buildTechPanelModel(w, 0, 'blacksmith');
    const uchiba = model.columns.flat().find((n) => n.id === 'uchiba')!;
    const bankin = model.columns.flat().find((n) => n.id === 'bankinyoroi')!;
    expect(uchiba.ageIdx).toBeLessThan(bankin.ageIdx);
    expect(model.columns[uchiba.ageIdx]!.some((n) => n.id === 'uchiba')).toBe(true);
    expect(uchiba.isRoot).toBe(true);
    expect(bankin.isRoot).toBe(false);
  });

  it('他文明の固有研究は並ばない（自分の固有研究は並ぶ）', () => {
    const w = makeWorld('roma', 3);
    spawnBuilding(w, 0, 'academy', fxFromInt(12), fxFromInt(12));
    const ids = buildTechPanelModel(w, 0, 'academy').columns.flat().map((n) => n.id);
    expect(ids).toContain('guntan'); // ローマの固有研究
    expect(ids).not.toContain('ekiden'); // モンゴルの固有研究
  });
});

describe('T-M12-06 説明プレート', () => {
  it('note を「効果」と「効く場面」に割る', () => {
    expect(splitNote('戦域スロット +1。城を建てる石材がないとき')).toEqual({
      effect: '戦域スロット +1',
      scene: '城を建てる石材がないとき',
    });
    expect(splitNote('効果だけ')).toEqual({ effect: '効果だけ', scene: '' });
  });

  it('画面上での見え方が効果の型から出る（`05§10` の表）', () => {
    expect(lookTextOf(techDefById('hatazao'))).toContain('空きスロット');
    expect(lookTextOf(techDefById('hayaba'))).toContain('砂時計');
    expect(lookTextOf(techDefById('fukusho'))).toContain('点線');
    expect(lookTextOf(techDefById('nijuuhata'))).toContain('2 段');
    expect(lookTextOf(techDefById('chouheirei'))).toContain('リング');
  });

  it('必要資源と時間がデータから出る', () => {
    const w = makeWorld('yamato', 3);
    spawnBuilding(w, 0, 'academy', fxFromInt(12), fxFromInt(12));
    const node = buildTechPanelModel(w, 0, 'academy').columns.flat().find((n) => n.id === 'hatazao')!;
    expect(node.costText).toContain('木200');
    expect(node.costText).toContain('金100');
    expect(node.timeText).toBe('45 秒');
    expect(node.effectText).toContain('戦域スロット');
  });

  it('写本（研究コスト −15%）を取ると以降のコスト表示が下がる', () => {
    const w = makeWorld('yamato', 3);
    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    spawnBuilding(w, 0, 'academy', fxFromInt(20), fxFromInt(20));
    const before = buildTechPanelModel(w, 0, 'blacksmith')
      .columns.flat()
      .find((n) => n.id === 'uchiba')!.costText;
    w.players[0]!.researched[techIndex('shahon')] = 1;
    markModifiersDirty(w, 0);
    const after = buildTechPanelModel(w, 0, 'blacksmith')
      .columns.flat()
      .find((n) => n.id === 'uchiba')!.costText;
    expect(after).not.toBe(before);
  });
});

describe('T-M12-06 sim を書き換えない', () => {
  it('モデルを何度作っても World は動かない', () => {
    const w = makeWorld('yamato', 3);
    spawnBuilding(w, 0, 'blacksmith', fxFromInt(12), fxFromInt(12));
    const res = Array.from(w.players[0]!.resources);
    const tech = Array.from(w.players[0]!.researched);
    const tick = w.tick;
    for (const tab of TECH_TAB_IDS) buildTechPanelModel(w, 0, tab);
    expect(Array.from(w.players[0]!.resources)).toEqual(res);
    expect(Array.from(w.players[0]!.researched)).toEqual(tech);
    expect(w.tick).toBe(tick);
  });
});
