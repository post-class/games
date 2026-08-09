/**
 * Command → 各システムの結線（実装手順書 §6.11 / §4.6-1）
 *
 * `tests/unit/command.test.ts` が「型とシリアライズ」を見るのに対し、こちらは
 * **15 種すべてが正しい入力で意図した状態変化を起こし、不正な入力では
 * 何も起こらず例外も出ない**ことを見る。
 *
 * 不正入力の方針（`applyCommands` の規約）: 例外を投げずに黙って無視する。
 * 通信相手の遅れた入力 1 件で試合が止まってはいけないため、
 * 「無視された」ことは**状態が変わっていない**ことで検証する。
 */

import { describe, expect, it } from 'vitest';
import type { CivId, EntityId } from '@/shared/types';
import { EntityKind, INVALID_ENTITY, RESOURCE_IDS, resourceIndex } from '@/shared/types';
import { applyCommands, type Command } from '@/sim/command';
import { TICK_RATE, cfgNum } from '@/sim/core/config';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { RESEARCH_AGE_ADVANCE, UnitState, entityIndex, markDead, spawnEntity } from '@/sim/core/entity';
import { fx, fxFromInt, fxToNumber, FX_ONE } from '@/sim/core/fx';
import { PROGRESS_DONE } from '@/sim/core/effects';
import { spawnResourceNode, resourceNodeIndex } from '@/sim/core/gather';
import { marketUnitPriceGoldFx } from '@/sim/core/market';
import { createWorld, type World } from '@/sim/core/world';
import { spawnBuilding } from '@/sim/systems/construction';
import { ageAdvanceCostFx, techCostFx, unitCostFx } from '@/sim/systems/production';
import { techDefById } from '@/sim/core/defs';

// ---------------------------------------------------------------- 土台

/**
 * 地形を持たない小さな World（`hasTerrain` が false なので movement は直進する）。
 * ここでは「コマンドが状態をどう変えるか」だけを見るので、地形は要らない。
 */
function makeWorld(opts?: {
  playerCount?: number;
  civs?: readonly CivId[];
  teams?: readonly number[];
  age?: number;
  resources?: number;
}): World {
  const playerCount = opts?.playerCount ?? 2;
  const w = createWorld({
    seed: 7,
    playerCount,
    mapWidthTiles: 64,
    mapHeightTiles: 64,
    ...(opts?.civs === undefined ? {} : { civs: opts.civs }),
    ...(opts?.teams === undefined ? {} : { teams: opts.teams }),
    entityCapacity: 512,
  });
  for (let p = 0; p < playerCount; p++) {
    const pl = w.players[p]!;
    pl.age = opts?.age ?? 0;
    pl.popCap = cfgNum('population.defaultCap');
    for (let r = 0; r < RESOURCE_IDS.length; r++) pl.resources[r] = fx(opts?.resources ?? 5000);
  }
  return w;
}

/** 完成済みの町の中心を置く。 */
function townCenter(w: World, p: number, tx = 20, ty = 20): EntityId {
  return spawnBuilding(w, p, 'town_center', fxFromInt(tx), fxFromInt(ty));
}

function spawnVillager(w: World, p: number, tx: number, ty: number): EntityId {
  const def = unitDefById('villager');
  return spawnEntity(w.entities, {
    kind: EntityKind.Unit,
    owner: p,
    typeId: def.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: def.hp,
  });
}

/** 生存している建物・ユニットの総数（「何も起こらなかった」の確認に使う）。 */
function aliveCount(w: World): number {
  return w.entities.count;
}

// ---------------------------------------------------------------- setOrder

