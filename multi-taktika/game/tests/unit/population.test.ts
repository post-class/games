/**
 * T-M4-08: 人口（家 +5 / 町の中心 +10 / 既定上限 200、攻城兵器 3・戦象 2）
 *
 * 完了条件「上限で生産が止まる」は `hasPopRoomFor` が false を返すことで検証する
 * （生産キュー本体は M6 の `production.ts` 担当）。
 */

import { describe, expect, it } from 'vitest';

import { EntityKind } from '@/shared/types';
import { PROGRESS_DONE, resolveIndex, spawnEntity } from '@/sim/core/entity';
import { fxFromInt } from '@/sim/core/fx';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { createWorld, type World } from '@/sim/core/world';
import {
  computePop,
  computePopCap,
  hasPopRoomFor,
  isPopCapped,
  popRoom,
  populationHardCap,
  providesPopCap,
  refreshPopulation,
  unitPopCost,
} from '@/sim/core/population';

function makeWorld(): World {
  return createWorld({ seed: 3, playerCount: 2, mapWidthTiles: 200, mapHeightTiles: 200 });
}

function putBuilding(w: World, id: string, owner: number, tx: number, ty: number): number {
  const def = buildingDefById(id);
  const eid = spawnEntity(w.entities, {
    kind: EntityKind.Building,
    owner,
    typeId: def.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: def.hp,
  });
  // **完成済み**として置く。建設中の建物は人口を提供しない（`07§9`）。
  w.entities.buildProgress[resolveIndex(w.entities, eid)] = PROGRESS_DONE;
  return eid;
}

/** 建設中の建物を置く（人口を提供しないことの確認用）。 */
function putUnderConstruction(
  w: World,
  id: string,
  owner: number,
  tx: number,
  ty: number,
): number {
  const def = buildingDefById(id);
  return spawnEntity(w.entities, {
    kind: EntityKind.Building,
    owner,
    typeId: def.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: def.hp,
  });
}

function putUnit(w: World, id: string, owner: number, tx: number, ty: number): number {
  const def = unitDefById(id);
  return spawnEntity(w.entities, {
    kind: EntityKind.Unit,
    owner,
    typeId: def.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: def.hp,
  });
}

describe('人口上限（T-M4-08）', () => {
  it('家 +5 / 町の中心 +10。それ以外の建物は増やさない', () => {
    const w = makeWorld();
    expect(computePopCap(w, 0)).toBe(0);
    putBuilding(w, 'town_center', 0, 20, 20);
    expect(computePopCap(w, 0)).toBe(10);
    putBuilding(w, 'house', 0, 22, 20);
    putBuilding(w, 'house', 0, 24, 20);
    expect(computePopCap(w, 0)).toBe(20);
    putBuilding(w, 'barracks', 0, 26, 20);
    putBuilding(w, 'farm', 0, 28, 20);
    expect(computePopCap(w, 0)).toBe(20);
    // 相手の建物は自分の上限を増やさない
    putBuilding(w, 'house', 1, 30, 20);
    expect(computePopCap(w, 0)).toBe(20);
    expect(computePopCap(w, 1)).toBe(5);
  });

  it('既定上限 200 で打ち止め（家を建てすぎても伸びない）', () => {
    const w = makeWorld();
    expect(populationHardCap()).toBe(200);
    putBuilding(w, 'town_center', 0, 20, 20);
    for (let k = 0; k < 60; k++) putBuilding(w, 'house', 0, 30 + k, 20); // +300
    expect(computePopCap(w, 0)).toBe(200);
  });

  it('providesPopCap は popProvide > 0 の生存建物だけ true', () => {
    const w = makeWorld();
    const tc = putBuilding(w, 'town_center', 0, 20, 20);
    const barracks = putBuilding(w, 'barracks', 0, 24, 20);
    const villager = putUnit(w, 'villager', 0, 21, 20);
    expect(providesPopCap(w.entities, tc & 0xffff)).toBe(true);
    expect(providesPopCap(w.entities, barracks & 0xffff)).toBe(false);
    expect(providesPopCap(w.entities, villager & 0xffff)).toBe(false);
  });

  it('建設中の家は人口を提供しない（07§9。建設時間を意味のあるものにするため）', () => {
    const w = makeWorld();
    putBuilding(w, 'town_center', 0, 20, 20);
    const building = putUnderConstruction(w, 'house', 0, 22, 20);
    expect(providesPopCap(w.entities, resolveIndex(w.entities, building))).toBe(false);
    // 町の中心の +10 だけが数えられる（家の +5 は完成まで入らない）
    expect(computePopCap(w, 0)).toBe(10);

    // 完成させると増える
    w.entities.buildProgress[resolveIndex(w.entities, building)] = PROGRESS_DONE;
    expect(computePopCap(w, 0)).toBe(15);
  });
});

