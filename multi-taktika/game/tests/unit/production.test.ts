/**
 * T-M6-01 / 05 / 06 / 07: 生産キュー・文明制限・集合地点・エリート
 *
 * 検証:
 *  - キューは既定 5 件、ローマ「軍団編成」で 10 件
 *  - リング進捗が Fx で進み、`buildSec` どおりの tick で 1 体出る
 *  - 取消は**全額返却**
 *  - 人口上限に当たったら進行が止まる（キューは消えない）
 *  - 集合地点を設定すると生産された兵が自動で向かう（`destX/destY`）
 *  - エリートは**城（モンゴルは大天幕）でのみ**生産でき、金が必要
 *  - 文明の禁止・置換（ヴァイキングの厩／石壁／城門／火薬工房、アステカの鉄鎧系）
 */

import { describe, expect, it } from 'vitest';
import type { CivId } from '@/shared/types';
import { EntityKind, RESOURCE_IDS, resourceIndex } from '@/shared/types';
import { fx, fxFromInt } from '@/sim/core/fx';
import { createWorld, type World } from '@/sim/core/world';
import { buildingDefById, canCivResearch, techDefById, unitDefById } from '@/sim/core/defs';
import { entityIndex } from '@/sim/core/entity';
import { markModifiersDirty, PROGRESS_DONE } from '@/sim/core/effects';
import { beginConstruction, spawnBuilding } from '@/sim/systems/construction';
import {
  cancelQueueItem,
  canStartResearch,
  isProductionSource,
  isUnitAvailable,
  production,
  productionQueueLimit,
  queueUnitProduction,
  setRallyPoint,
  startResearch,
  unitCostFx,
} from '@/sim/systems/production';

function makeWorld(civ: CivId, age = 2): World {
  const w = createWorld({
    seed: 3,
    playerCount: 1,
    mapWidthTiles: 64,
    mapHeightTiles: 64,
    civs: [civ],
  });
  const pl = w.players[0]!;
  pl.age = age;
  pl.popCap = 200;
  for (let r = 0; r < RESOURCE_IDS.length; r++) pl.resources[r] = fx(5000);
  return w;
}

function give(w: World, resource: 'food' | 'wood' | 'stone' | 'gold', amount: number): void {
  w.players[0]!.resources[resourceIndex(resource)] = fx(amount);
}

function res(w: World, resource: 'food' | 'wood' | 'stone' | 'gold'): number {
  return w.players[0]!.resources[resourceIndex(resource)]!;
}

function step(w: World, ticks: number): void {
  for (let t = 0; t < ticks; t++) {
    production(w);
    w.tick += 1;
  }
}

/** 生産が終わって出てきたユニット index を集める。 */
function unitIndices(w: World): number[] {
  const out: number[] = [];
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] === 1 && e.kind[i] === EntityKind.Unit) out.push(i);
  }
  return out;
}