describe('setOrder — 令の入力（遅延の本計算は M9）', () => {
  function withFront(): World {
    const w = makeWorld();
    const f = w.fronts[0]!;
    f.active = true;
    f.x = fxFromInt(30);
    f.y = fxFromInt(30);
    w.players[0]!.frontSlots = 1;
    return w;
  }

  it('pendingOrder に格納される（即時発効しない）', () => {
    const w = withFront();
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' }]);
    const f = w.fronts[0]!;
    expect(f.pendingOrder).not.toBeNull();
    expect(f.pendingOrder!.id).toBe('charge');
    expect(f.pendingOrder!.tier).toBe('upper');
    // 「押した瞬間に効かない」のが設計の肝（§16-4）。
    expect(f.order).toBeNull();
    expect(f.pendingOrder!.deliverAtTick).toBeGreaterThan(w.tick);
  });

  it('配達中に重ねた入力は無視する（連打対策。`06§4`）', () => {
    const w = withFront();
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' }]);
    const first = w.fronts[0]!.pendingOrder!;
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'hold', tier: 'upper' }]);
    expect(w.fronts[0]!.pendingOrder).toBe(first);
  });

  it('切り替え間隔（6 秒）の内側は無視する', () => {
    const w = withFront();
    w.tick = 10;
    // 既に令が立っている戦域の「切り替え」だけが間隔の対象（初手は待たされない）。
    w.fronts[0]!.order = 'hold';
    w.fronts[0]!.lastSwitchTick = 10;
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' }]);
    expect(w.fronts[0]!.pendingOrder).toBeNull();

    // 間隔を過ぎれば通る。
    w.tick = 10 + Math.round(cfgNum('order.switchIntervalSec') * TICK_RATE);
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' }]);
    expect(w.fronts[0]!.pendingOrder).not.toBeNull();
  });

  it('未使用スロット・他人の戦域・スロット上限超えは無視する', () => {
    const w = withFront();
    // slot 2 は未使用
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 2, order: 'charge', tier: 'upper' }]);
    expect(w.fronts[1]!.pendingOrder).toBeNull();
    // 他人の戦域
    applyCommands(w, [{ t: 'setOrder', p: 1, front: 1, order: 'charge', tier: 'upper' }]);
    expect(w.fronts[0]!.pendingOrder).toBeNull();
    // 使用可能スロット数を超えたスロット
    w.fronts[1]!.active = true;
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 2, order: 'charge', tier: 'upper' }]);
    expect(w.fronts[1]!.pendingOrder).toBeNull();
  });

  it('下段は二重旗を取るまで無視する / 段の食い違いも無視する', () => {
    const w = withFront();
    // siege は下段の令（`orders.json`）。二重旗（研究）が無いので通らない。
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'siege', tier: 'lower' }]);
    expect(w.fronts[0]!.pendingOrder).toBeNull();
    // 段の指定が令の定義と違う
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'lower' }]);
    expect(w.fronts[0]!.pendingOrder).toBeNull();
  });

  it('未知の令 ID / 他文明の固有令は無視する', () => {
    const w = withFront();
    applyCommands(w, [
      { t: 'setOrder', p: 0, front: 1, order: 'no-such-order' as 'charge', tier: 'upper' },
      // jindate はヤマトの固有令。既定の civs は playerId 0 = yamato なので
      // playerId 1（roma）の戦域に対して試す。
    ]);
    expect(w.fronts[0]!.pendingOrder).toBeNull();

    const w2 = makeWorld({ civs: ['roma', 'yamato'] });
    const f = w2.fronts[0]!;
    f.active = true;
    applyCommands(w2, [{ t: 'setOrder', p: 0, front: 1, order: 'jindate', tier: 'upper' }]);
    expect(w2.fronts[0]!.pendingOrder).toBeNull();
  });
});

// ---------------------------------------------------------------- produce / cancelQueue

