/**
 * T-M6-03: 時代進化（`03§2`, 手順書 §6, §14.2）
 *
 * 検証（完了条件）:
 *  - 4 時代の遷移コストが `03§2` と一致する（食 500 / 食 800+金 200 / 食 1000+金 800）
 *  - 条件は「資源 + **前の世の建物 2 種**」
 *  - 解読中も内政（生産）と戦闘は止まらない
 *  - **戦域スロットが 1 → 2 → 3 → 4 に増える**
 *  - 城の +1 と研究「旗竿」の +1 を足して **合計上限 6 で打ち止め**
 */

import { describe, expect, it } from 'vitest';
import type { CivId } from '@/shared/types';
import { EntityKind, RESOURCE_IDS, resourceIndex } from '@/shared/types';
import { fx, fxFromInt } from '@/sim/core/fx';
import { createWorld, MAX_FRONTS, type World } from '@/sim/core/world';
import { techIndex } from '@/sim/core/defs';
import { RESEARCH_AGE_ADVANCE, entityIndex } from '@/sim/core/entity';
import { markModifiersDirty } from '@/sim/core/effects';
import { cfgAges, cfgInt } from '@/sim/core/config';
import { spawnBuilding } from '@/sim/systems/construction';
import {
  ageAdvanceCostFx,
  canAdvanceAge,
  countCurrentAgeBuildingKinds,
  production,
  queueUnitProduction,
  recomputeFrontSlots,
  startAgeAdvance,
} from '@/sim/systems/production';

function makeWorld(civ: CivId = 'yamato'): World {
  const w = createWorld({
    seed: 21,
    playerCount: 1,
    mapWidthTiles: 64,
    mapHeightTiles: 64,
    civs: [civ],
  });
  const pl = w.players[0]!;
  pl.popCap = 200;
  for (let r = 0; r < RESOURCE_IDS.length; r++) pl.resources[r] = fx(20000);
  return w;
}

function step(w: World, ticks: number): void {
  for (let t = 0; t < ticks; t++) {
    production(w);
    w.tick += 1;
  }
}

const FOOD = resourceIndex('food');
const GOLD = resourceIndex('gold');

describe('遷移コストが 03§2 と一致する', () => {
  it('青銅 = 食 500', () => {
    const c = ageAdvanceCostFx(1);
    expect(c[FOOD]).toBe(fx(500));
    expect(c[GOLD]).toBe(0);
  });

  it('鉄器 = 食 800 + 金 200', () => {
    const c = ageAdvanceCostFx(2);
    expect(c[FOOD]).toBe(fx(800));
    expect(c[GOLD]).toBe(fx(200));
  });

  it('帝国 = 食 1000 + 金 800', () => {
    const c = ageAdvanceCostFx(3);
    expect(c[FOOD]).toBe(fx(1000));
    expect(c[GOLD]).toBe(fx(800));
  });

  it('黎明（開始時代）にはコストが無い', () => {
    const c = ageAdvanceCostFx(0);
    for (let r = 0; r < RESOURCE_IDS.length; r++) expect(c[r]).toBe(0);
  });

  it('解読時間は 130 / 160 / 190 秒', () => {
    const ages = cfgAges();
    expect(ages[1]!.researchTicks).toBe(130 * 25);
    expect(ages[2]!.researchTicks).toBe(160 * 25);
    expect(ages[3]!.researchTicks).toBe(190 * 25);
  });
});

describe('着手の条件（資源 + 前の世の建物 2 種）', () => {
  it('建物が 1 種だけでは着手できない', () => {
    const w = makeWorld();
    const tc = spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    expect(countCurrentAgeBuildingKinds(w, 0)).toBe(1);
    expect(canAdvanceAge(w, 0, entityIndex(tc))).toBe(false);
    expect(startAgeAdvance(w, 0, tc)).toBe(false);
  });

  it('2 種そろえば着手できる（同じ種類を 2 棟建てても駄目）', () => {
    const w = makeWorld();
    const tc = spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    spawnBuilding(w, 0, 'town_center', fxFromInt(40), fxFromInt(20));
    expect(countCurrentAgeBuildingKinds(w, 0)).toBe(1);
    expect(canAdvanceAge(w, 0, entityIndex(tc))).toBe(false);

    spawnBuilding(w, 0, 'house', fxFromInt(24), fxFromInt(20));
    expect(countCurrentAgeBuildingKinds(w, 0)).toBe(2);
    expect(cfgAges()[1]!.requireBuildingsOfPrevAge).toBe(2);
    expect(canAdvanceAge(w, 0, entityIndex(tc))).toBe(true);
  });

  it('町の中心以外では解読できない（canAdvanceAge のデータ由来）', () => {
    const w = makeWorld();
    spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    const house = spawnBuilding(w, 0, 'house', fxFromInt(24), fxFromInt(20));
    expect(canAdvanceAge(w, 0, entityIndex(house))).toBe(false);
  });

  it('資源が足りないと着手できない。着手時に即引き落とす', () => {
    const w = makeWorld();
    const tc = spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    spawnBuilding(w, 0, 'house', fxFromInt(24), fxFromInt(20));
    w.players[0]!.resources[FOOD] = fx(100);
    expect(canAdvanceAge(w, 0, entityIndex(tc))).toBe(false);

    w.players[0]!.resources[FOOD] = fx(500);
    expect(startAgeAdvance(w, 0, tc)).toBe(true);
    expect(w.players[0]!.resources[FOOD]).toBe(0);
    expect(w.entities.researchTech[entityIndex(tc)]).toBe(RESEARCH_AGE_ADVANCE);
  });

  it('帝国の世からはもう進化できない', () => {
    const w = makeWorld();
    w.players[0]!.age = 3;
    const tc = spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    spawnBuilding(w, 0, 'academy', fxFromInt(30), fxFromInt(20));
    spawnBuilding(w, 0, 'stable', fxFromInt(34), fxFromInt(20));
    expect(canAdvanceAge(w, 0, entityIndex(tc))).toBe(false);
  });
});