describe('T-M6-01 生産キュー', () => {
  it('既定の上限は 5 件', () => {
    const w = makeWorld('yamato');
    const barracks = spawnBuilding(w, 0, 'barracks', fxFromInt(10), fxFromInt(10));
    expect(productionQueueLimit(w, 0, 'barracks')).toBe(5);
    const queued = queueUnitProduction(w, 0, barracks, 'y-musha', 8);
    expect(queued).toBe(5);
    expect(w.entities.queueCount[entityIndex(barracks)]).toBe(5);
  });

  it('ローマ「軍団編成」で 10 件になる', () => {
    const w = makeWorld('roma');
    const barracks = spawnBuilding(w, 0, 'barracks', fxFromInt(10), fxFromInt(10));
    w.players[0]!.researched[unitFreeTechIndex('guntan')] = 1;
    markModifiersDirty(w, 0);
    expect(productionQueueLimit(w, 0, 'barracks')).toBe(10);
    expect(queueUnitProduction(w, 0, barracks, 'r-principes', 12)).toBe(10);
  });

  it('資源は積んだ時点で引き落とされ、取消で全額返る', () => {
    const w = makeWorld('yamato');
    const barracks = spawnBuilding(w, 0, 'barracks', fxFromInt(10), fxFromInt(10));
    const def = unitDefById('y-musha');
    const cost = unitCostFx(w, 0, def);
    const before = res(w, 'food');

    expect(queueUnitProduction(w, 0, barracks, 'y-musha', 3)).toBe(3);
    expect(res(w, 'food')).toBe(before - cost[resourceIndex('food')]! * 3);

    expect(cancelQueueItem(w, 0, barracks, 2)).toBe(true);
    expect(cancelQueueItem(w, 0, barracks, 0)).toBe(true);
    expect(cancelQueueItem(w, 0, barracks, 0)).toBe(true);
    expect(w.entities.queueCount[entityIndex(barracks)]).toBe(0);
    expect(res(w, 'food')).toBe(before);
    expect(cancelQueueItem(w, 0, barracks, 0)).toBe(false);
  });

  it('資源が足りない分は積めない', () => {
    const w = makeWorld('yamato');
    const barracks = spawnBuilding(w, 0, 'barracks', fxFromInt(10), fxFromInt(10));
    give(w, 'food', 130); // 武者 60 食料 → 2 体分
    expect(queueUnitProduction(w, 0, barracks, 'y-musha', 5)).toBe(2);
  });

  it('buildSec ちょうどで 1 体出て、キューが 1 つ減る', () => {
    const w = makeWorld('yamato');
    const tc = spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    const def = unitDefById('villager');
    queueUnitProduction(w, 0, tc, 'villager', 2);
    const b = entityIndex(tc);

    step(w, def.buildTicks - 1);
    expect(unitIndices(w).length).toBe(0);
    expect(w.entities.queueCount[b]).toBe(2);
    expect(w.entities.prodProgress[b]!).toBeGreaterThan(0);

    step(w, 1);
    expect(unitIndices(w).length).toBe(1);
    expect(w.entities.queueCount[b]).toBe(1);
    expect(w.players[0]!.pop).toBe(def.pop);

    step(w, def.buildTicks);
    expect(unitIndices(w).length).toBe(2);
    expect(w.entities.queueCount[b]).toBe(0);
    expect(w.entities.prodProgress[b]).toBe(0);
  });

  it('生産速度の研究で早くなる（徴兵令 +25%）', () => {
    const plain = makeWorld('yamato');
    const fast = makeWorld('yamato');
    fast.players[0]!.researched[unitFreeTechIndex('chouheirei')] = 1;
    markModifiersDirty(fast, 0);

    const ticksPlain = ticksToProduce(plain, 'barracks', 'y-musha');
    const ticksFast = ticksToProduce(fast, 'barracks', 'y-musha');
    expect(ticksPlain / ticksFast).toBeGreaterThan(1.2);
    expect(ticksPlain / ticksFast).toBeLessThan(1.3);
  });

  it('人口上限に当たったら進行が止まる（キューは残る）', () => {
    const w = makeWorld('yamato');
    const pl = w.players[0]!;
    pl.popCap = 1;
    pl.pop = 1;
    const tc = spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    queueUnitProduction(w, 0, tc, 'villager', 2);
    const b = entityIndex(tc);

    step(w, unitDefById('villager').buildTicks * 2);
    expect(unitIndices(w).length).toBe(0);
    expect(w.entities.queueCount[b]).toBe(2);
    expect(w.entities.prodProgress[b]).toBe(0);

    // 家を建てて上限が上がれば再開する
    pl.popCap = 10;
    step(w, unitDefById('villager').buildTicks);
    expect(unitIndices(w).length).toBe(1);
  });
});