describe('produce / cancelQueue — 生産キュー', () => {
  it('資源を払ってキューに積む', () => {
    const w = makeWorld();
    const tc = townCenter(w, 0);
    const before = w.players[0]!.resources[resourceIndex('food')]!;
    const cost = unitCostFx(w, 0, unitDefById('villager'))[resourceIndex('food')]!;
    applyCommands(w, [{ t: 'produce', p: 0, building: tc, unit: 'villager', count: 2 }]);
    const idx = entityIndex(tc);
    expect(w.entities.queueCount[idx]).toBe(2);
    expect(w.players[0]!.resources[resourceIndex('food')]).toBe(before - cost * 2);
  });

  it('資源不足では 1 件も積まれない', () => {
    const w = makeWorld({ resources: 0 });
    const tc = townCenter(w, 0);
    applyCommands(w, [{ t: 'produce', p: 0, building: tc, unit: 'villager', count: 1 }]);
    expect(w.entities.queueCount[entityIndex(tc)]).toBe(0);
  });

  it('人口上限に達していたら積ませない（`07§8` 生産ボタンが止まる）', () => {
    const w = makeWorld();
    const tc = townCenter(w, 0);
    w.players[0]!.popCap = 0;
    w.players[0]!.pop = 0;
    const before = w.players[0]!.resources[resourceIndex('food')]!;
    applyCommands(w, [{ t: 'produce', p: 0, building: tc, unit: 'villager', count: 1 }]);
    expect(w.entities.queueCount[entityIndex(tc)]).toBe(0);
    // 資源も引かれない（先取りされない）
    expect(w.players[0]!.resources[resourceIndex('food')]).toBe(before);
  });

  it('他人の建物・死んだ建物・未知のユニット ID・生産元でない建物は無視する', () => {
    const w = makeWorld();
    const tc = townCenter(w, 0);
    const enemyTc = townCenter(w, 1, 40, 40);
    applyCommands(w, [
      { t: 'produce', p: 0, building: enemyTc, unit: 'villager', count: 1 },
      { t: 'produce', p: 0, building: tc, unit: 'no-such-unit', count: 1 },
      // 足軽は兵舎でしか作れない（town_center は生産元ではない）
      { t: 'produce', p: 0, building: tc, unit: 'y-ashigaru', count: 1 },
      { t: 'produce', p: 0, building: tc, unit: 'villager', count: 0 },
    ]);
    expect(w.entities.queueCount[entityIndex(tc)]).toBe(0);
    expect(w.entities.queueCount[entityIndex(enemyTc)]).toBe(0);

    const dead = townCenter(w, 0, 10, 10);
    markDead(w.entities, dead);
    expect(() =>
      applyCommands(w, [{ t: 'produce', p: 0, building: dead, unit: 'villager', count: 1 }])
    ).not.toThrow();
  });

  it('建設中の建物では生産できない', () => {
    const w = makeWorld();
    const tc = townCenter(w, 0);
    w.entities.buildProgress[entityIndex(tc)] = 0; // 建設中に戻す
    applyCommands(w, [{ t: 'produce', p: 0, building: tc, unit: 'villager', count: 1 }]);
    expect(w.entities.queueCount[entityIndex(tc)]).toBe(0);
  });

  it('cancelQueue は全額返して詰める。範囲外の index は無視する', () => {
    const w = makeWorld();
    const tc = townCenter(w, 0);
    const idx = entityIndex(tc);
    const before = w.players[0]!.resources[resourceIndex('food')]!;
    applyCommands(w, [{ t: 'produce', p: 0, building: tc, unit: 'villager', count: 2 }]);
    applyCommands(w, [
      { t: 'cancelQueue', p: 0, building: tc, index: 5 }, // 範囲外
      { t: 'cancelQueue', p: 1, building: tc, index: 0 }, // 他人
    ]);
    expect(w.entities.queueCount[idx]).toBe(2);
    applyCommands(w, [
      { t: 'cancelQueue', p: 0, building: tc, index: 0 },
      { t: 'cancelQueue', p: 0, building: tc, index: 0 },
    ]);
    expect(w.entities.queueCount[idx]).toBe(0);
    expect(w.players[0]!.resources[resourceIndex('food')]).toBe(before);
  });
});

// ---------------------------------------------------------------- placeBuilding / placeWallLine