describe('戦域スロットが 1 → 2 → 3 → 4 に増える', () => {
  it('4 時代を通して進化させるとスロットが 1 ずつ増える', () => {
    const w = makeWorld();
    const tc = spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    spawnBuilding(w, 0, 'house', fxFromInt(24), fxFromInt(20));
    recomputeFrontSlots(w, 0);
    expect(w.players[0]!.age).toBe(0);
    expect(w.players[0]!.frontSlots).toBe(1);

    // → 青銅の世
    expect(startAgeAdvance(w, 0, tc)).toBe(true);
    step(w, cfgAges()[1]!.researchTicks - 1);
    expect(w.players[0]!.age).toBe(0);
    step(w, 1);
    expect(w.players[0]!.age).toBe(1);
    expect(w.players[0]!.frontSlots).toBe(2);
    expect(w.entities.researchTech[entityIndex(tc)]).toBe(0);

    // → 鉄器の世（青銅の建物 2 種）
    spawnBuilding(w, 0, 'barracks', fxFromInt(28), fxFromInt(20));
    spawnBuilding(w, 0, 'market', fxFromInt(32), fxFromInt(20));
    expect(startAgeAdvance(w, 0, tc)).toBe(true);
    step(w, cfgAges()[2]!.researchTicks);
    expect(w.players[0]!.age).toBe(2);
    expect(w.players[0]!.frontSlots).toBe(3);

    // → 帝国の世（鉄器の建物 2 種）
    spawnBuilding(w, 0, 'academy', fxFromInt(36), fxFromInt(20));
    spawnBuilding(w, 0, 'stable', fxFromInt(40), fxFromInt(20));
    expect(startAgeAdvance(w, 0, tc)).toBe(true);
    step(w, cfgAges()[3]!.researchTicks);
    expect(w.players[0]!.age).toBe(3);
    expect(w.players[0]!.frontSlots).toBe(4);
  });

  it('城 +1 と旗竿 +1 を足して合計 6 で打ち止め', () => {
    const w = makeWorld();
    const pl = w.players[0]!;
    pl.age = 3;
    spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    recomputeFrontSlots(w, 0);
    expect(pl.frontSlots).toBe(4);

    spawnBuilding(w, 0, 'castle', fxFromInt(30), fxFromInt(30));
    expect(pl.frontSlots).toBe(5);

    pl.researched[techIndex('hatazao')] = 1;
    markModifiersDirty(w, 0);
    recomputeFrontSlots(w, 0);
    expect(pl.frontSlots).toBe(6);

    // 城を増やしても 6 で止まる
    spawnBuilding(w, 0, 'castle', fxFromInt(40), fxFromInt(30));
    spawnBuilding(w, 0, 'castle', fxFromInt(50), fxFromInt(30));
    expect(pl.frontSlots).toBe(6);
    expect(pl.frontSlots).toBe(cfgInt('slotBonus.hardMax'));
    expect(pl.frontSlots).toBeLessThanOrEqual(MAX_FRONTS);
  });

  it('帝国 4 + 城 2 で 6（`14.2` の検算）', () => {
    const w = makeWorld();
    w.players[0]!.age = 3;
    spawnBuilding(w, 0, 'castle', fxFromInt(30), fxFromInt(30));
    spawnBuilding(w, 0, 'castle', fxFromInt(40), fxFromInt(30));
    expect(w.players[0]!.frontSlots).toBe(6);
  });

  it('モンゴルの大天幕も +1（城の置き換え）', () => {
    const w = makeWorld('mongol');
    w.players[0]!.age = 3;
    spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    recomputeFrontSlots(w, 0);
    expect(w.players[0]!.frontSlots).toBe(4);
    spawnBuilding(w, 0, 'great_tent', fxFromInt(30), fxFromInt(30));
    expect(w.players[0]!.frontSlots).toBe(5);
  });
});

describe('解読中も内政は止まらない', () => {
  it('時代進化の解読中に町の中心が村人を出し続ける', () => {
    const w = makeWorld();
    const tc = spawnBuilding(w, 0, 'town_center', fxFromInt(20), fxFromInt(20));
    spawnBuilding(w, 0, 'house', fxFromInt(24), fxFromInt(20));
    expect(startAgeAdvance(w, 0, tc)).toBe(true);
    expect(queueUnitProduction(w, 0, tc, 'villager', 3)).toBe(3);

    const b = entityIndex(tc);
    step(w, 700); // 村人 20 秒 = 500 tick なので 1 体は出ている
    expect(w.entities.researchTech[b]).toBe(RESEARCH_AGE_ADVANCE);
    expect(w.entities.researchProgress[b]!).toBeGreaterThan(0);
    expect(countUnits(w)).toBeGreaterThanOrEqual(1);
    expect(w.players[0]!.age).toBe(0);

    // 解読が終わるまで進めても生産は続いている
    step(w, cfgAges()[1]!.researchTicks);
    expect(w.players[0]!.age).toBe(1);
    expect(countUnits(w)).toBe(3);
  });
});

function countUnits(w: World): number {
  const e = w.entities;
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] === 1 && e.kind[i] === EntityKind.Unit) n++;
  }
  return n;
}