describe('人口の消費（T-M4-08）', () => {
  it('村人 1 / 攻城兵器 3 / 戦象 2', () => {
    expect(unitPopCost(unitDefById('villager').index)).toBe(1);
    expect(unitPopCost(unitDefById('a-catapult').index)).toBe(3);
    expect(unitPopCost(unitDefById('p-elephant').index)).toBe(2);
  });

  it('現在人口は所有ユニットの pop 合計', () => {
    const w = makeWorld();
    putUnit(w, 'villager', 0, 20, 20);
    putUnit(w, 'villager', 0, 21, 20);
    putUnit(w, 'a-catapult', 0, 22, 20); // 3
    putUnit(w, 'p-elephant', 0, 23, 20); // 2
    putUnit(w, 'villager', 1, 24, 20); // 相手の村人は数えない
    expect(computePop(w, 0)).toBe(7);
    expect(computePop(w, 1)).toBe(1);
  });

  it('refreshPopulation が PlayerState を更新する', () => {
    const w = makeWorld();
    putBuilding(w, 'town_center', 0, 20, 20);
    putUnit(w, 'villager', 0, 21, 20);
    refreshPopulation(w);
    expect(w.players[0]!.pop).toBe(1);
    expect(w.players[0]!.popCap).toBe(10);
    expect(popRoom(w.players[0]!)).toBe(9);
    expect(isPopCapped(w.players[0]!)).toBe(false);
  });
});

describe('上限で生産が止まる（T-M4-08 の完了条件）', () => {
  it('枠が埋まると村人も作れなくなる', () => {
    const w = makeWorld();
    putBuilding(w, 'town_center', 0, 20, 20); // 上限 10
    const villagerType = unitDefById('villager').index;
    for (let k = 0; k < 9; k++) putUnit(w, 'villager', 0, 21 + k, 20);
    refreshPopulation(w);
    expect(hasPopRoomFor(w, 0, villagerType)).toBe(true); // 9/10
    putUnit(w, 'villager', 0, 40, 20);
    refreshPopulation(w);
    expect(w.players[0]!.pop).toBe(10);
    expect(isPopCapped(w.players[0]!)).toBe(true);
    expect(hasPopRoomFor(w, 0, villagerType)).toBe(false);
  });

  it('攻城兵器（pop 3）は残り枠が 3 未満だと作れない（村人はまだ作れる）', () => {
    const w = makeWorld();
    putBuilding(w, 'town_center', 0, 20, 20); // 上限 10
    for (let k = 0; k < 8; k++) putUnit(w, 'villager', 0, 21 + k, 20);
    refreshPopulation(w);
    expect(popRoom(w.players[0]!)).toBe(2);
    expect(hasPopRoomFor(w, 0, unitDefById('villager').index)).toBe(true);
    expect(hasPopRoomFor(w, 0, unitDefById('p-elephant').index)).toBe(true); // pop 2
    expect(hasPopRoomFor(w, 0, unitDefById('a-catapult').index)).toBe(false); // pop 3
  });

  it('家を建てれば再び作れる', () => {
    const w = makeWorld();
    putBuilding(w, 'town_center', 0, 20, 20);
    for (let k = 0; k < 10; k++) putUnit(w, 'villager', 0, 21 + k, 20);
    refreshPopulation(w);
    expect(hasPopRoomFor(w, 0, unitDefById('villager').index)).toBe(false);
    putBuilding(w, 'house', 0, 40, 20);
    refreshPopulation(w);
    expect(w.players[0]!.popCap).toBe(15);
    expect(hasPopRoomFor(w, 0, unitDefById('villager').index)).toBe(true);
  });
});