describe('placeBuilding / placeWallLine — 建設', () => {
  it('建設中の建物が立ち、指定した村人が建設に就く', () => {
    const w = makeWorld();
    townCenter(w, 0);
    const v = spawnVillager(w, 0, 25, 25);
    const before = aliveCount(w);
    applyCommands(w, [
      { t: 'placeBuilding', p: 0, type: 'house', x: fxFromInt(30), y: fxFromInt(30), villagers: [v] },
    ]);
    expect(aliveCount(w)).toBe(before + 1);
    const vi = entityIndex(v);
    expect(w.entities.state[vi]).toBe(UnitState.Building);
    // 建設中（PROGRESS_DONE でない）
    let found = -1;
    const e = w.entities;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] === 1 && e.kind[i] === EntityKind.Building && e.typeId[i] === buildingDefById('house').index) found = i;
    }
    expect(found).toBeGreaterThanOrEqual(0);
    expect(e.buildProgress[found]).toBeLessThan(PROGRESS_DONE);
  });

  it('その文明が建てられない建物は何も起こらない（ヴァイキングの厩）', () => {
    const w = makeWorld({ civs: ['viking', 'roma'], age: 1 });
    townCenter(w, 0);
    const before = aliveCount(w);
    const food = w.players[0]!.resources[resourceIndex('wood')]!;
    applyCommands(w, [
      { t: 'placeBuilding', p: 0, type: 'stable', x: fxFromInt(30), y: fxFromInt(30), villagers: [] },
    ]);
    expect(aliveCount(w)).toBe(before);
    expect(w.players[0]!.resources[resourceIndex('wood')]).toBe(food);
  });

  it('未知の建物 ID・マップ外・時代未解禁・資源不足は無視する', () => {
    const w = makeWorld();
    townCenter(w, 0);
    const before = aliveCount(w);
    applyCommands(w, [
      { t: 'placeBuilding', p: 0, type: 'no-such-building', x: fxFromInt(30), y: fxFromInt(30), villagers: [] },
      { t: 'placeBuilding', p: 0, type: 'house', x: fxFromInt(-5), y: fxFromInt(30), villagers: [] },
      { t: 'placeBuilding', p: 0, type: 'house', x: fxFromInt(1000), y: fxFromInt(30), villagers: [] },
      // castle は鉄器の世（age 2）。黎明では建てられない。
      { t: 'placeBuilding', p: 0, type: 'castle', x: fxFromInt(30), y: fxFromInt(30), villagers: [] },
    ]);
    expect(aliveCount(w)).toBe(before);

    const poor = makeWorld({ resources: 0 });
    applyCommands(poor, [
      { t: 'placeBuilding', p: 0, type: 'house', x: fxFromInt(30), y: fxFromInt(30), villagers: [] },
    ]);
    expect(aliveCount(poor)).toBe(0);
  });

  it('他人の村人・死んだ村人・兵は建設に就かない（黙って落とす）', () => {
    const w = makeWorld();
    const mine = spawnVillager(w, 0, 25, 25);
    const theirs = spawnVillager(w, 1, 26, 25);
    applyCommands(w, [
      {
        t: 'placeBuilding',
        p: 0,
        type: 'house',
        x: fxFromInt(30),
        y: fxFromInt(30),
        villagers: [theirs, INVALID_ENTITY, mine],
      },
    ]);
    expect(w.entities.state[entityIndex(mine)]).toBe(UnitState.Building);
    expect(w.entities.state[entityIndex(theirs)]).toBe(UnitState.Idle);
  });

  it('placeWallLine が線上のマスぶん壁を並べる（Bresenham）', () => {
    const w = makeWorld({ age: 1 });
    const before = aliveCount(w);
    applyCommands(w, [
      {
        t: 'placeWallLine',
        p: 0,
        type: 'palisade',
        x0: fxFromInt(10),
        y0: fxFromInt(10),
        x1: fxFromInt(14),
        y1: fxFromInt(10),
      },
    ]);
    // (10,10)..(14,10) の 5 マス
    expect(aliveCount(w)).toBe(before + 5);
  });

  it('placeWallLine の斜線もマス単位で連続する', () => {
    const w = makeWorld({ age: 1 });
    applyCommands(w, [
      {
        t: 'placeWallLine',
        p: 0,
        type: 'palisade',
        x0: fxFromInt(10),
        y0: fxFromInt(10),
        x1: fxFromInt(13),
        y1: fxFromInt(13),
      },
    ]);
    expect(aliveCount(w)).toBe(4);
  });

  it('壁でない建物・マップ外の端点・資源不足は無視する（尽きたところで打ち切る）', () => {
    const w = makeWorld({ age: 1 });
    applyCommands(w, [
      {
        t: 'placeWallLine',
        p: 0,
        type: 'house',
        x0: fxFromInt(10),
        y0: fxFromInt(10),
        x1: fxFromInt(12),
        y1: fxFromInt(10),
      },
      {
        t: 'placeWallLine',
        p: 0,
        type: 'palisade',
        x0: fxFromInt(-1),
        y0: fxFromInt(10),
        x1: fxFromInt(12),
        y1: fxFromInt(10),
      },
    ]);
    expect(aliveCount(w)).toBe(0);

    // 木材 5 しかない → 柵（1 マス 2 木材）は 2 マスで打ち止め
    const poor = makeWorld({ age: 1, resources: 0 });
    poor.players[0]!.resources[resourceIndex('wood')] = fx(5);
    applyCommands(poor, [
      {
        t: 'placeWallLine',
        p: 0,
        type: 'palisade',
        x0: fxFromInt(10),
        y0: fxFromInt(10),
        x1: fxFromInt(20),
        y1: fxFromInt(10),
      },
    ]);
    expect(aliveCount(poor)).toBe(2);
  });
});