describe('T-M6-06 集合地点', () => {
  it('生産された兵が集合地点へ向かう', () => {
    const w = makeWorld('yamato');
    const barracks = spawnBuilding(w, 0, 'barracks', fxFromInt(10), fxFromInt(10));
    expect(setRallyPoint(w, 0, barracks, fxFromInt(30), fxFromInt(40))).toBe(true);
    queueUnitProduction(w, 0, barracks, 'y-musha', 1);
    step(w, unitDefById('y-musha').buildTicks);

    const u = unitIndices(w)[0]!;
    expect(w.entities.destX[u]).toBe(fxFromInt(30));
    expect(w.entities.destY[u]).toBe(fxFromInt(40));
    expect(w.entities.homeId[u]).toBe(barracks);
  });

  it('集合地点が無ければ建物の位置に留まる', () => {
    const w = makeWorld('yamato');
    const barracks = spawnBuilding(w, 0, 'barracks', fxFromInt(11), fxFromInt(12));
    queueUnitProduction(w, 0, barracks, 'y-musha', 1);
    step(w, unitDefById('y-musha').buildTicks);
    const u = unitIndices(w)[0]!;
    expect(w.entities.destX[u]).toBe(fxFromInt(11));
    expect(w.entities.destY[u]).toBe(fxFromInt(12));
  });
});

describe('T-M6-07 エリートユニット', () => {
  it('城でだけ生産できる（兵舎・町の中心では不可）', () => {
    const w = makeWorld('yamato');
    const barracks = spawnBuilding(w, 0, 'barracks', fxFromInt(10), fxFromInt(10));
    const tc = spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    const castle = spawnBuilding(w, 0, 'castle', fxFromInt(30), fxFromInt(30));

    expect(queueUnitProduction(w, 0, barracks, 'y-bushi', 1)).toBe(0);
    expect(queueUnitProduction(w, 0, tc, 'y-bushi', 1)).toBe(0);
    expect(queueUnitProduction(w, 0, castle, 'y-bushi', 1)).toBe(1);
  });

  it('モンゴルは大天幕（城の置き換え）で生産する', () => {
    const w = makeWorld('mongol');
    const tent = spawnBuilding(w, 0, 'great_tent', fxFromInt(30), fxFromInt(30));
    expect(queueUnitProduction(w, 0, tent, 'g-guard-horsearcher', 1)).toBe(1);
    expect(isProductionSource(buildingDefById('great_tent'), unitDefById('g-guard-horsearcher')))
      .toBe(true);
    expect(isProductionSource(buildingDefById('barracks'), unitDefById('g-guard-horsearcher')))
      .toBe(false);
  });

  it('金が無いと生産できない（エリートは金必須）', () => {
    const w = makeWorld('yamato');
    const castle = spawnBuilding(w, 0, 'castle', fxFromInt(30), fxFromInt(30));
    give(w, 'gold', 0);
    expect(queueUnitProduction(w, 0, castle, 'y-bushi', 1)).toBe(0);
    give(w, 'gold', 30);
    expect(queueUnitProduction(w, 0, castle, 'y-bushi', 1)).toBe(1);
  });

  it('8 文明のエリートはすべて城／大天幕から出る', () => {
    for (const civ of ['yamato', 'roma', 'tou', 'viking', 'mali', 'azteca', 'persia', 'mongol']) {
      const w = makeWorld(civ as CivId);
      const elite = unitDefById(eliteOf(civ));
      const sourceId = civ === 'mongol' ? 'great_tent' : 'castle';
      const src = spawnBuilding(w, 0, sourceId, fxFromInt(30), fxFromInt(30));
      expect(queueUnitProduction(w, 0, src, elite.id, 1), `${civ} のエリート`).toBe(1);
      expect(elite.cost[resourceIndex('gold')]!).toBeGreaterThan(0);
    }
  });
});