// ---------------------------------------------------------------- 手動操作

describe('moveUnits / attackTarget / gather / releaseManual — 手動操作と manual フラグ', () => {
  it('moveUnits は destX/destY を置き manual を立てる', () => {
    const w = makeWorld();
    const v = spawnVillager(w, 0, 10, 10);
    applyCommands(w, [
      { t: 'moveUnits', p: 0, units: [v], x: fxFromInt(20), y: fxFromInt(30), queued: false },
    ]);
    const i = entityIndex(v);
    expect(w.entities.destX[i]).toBe(fxFromInt(20));
    expect(w.entities.destY[i]).toBe(fxFromInt(30));
    expect(w.entities.state[i]).toBe(UnitState.Moving);
    expect(w.entities.manual[i]).toBe(1);
  });

  it('他人のユニット・死んだユニット・マップ外は無視する', () => {
    const w = makeWorld();
    const mine = spawnVillager(w, 0, 10, 10);
    const theirs = spawnVillager(w, 1, 11, 10);
    const dead = spawnVillager(w, 0, 12, 10);
    markDead(w.entities, dead);
    expect(() =>
      applyCommands(w, [
        { t: 'moveUnits', p: 0, units: [theirs, dead, 0x7fff0001], x: fxFromInt(20), y: fxFromInt(20), queued: false },
        { t: 'moveUnits', p: 0, units: [mine], x: fxFromInt(9999), y: fxFromInt(20), queued: false },
      ])
    ).not.toThrow();
    expect(w.entities.manual[entityIndex(theirs)]).toBe(0);
    expect(w.entities.manual[entityIndex(mine)]).toBe(0);
    expect(w.entities.destX[entityIndex(mine)]).toBe(0);
  });

  it('attackTarget は敵を目標にして manual を立てる。味方・死体は無視する', () => {
    const w = makeWorld();
    const mine = spawnVillager(w, 0, 10, 10);
    const enemy = spawnVillager(w, 1, 12, 10);
    const ally = spawnVillager(w, 0, 11, 10);
    applyCommands(w, [{ t: 'attackTarget', p: 0, units: [mine], target: ally }]);
    expect(w.entities.manual[entityIndex(mine)]).toBe(0);

    applyCommands(w, [{ t: 'attackTarget', p: 0, units: [mine], target: enemy }]);
    const i = entityIndex(mine);
    expect(w.entities.target[i]).toBe(enemy);
    expect(w.entities.state[i]).toBe(UnitState.Attacking);
    expect(w.entities.manual[i]).toBe(1);

    markDead(w.entities, enemy);
    const before = w.entities.target[i]!;
    applyCommands(w, [{ t: 'attackTarget', p: 0, units: [mine], target: enemy }]);
    expect(w.entities.target[i]).toBe(before);
  });

  it('gather は資源ノードを目標にして採集状態にする', () => {
    const w = makeWorld();
    townCenter(w, 0);
    const v = spawnVillager(w, 0, 21, 20);
    const node = spawnResourceNode(w, resourceNodeIndex('forest'), fxFromInt(24), fxFromInt(20));
    applyCommands(w, [{ t: 'gather', p: 0, units: [v], target: node }]);
    const i = entityIndex(v);
    expect(w.entities.state[i]).toBe(UnitState.Gathering);
    expect(w.entities.target[i]).toBe(node);
    expect(w.entities.manual[i]).toBe(1);
  });

  it('資源でない目標・村人でないユニットへの採集指示は無視する', () => {
    const w = makeWorld();
    const tc = townCenter(w, 0);
    const v = spawnVillager(w, 0, 21, 20);
    applyCommands(w, [{ t: 'gather', p: 0, units: [v], target: tc }]);
    expect(w.entities.state[entityIndex(v)]).toBe(UnitState.Idle);

    const node = spawnResourceNode(w, resourceNodeIndex('forest'), fxFromInt(24), fxFromInt(20));
    const soldier = spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner: 0,
      typeId: unitDefById('y-ashigaru').index,
      x: fxFromInt(22),
      y: fxFromInt(20),
      hpMax: unitDefById('y-ashigaru').hp,
    });
    applyCommands(w, [{ t: 'gather', p: 0, units: [soldier], target: node }]);
    expect(w.entities.state[entityIndex(soldier)]).toBe(UnitState.Idle);
  });

  it('releaseManual（Esc）で令の管理下に戻る', () => {
    const w = makeWorld();
    const v = spawnVillager(w, 0, 10, 10);
    const theirs = spawnVillager(w, 1, 11, 10);
    w.entities.manual[entityIndex(theirs)] = 1;
    applyCommands(w, [
      { t: 'moveUnits', p: 0, units: [v], x: fxFromInt(20), y: fxFromInt(20), queued: false },
    ]);
    applyCommands(w, [{ t: 'releaseManual', p: 0, units: [v, theirs] }]);
    expect(w.entities.manual[entityIndex(v)]).toBe(0);
    // 他人のユニットの手動フラグは触らない
    expect(w.entities.manual[entityIndex(theirs)]).toBe(1);
  });
});

// ---------------------------------------------------------------- research / advanceAge

describe('research / advanceAge — 研究と時代進化', () => {
  it('研究に着手し、資源を引く', () => {
    const w = makeWorld({ age: 1 });
    const tc = townCenter(w, 0);
    const tdef = techDefById('suki');
    const cost = techCostFx(w, 0, tdef, 'town_center');
    const before = w.players[0]!.resources[resourceIndex('food')]!;
    applyCommands(w, [{ t: 'research', p: 0, building: tc, tech: 'suki' }]);
    const i = entityIndex(tc);
    expect(w.entities.researchTech[i]).toBe(tdef.index + 1);
    expect(w.players[0]!.resources[resourceIndex('food')]).toBe(before - cost[resourceIndex('food')]!);
  });

  it('未知の研究 ID・時代未達・資源不足・他人の建物は無視する', () => {
    const w = makeWorld({ age: 0 });
    const tc = townCenter(w, 0);
    applyCommands(w, [
      { t: 'research', p: 0, building: tc, tech: 'no-such-tech' },
      { t: 'research', p: 0, building: tc, tech: 'suki' }, // 青銅の世の研究
      { t: 'research', p: 1, building: tc, tech: 'suki' }, // 他人の建物
    ]);
    expect(w.entities.researchTech[entityIndex(tc)]).toBe(0);

    const poor = makeWorld({ age: 1, resources: 0 });
    const tc2 = townCenter(poor, 0);
    applyCommands(poor, [{ t: 'research', p: 0, building: tc2, tech: 'suki' }]);
    expect(poor.entities.researchTech[entityIndex(tc2)]).toBe(0);
  });

  it('時代進化は「前の世の建物 2 種」と資源を満たすと着手できる', () => {
    const w = makeWorld();
    const tc = townCenter(w, 0);
    // 町の中心だけでは種類数 1 で足りない
    applyCommands(w, [{ t: 'advanceAge', p: 0, building: tc }]);
    expect(w.entities.researchTech[entityIndex(tc)]).toBe(0);

    spawnBuilding(w, 0, 'house', fxFromInt(24), fxFromInt(20));
    const cost = ageAdvanceCostFx(1);
    const before = w.players[0]!.resources[resourceIndex('food')]!;
    applyCommands(w, [{ t: 'advanceAge', p: 0, building: tc }]);
    expect(w.entities.researchTech[entityIndex(tc)]).toBe(RESEARCH_AGE_ADVANCE);
    expect(w.players[0]!.resources[resourceIndex('food')]).toBe(before - cost[resourceIndex('food')]!);
  });

  it('解読できない建物・資源不足は無視する', () => {
    const w = makeWorld();
    townCenter(w, 0);
    const house = spawnBuilding(w, 0, 'house', fxFromInt(24), fxFromInt(20));
    applyCommands(w, [{ t: 'advanceAge', p: 0, building: house }]);
    expect(w.entities.researchTech[entityIndex(house)]).toBe(0);

    const poor = makeWorld({ resources: 0 });
    const tc = townCenter(poor, 0);
    spawnBuilding(poor, 0, 'house', fxFromInt(24), fxFromInt(20));
    applyCommands(poor, [{ t: 'advanceAge', p: 0, building: tc }]);
    expect(poor.entities.researchTech[entityIndex(tc)]).toBe(0);
  });
});