describe('T-M6-05 文明ボーナス・禁止・置換', () => {
  it('ヴァイキングは厩・石壁・城門・火薬工房を建てられない', () => {
    const w = makeWorld('viking', 3);
    for (const id of ['stable', 'stone_wall', 'stone_gate', 'gunpowder_workshop']) {
      const r = beginConstruction(w, 0, id, fxFromInt(10), fxFromInt(10));
      expect(r.result, `viking が ${id} を建てられてしまう`).toBe('civForbidden');
    }
    // 木柵は建てられる
    expect(beginConstruction(w, 0, 'palisade', fxFromInt(15), fxFromInt(15)).result).toBe('ok');
  });

  it('アステカは鉄鎧系（鎖鎧・板金鎧・馬鎧）を研究できない', () => {
    const w = makeWorld('azteca', 3);
    const smith = spawnBuilding(w, 0, 'blacksmith', fxFromInt(10), fxFromInt(10));
    w.players[0]!.researched[unitFreeTechIndex('kawayoroi')] = 1;
    markModifiersDirty(w, 0);
    for (const id of ['kusariyoroi', 'bankinyoroi', 'bayoroi']) {
      expect(canCivResearch('azteca', id), id).toBe(false);
      expect(canStartResearch(w, 0, entityIndex(smith), id), id).toBe(false);
      expect(startResearch(w, 0, smith, id)).toBe(false);
    }
    // 代替の綿甲は研究できる（革鎧が前提）
    expect(canStartResearch(w, 0, entityIndex(smith), 'menkou')).toBe(true);
  });

  it('唐は鋼刃を研究できない（近接の攻撃研究が 1 段少ない）', () => {
    const w = makeWorld('tou', 3);
    const smith = spawnBuilding(w, 0, 'blacksmith', fxFromInt(10), fxFromInt(10));
    w.players[0]!.researched[unitFreeTechIndex('uchiba')] = 1;
    markModifiersDirty(w, 0);
    expect(canStartResearch(w, 0, entityIndex(smith), 'kouba')).toBe(false);
  });

  it('置換された建物は元の ID でも建てられる（ヤマトの櫓 / 唐の翰林院）', () => {
    const w = makeWorld('yamato', 3);
    const r = beginConstruction(w, 0, 'watch_tower', fxFromInt(10), fxFromInt(10));
    expect(r.result).toBe('ok');
    // 実体は櫓になっている
    expect(w.entities.typeId[entityIndex(r.id)]).toBe(buildingDefById('yagura').index);
  });

  it('前提研究が済んでいないと着手できない', () => {
    const w = makeWorld('yamato', 3);
    const smith = spawnBuilding(w, 0, 'blacksmith', fxFromInt(10), fxFromInt(10));
    expect(canStartResearch(w, 0, entityIndex(smith), 'kouba')).toBe(false);
    w.players[0]!.researched[unitFreeTechIndex('uchiba')] = 1;
    markModifiersDirty(w, 0);
    expect(canStartResearch(w, 0, entityIndex(smith), 'kouba')).toBe(true);
  });

  it('時代が足りない研究・ユニットは選べない', () => {
    const w = makeWorld('yamato', 1);
    const smith = spawnBuilding(w, 0, 'blacksmith', fxFromInt(10), fxFromInt(10));
    expect(canStartResearch(w, 0, entityIndex(smith), 'bayoroi')).toBe(false);
    expect(isUnitAvailable(w, 0, unitDefById('y-bushi'))).toBe(false);
    expect(isUnitAvailable(w, 0, unitDefById('y-ashigaru'))).toBe(true);
    // 兵種ツリーは「現在の世の段」だけ
    expect(isUnitAvailable(w, 0, unitDefById('y-musha'))).toBe(false);
  });

  it('ヴァイキングの長船は船小屋を建てるまで生産できない（unlockUnits）', () => {
    const w = makeWorld('viking', 2);
    expect(isUnitAvailable(w, 0, unitDefById('v-longship'))).toBe(false);
    const bh = spawnBuilding(w, 0, 'boathouse', fxFromInt(10), fxFromInt(10));
    expect(isUnitAvailable(w, 0, unitDefById('v-longship'))).toBe(true);
    expect(queueUnitProduction(w, 0, bh, 'v-longship', 1)).toBe(1);
  });
});