// ---------------------------------------------------------------- 市場・貢納

describe('marketTrade / tribute — 市場と貢納', () => {
  it('金で資源を買う / 資源を売って金にする', () => {
    const w = makeWorld();
    const gold = resourceIndex('gold');
    const food = resourceIndex('food');
    const price = marketUnitPriceGoldFx(w, food);
    const goldBefore = w.players[0]!.resources[gold]!;
    const foodBefore = w.players[0]!.resources[food]!;
    applyCommands(w, [{ t: 'marketTrade', p: 0, sell: 'gold', buy: 'food', amount: 10 }]);
    expect(w.players[0]!.resources[food]).toBe(foodBefore + 10 * FX_ONE);
    expect(w.players[0]!.resources[gold]).toBe(goldBefore - 10 * price);

    const goldMid = w.players[0]!.resources[gold]!;
    applyCommands(w, [{ t: 'marketTrade', p: 0, sell: 'food', buy: 'gold', amount: 10 }]);
    expect(w.players[0]!.resources[gold]).toBeGreaterThan(goldMid);
  });

  it('金が絡まない交換・同じ資源・0 以下・未知の資源は無視する', () => {
    const w = makeWorld();
    const snapshot = [...w.players[0]!.resources];
    applyCommands(w, [
      { t: 'marketTrade', p: 0, sell: 'wood', buy: 'stone', amount: 10 },
      { t: 'marketTrade', p: 0, sell: 'food', buy: 'food', amount: 10 },
      { t: 'marketTrade', p: 0, sell: 'gold', buy: 'food', amount: 0 },
      { t: 'marketTrade', p: 0, sell: 'gold', buy: 'no-such' as 'food', amount: 10 },
    ]);
    expect([...w.players[0]!.resources]).toEqual(snapshot);
    expect([...w.market.priceMul]).toEqual([FX_ONE, FX_ONE, FX_ONE, FX_ONE]);
  });

  it('金が足りない購入は成立しない', () => {
    const w = makeWorld({ resources: 0 });
    const snapshot = [...w.players[0]!.resources];
    applyCommands(w, [{ t: 'marketTrade', p: 0, sell: 'gold', buy: 'food', amount: 100 }]);
    expect([...w.players[0]!.resources]).toEqual(snapshot);
  });

  it('貢納は味方にだけ届き、手数料 10% を引く', () => {
    const w = makeWorld({ teams: [0, 0] });
    const food = resourceIndex('food');
    const from = w.players[0]!.resources[food]!;
    const to = w.players[1]!.resources[food]!;
    applyCommands(w, [{ t: 'tribute', p: 0, to: 1, resource: 'food', amount: 100 }]);
    expect(w.players[0]!.resources[food]).toBe(from - 100 * FX_ONE);
    const received = w.players[1]!.resources[food]! - to;
    expect(fxToNumber(received)).toBeCloseTo(90, 3);
  });

  it('敵・自分自身・範囲外・資源不足への貢納は無視する', () => {
    const w = makeWorld({ playerCount: 2 });
    const food = resourceIndex('food');
    const snapshot = [w.players[0]!.resources[food]!, w.players[1]!.resources[food]!];
    applyCommands(w, [
      { t: 'tribute', p: 0, to: 1, resource: 'food', amount: 100 }, // 敵（別チーム）
      { t: 'tribute', p: 0, to: 0, resource: 'food', amount: 100 }, // 自分
      { t: 'tribute', p: 0, to: 5, resource: 'food', amount: 100 }, // 範囲外
      { t: 'tribute', p: 0, to: 1, resource: 'food', amount: 0 },
    ]);
    expect([w.players[0]!.resources[food]!, w.players[1]!.resources[food]!]).toEqual(snapshot);

    const team = makeWorld({ teams: [0, 0], resources: 0 });
    applyCommands(team, [{ t: 'tribute', p: 0, to: 1, resource: 'food', amount: 100 }]);
    expect(team.players[1]!.resources[food]).toBe(0);
  });
});

// ---------------------------------------------------------------- setRally / resign

describe('setRally / resign', () => {
  it('setRally は集合地点を置く。マップ外・他人の建物は無視する', () => {
    const w = makeWorld();
    const tc = townCenter(w, 0);
    applyCommands(w, [{ t: 'setRally', p: 0, building: tc, x: fxFromInt(30), y: fxFromInt(31) }]);
    const i = entityIndex(tc);
    expect(w.entities.rallyX[i]).toBe(fxFromInt(30));
    expect(w.entities.rallyY[i]).toBe(fxFromInt(31));

    applyCommands(w, [
      { t: 'setRally', p: 0, building: tc, x: fxFromInt(9999), y: fxFromInt(31) },
      { t: 'setRally', p: 1, building: tc, x: fxFromInt(1), y: fxFromInt(1) },
    ]);
    expect(w.entities.rallyX[i]).toBe(fxFromInt(30));
  });

  it('resign は投了フラグを立て、以後の入力を受け付けない', () => {
    const w = makeWorld();
    const tc = townCenter(w, 0);
    applyCommands(w, [{ t: 'resign', p: 0 }]);
    expect(w.players[0]!.resigned).toBe(true);
    applyCommands(w, [{ t: 'produce', p: 0, building: tc, unit: 'villager', count: 1 }]);
    expect(w.entities.queueCount[entityIndex(tc)]).toBe(0);
  });

  it('敗北済み・範囲外のプレイヤーの入力は無視する（例外にしない）', () => {
    const w = makeWorld();
    const tc = townCenter(w, 1);
    w.players[1]!.defeated = true;
    expect(() =>
      applyCommands(w, [
        { t: 'produce', p: 1, building: tc, unit: 'villager', count: 1 },
        { t: 'resign', p: 9 },
        { t: 'resign', p: -1 },
      ])
    ).not.toThrow();
    expect(w.entities.queueCount[entityIndex(tc)]).toBe(0);
  });
});

// ---------------------------------------------------------------- 全種の総当たり

describe('15 種すべて', () => {
  it('無効な EntityId / 範囲外プレイヤーを混ぜた 15 種を流しても例外を投げない', () => {
    const w = makeWorld({ playerCount: 8 });
    const cmds: Command[] = [
      { t: 'setOrder', p: 0, front: 99, order: 'charge', tier: 'upper' },
      { t: 'produce', p: 0, building: INVALID_ENTITY, unit: 'villager', count: 1 },
      { t: 'cancelQueue', p: 0, building: INVALID_ENTITY, index: -1 },
      { t: 'placeBuilding', p: 0, type: 'house', x: -1, y: -1, villagers: [INVALID_ENTITY] },
      { t: 'placeWallLine', p: 0, type: 'palisade', x0: -1, y0: -1, x1: -1, y1: -1 },
      { t: 'moveUnits', p: 0, units: [INVALID_ENTITY], x: -1, y: -1, queued: true },
      { t: 'attackTarget', p: 0, units: [INVALID_ENTITY], target: INVALID_ENTITY },
      { t: 'gather', p: 0, units: [INVALID_ENTITY], target: INVALID_ENTITY },
      { t: 'releaseManual', p: 0, units: [INVALID_ENTITY] },
      { t: 'research', p: 0, building: INVALID_ENTITY, tech: 'suki' },
      { t: 'advanceAge', p: 0, building: INVALID_ENTITY },
      { t: 'marketTrade', p: 0, sell: 'gold', buy: 'food', amount: -5 },
      { t: 'tribute', p: 0, to: 99, resource: 'food', amount: -5 },
      { t: 'setRally', p: 0, building: INVALID_ENTITY, x: -1, y: -1 },
      { t: 'resign', p: 7 },
    ];
    expect(() => applyCommands(w, cmds)).not.toThrow();
    expect(w.entities.count).toBe(0);
    expect(w.tick).toBe(0);
  });
});