describe('研究の進行と完了', () => {
  it('researchSec ちょうどで完了し、効果がすぐ効く', () => {
    const w = makeWorld('yamato', 3);
    const smith = spawnBuilding(w, 0, 'blacksmith', fxFromInt(10), fxFromInt(10));
    const tdef = techDefOf('uchiba');
    expect(startResearch(w, 0, smith, 'uchiba')).toBe(true);
    const b = entityIndex(smith);
    expect(w.entities.researchTech[b]).toBe(tdef.index + 1);

    step(w, tdef.researchTicks - 1);
    expect(w.players[0]!.researched[tdef.index]).toBe(0);
    step(w, 1);
    expect(w.players[0]!.researched[tdef.index]).toBe(1);
    expect(w.entities.researchTech[b]).toBe(0);
    expect(w.entities.researchProgress[b]).toBe(0);
  });

  it('翰林院（唐）は研究時間が 0.8 倍', () => {
    const plain = makeWorld('yamato', 3);
    const tou = makeWorld('tou', 3);
    const a = ticksToResearch(plain, 'blacksmith', 'yajiri');
    // 翰林院で研究できる学舎の研究で比較する
    const b = ticksToResearch(tou, 'kanrin', 'sokuryo');
    const plainAcademy = ticksToResearch(makeWorld('yamato', 3), 'academy', 'sokuryo');
    expect(a).toBeGreaterThan(0);
    expect(b / plainAcademy).toBeCloseTo(0.8, 1);
  });

  it('同じ建物で 2 件同時には研究できない', () => {
    const w = makeWorld('yamato', 3);
    const smith = spawnBuilding(w, 0, 'blacksmith', fxFromInt(10), fxFromInt(10));
    expect(startResearch(w, 0, smith, 'uchiba')).toBe(true);
    expect(startResearch(w, 0, smith, 'yajiri')).toBe(false);
  });

  it('建設中の建物では生産も研究もできない', () => {
    const w = makeWorld('yamato', 2);
    const r = beginConstruction(w, 0, 'barracks', fxFromInt(10), fxFromInt(10));
    expect(r.result).toBe('ok');
    expect(queueUnitProduction(w, 0, r.id, 'y-musha', 1)).toBe(0);
    // 完成させれば積める
    w.entities.buildProgress[entityIndex(r.id)] = PROGRESS_DONE;
    markModifiersDirty(w, 0);
    expect(queueUnitProduction(w, 0, r.id, 'y-musha', 1)).toBe(1);
  });

  it('他人の建物は操作できない', () => {
    const w = createWorld({
      seed: 5,
      playerCount: 2,
      mapWidthTiles: 64,
      mapHeightTiles: 64,
      civs: ['yamato', 'roma'],
    });
    w.players[0]!.age = 2;
    w.players[1]!.age = 2;
    w.players[1]!.popCap = 200;
    for (let r = 0; r < RESOURCE_IDS.length; r++) w.players[1]!.resources[r] = fx(5000);
    const barracks = spawnBuilding(w, 0, 'barracks', fxFromInt(10), fxFromInt(10));
    expect(queueUnitProduction(w, 1, barracks, 'r-principes', 1)).toBe(0);
    expect(setRallyPoint(w, 1, barracks, fxFromInt(1), fxFromInt(1))).toBe(false);
  });
});

// ---------------------------------------------------------------- 補助

function unitFreeTechIndex(id: string): number {
  return techDefById(id).index;
}

function techDefOf(id: string): { index: number; researchTicks: number } {
  return techDefById(id);
}

/** 文明のエリートユニット ID。 */
function eliteOf(civ: string): string {
  return civEliteMap[civ]!;
}

const civEliteMap: Record<string, string> = {
  yamato: 'y-bushi',
  roma: 'r-legion',
  tou: 't-renkyu',
  viking: 'v-berserk',
  mali: 'm-guard-archer',
  azteca: 'a-jaguar',
  persia: 'p-guard-elephant',
  mongol: 'g-guard-horsearcher',
};

/** 1 体作るのにかかった tick 数。 */
function ticksToProduce(w: World, buildingId: string, unitId: string): number {
  const b = spawnBuilding(w, 0, buildingId, fxFromInt(10), fxFromInt(10));
  queueUnitProduction(w, 0, b, unitId, 1);
  let t = 0;
  while (unitIndices(w).length === 0 && t < 10000) {
    production(w);
    w.tick += 1;
    t++;
  }
  return t;
}

/** 研究が終わるまでの tick 数。 */
function ticksToResearch(w: World, buildingId: string, techId: string): number {
  const b = spawnBuilding(w, 0, buildingId, fxFromInt(10), fxFromInt(10));
  if (!startResearch(w, 0, b, techId)) return -1;
  const tech = techDefOf(techId);
  let t = 0;
  while (w.players[0]!.researched[tech.index] !== 1 && t < 20000) {
    production(w);
    w.tick += 1;
    t++;
  }
  return t;
}
