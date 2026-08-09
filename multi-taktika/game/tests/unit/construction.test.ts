/**
 * T-M6-02: 建設（村人数で加速、前線でも可）と修理・跡地（`07§9`, 手順書 §6.7）
 *
 * 検証:
 *  - 建設速度テーブル: 1 人 1.0 / 2 人 1.7 / **3 人 2.3 倍 ±0.05**（完了条件）
 *  - 実際の建設 tick 数の比も 2.3 倍 ±0.05 になる
 *  - 文明ボーナス（アステカ 1.3 倍）が乗る
 *  - 建設中の建物は HP が低く、完成に向かって伸びる。壊されても資源は戻らない
 *  - 修理費は失った HP に比例し、**建設費の 1/4 が上限**
 *  - 破壊跡地タイマーの間は同じ場所に建てられない。壁の穴は建て直せるが 1.5 倍時間
 *  - 前線でも建てられる（位置による制限を掛けていない）
 */

import { describe, expect, it } from 'vitest';
import type { CivId, EntityId } from '@/shared/types';
import { EntityKind, RESOURCE_IDS, resourceIndex } from '@/shared/types';
import { FX_ONE, fx, fxFromInt, fxToNumber } from '@/sim/core/fx';
import { createWorld, type World } from '@/sim/core/world';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { entityIndex, spawnEntity } from '@/sim/core/entity';
import { PROGRESS_DONE, isBuildingComplete, isRebuildBlocked } from '@/sim/core/effects';
import { TICK_RATE, cfgNum } from '@/sim/core/config';
import {
  assignBuilder,
  beginConstruction,
  buildingCostFx,
  construction,
  countBuilders,
  onBuildingDestroyed,
  progressRatio,
  repairCostFx,
  requiredBuildWork,
  spawnBuilding,
  villagerBuildSpeedMul,
} from '@/sim/systems/construction';

function makeWorld(civ: CivId = 'yamato', age = 2): World {
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
  for (let r = 0; r < RESOURCE_IDS.length; r++) pl.resources[r] = fx(10000);
  return w;
}

function spawnVillagers(w: World, p: number, n: number): EntityId[] {
  const def = unitDefById('villager');
  const out: EntityId[] = [];
  for (let k = 0; k < n; k++) {
    out.push(
      spawnEntity(w.entities, {
        kind: EntityKind.Unit,
        owner: p,
        typeId: def.index,
        x: fxFromInt(10 + k),
        y: fxFromInt(10),
        hpMax: def.hp,
      })
    );
  }
  return out;
}

/** 村人 n 人で建て切るまでの tick 数。 */
function ticksToBuild(civ: CivId, buildingId: string, villagers: number): number {
  const w = makeWorld(civ);
  const vs = spawnVillagers(w, 0, villagers);
  const r = beginConstruction(w, 0, buildingId, fxFromInt(30), fxFromInt(30), vs);
  expect(r.result).toBe('ok');
  const idx = entityIndex(r.id);
  let t = 0;
  while (!isBuildingComplete(w, idx) && t < 100000) {
    construction(w);
    w.tick += 1;
    t++;
  }
  return t;
}

describe('T-M6-02 建設速度テーブル', () => {
  it('1 人 1.0 / 2 人 1.7 / 3 人 2.3（±0.05）', () => {
    expect(fxToNumber(villagerBuildSpeedMul(1))).toBeCloseTo(1.0, 2);
    expect(fxToNumber(villagerBuildSpeedMul(2))).toBeCloseTo(1.7, 2);
    const three = fxToNumber(villagerBuildSpeedMul(3));
    expect(Math.abs(three - 2.3)).toBeLessThanOrEqual(0.05);
  });

  it('0 人では進まない / テーブル上限を超えたら打ち止め', () => {
    expect(villagerBuildSpeedMul(0)).toBe(0);
    const max = cfgNum('construction.villagerSpeedMulMaxVillagers');
    expect(villagerBuildSpeedMul(max + 5)).toBe(villagerBuildSpeedMul(max));
  });

  it('実際の建設 tick 数が 3 人で 2.3 倍 ±0.05 になる', () => {
    const one = ticksToBuild('yamato', 'barracks', 1);
    const three = ticksToBuild('yamato', 'barracks', 3);
    const two = ticksToBuild('yamato', 'barracks', 2);
    expect(one).toBe(buildingDefById('barracks').buildTicks);
    expect(Math.abs(one / three - 2.3)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(one / two - 1.7)).toBeLessThanOrEqual(0.05);
  });

  it('アステカの建設ボーナス（1.3 倍）が乗る', () => {
    const plain = ticksToBuild('yamato', 'barracks', 1);
    const azteca = ticksToBuild('azteca', 'barracks', 1);
    expect(Math.abs(plain / azteca - 1.3)).toBeLessThanOrEqual(0.05);
  });

  it('村人を後から足すと速くなる', () => {
    const w = makeWorld();
    const vs = spawnVillagers(w, 0, 3);
    const r = beginConstruction(w, 0, 'barracks', fxFromInt(30), fxFromInt(30), [vs[0]!]);
    const idx = entityIndex(r.id);
    expect(countBuilders(w, idx)).toBe(1);
    construction(w);
    const after1 = w.entities.buildProgress[idx]!;
    expect(after1).toBe(FX_ONE);

    assignBuilder(w, vs[1]!, r.id);
    assignBuilder(w, vs[2]!, r.id);
    expect(countBuilders(w, idx)).toBe(3);
    w.tick += 1;
    construction(w);
    expect(w.entities.buildProgress[idx]! - after1).toBe(villagerBuildSpeedMul(3));
  });
});

describe('T-M6-02 建設中の建物', () => {
  it('HP が低く始まり、完成に向かって伸びる', () => {
    const w = makeWorld();
    const def = buildingDefById('barracks');
    const vs = spawnVillagers(w, 0, 1);
    const r = beginConstruction(w, 0, 'barracks', fxFromInt(30), fxFromInt(30), vs);
    const idx = entityIndex(r.id);
    const ratio = cfgNum('construction.underConstructionHpRatio');
    expect(w.entities.hp[idx]).toBe(fx(fxToNumber(def.hp) * ratio));
    expect(isBuildingComplete(w, idx)).toBe(false);

    for (let t = 0; t < def.buildTicks / 2; t++) {
      construction(w);
      w.tick += 1;
    }
    const mid = w.entities.hp[idx]!;
    expect(mid).toBeGreaterThan(fx(fxToNumber(def.hp) * ratio));
    expect(mid).toBeLessThan(def.hp);

    for (let t = 0; t < def.buildTicks; t++) {
      construction(w);
      w.tick += 1;
    }
    expect(isBuildingComplete(w, idx)).toBe(true);
    expect(w.entities.hp[idx]).toBe(def.hp);
    expect(w.entities.buildProgress[idx]).toBe(PROGRESS_DONE);
    // 完成したら村人は手を離す
    expect(countBuilders(w, idx)).toBe(0);
  });

  it('壊されても資源は戻らない', () => {
    const w = makeWorld();
    const before = w.players[0]!.resources[resourceIndex('wood')]!;
    const vs = spawnVillagers(w, 0, 1);
    const r = beginConstruction(w, 0, 'barracks', fxFromInt(30), fxFromInt(30), vs);
    const spent = before - w.players[0]!.resources[resourceIndex('wood')]!;
    expect(spent).toBe(buildingDefById('barracks').cost[resourceIndex('wood')]);

    onBuildingDestroyed(w, entityIndex(r.id));
    expect(w.players[0]!.resources[resourceIndex('wood')]).toBe(before - spent);
  });

  it('前線でも建てられる（位置で拒否しない）', () => {
    const w = makeWorld();
    // 敵ユニットの隣でも建設は始まる
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner: 1,
      typeId: unitDefById('clubman').index,
      x: fxFromInt(31),
      y: fxFromInt(30),
      hpMax: unitDefById('clubman').hp,
    });
    expect(beginConstruction(w, 0, 'palisade', fxFromInt(30), fxFromInt(30)).result).toBe('ok');
    expect(beginConstruction(w, 0, 'watch_tower', fxFromInt(32), fxFromInt(30)).result).toBe('ok');
  });

  it('コストが足りない / 時代が足りないときは始まらない', () => {
    const w = makeWorld('yamato', 0);
    expect(beginConstruction(w, 0, 'barracks', fxFromInt(30), fxFromInt(30)).result).toBe(
      'ageLocked'
    );
    const w2 = makeWorld();
    for (let r = 0; r < RESOURCE_IDS.length; r++) w2.players[0]!.resources[r] = 0;
    expect(beginConstruction(w2, 0, 'barracks', fxFromInt(30), fxFromInt(30)).result).toBe(
      'notEnoughResources'
    );
  });

  it('建設上限（市場 1 棟）を超えられない', () => {
    const w = makeWorld();
    expect(beginConstruction(w, 0, 'market', fxFromInt(20), fxFromInt(20)).result).toBe('ok');
    expect(beginConstruction(w, 0, 'market', fxFromInt(40), fxFromInt(40)).result).toBe(
      'limitReached'
    );
  });

  it('ローマの街道は建設コストが半額（buildCostMul）', () => {
    const w = makeWorld('roma');
    const def = buildingDefById('road');
    const cost = buildingCostFx(w, 0, def);
    expect(cost[resourceIndex('wood')]).toBe(
      fx(fxToNumber(def.cost[resourceIndex('wood')]!) * 0.5)
    );
  });
});

describe('T-M6-02 修理', () => {
  it('修理費は失った HP に比例し、建設費の 1/4 が上限', () => {
    const w = makeWorld();
    const def = buildingDefById('barracks');
    const id = spawnBuilding(w, 0, 'barracks', fxFromInt(20), fxFromInt(20));
    const idx = entityIndex(id);
    const woodIdx = resourceIndex('wood');
    const ratioMax = cfgNum('construction.repairCostRatioMax');
    const fullCost = def.cost[woodIdx]!;

    // 全損寸前 → 上限（建設費の 1/4）でほぼ止まる
    w.entities.hp[idx] = 1;
    const nearFull = repairCostFx(w, 0, idx)[woodIdx]!;
    expect(nearFull).toBeLessThanOrEqual(fx(fxToNumber(fullCost) * ratioMax));
    expect(nearFull / (fullCost * ratioMax)).toBeCloseTo(1.0, 1);

    // 半分だけ失った → 上限の半分
    w.entities.hp[idx] = Math.trunc(def.hp / 2);
    const half = repairCostFx(w, 0, idx)[woodIdx]!;
    expect(half / nearFull).toBeCloseTo(0.5, 1);

    // 無傷なら 0
    w.entities.hp[idx] = def.hp;
    expect(repairCostFx(w, 0, idx)[woodIdx]).toBe(0);
  });

  it('村人を就ければ HP が戻り、資源が減る', () => {
    const w = makeWorld();
    const def = buildingDefById('barracks');
    const id = spawnBuilding(w, 0, 'barracks', fxFromInt(20), fxFromInt(20));
    const idx = entityIndex(id);
    w.entities.hp[idx] = Math.trunc(def.hp / 2);
    const vs = spawnVillagers(w, 0, 1);
    assignBuilder(w, vs[0]!, id);

    const woodBefore = w.players[0]!.resources[resourceIndex('wood')]!;
    for (let t = 0; t < def.buildTicks * 2; t++) {
      construction(w);
      w.tick += 1;
    }
    expect(w.entities.hp[idx]).toBe(def.hp);
    expect(w.players[0]!.resources[resourceIndex('wood')]!).toBeLessThan(woodBefore);
    // 修理が終われば村人は手を離す
    expect(countBuilders(w, idx)).toBe(0);
  });

  it('資源が無いと修理が進まない', () => {
    const w = makeWorld();
    const def = buildingDefById('barracks');
    const id = spawnBuilding(w, 0, 'barracks', fxFromInt(20), fxFromInt(20));
    const idx = entityIndex(id);
    w.entities.hp[idx] = Math.trunc(def.hp / 2);
    for (let r = 0; r < RESOURCE_IDS.length; r++) w.players[0]!.resources[r] = 0;
    const vs = spawnVillagers(w, 0, 1);
    assignBuilder(w, vs[0]!, id);

    const hpBefore = w.entities.hp[idx]!;
    for (let t = 0; t < 100; t++) {
      construction(w);
      w.tick += 1;
    }
    expect(w.entities.hp[idx]).toBe(hpBefore);
  });
});

describe('T-M6-02 破壊跡地', () => {
  it('跡地タイマーの間は同じ場所に建てられない', () => {
    const w = makeWorld();
    const id = spawnBuilding(w, 0, 'house', fxFromInt(25), fxFromInt(25));
    onBuildingDestroyed(w, entityIndex(id));
    expect(isRebuildBlocked(w, 'house', fxFromInt(25), fxFromInt(25))).toBe(true);
    expect(beginConstruction(w, 0, 'house', fxFromInt(25), fxFromInt(25)).result).toBe(
      'siteBlocked'
    );
    // 少し離れた場所には建てられる
    expect(beginConstruction(w, 0, 'house', fxFromInt(35), fxFromInt(25)).result).toBe('ok');

    // 跡地の残存時間（30 秒）を過ぎれば建てられる
    const rubbleTicks = Math.round(cfgNum('construction.rubbleSec') * TICK_RATE);
    for (let t = 0; t <= rubbleTicks; t++) {
      construction(w);
      w.tick += 1;
    }
    expect(isRebuildBlocked(w, 'house', fxFromInt(25), fxFromInt(25))).toBe(false);
    expect(beginConstruction(w, 0, 'house', fxFromInt(25), fxFromInt(25)).result).toBe('ok');
  });

  it('壊れた壁の穴は建て直せるが建設時間が 1.5 倍', () => {
    const w = makeWorld();
    const def = buildingDefById('palisade');
    const id = spawnBuilding(w, 0, 'palisade', fxFromInt(18), fxFromInt(19));
    onBuildingDestroyed(w, entityIndex(id));

    const plain = requiredBuildWork(w, def, fxFromInt(40), fxFromInt(40));
    const hole = requiredBuildWork(w, def, fxFromInt(18), fxFromInt(19));
    expect(hole / plain).toBeCloseTo(cfgNum('construction.wallRebuildTimeMul'), 2);
    // 穴には建て直せる（跡地タイマーで塞がない）
    expect(beginConstruction(w, 0, 'palisade', fxFromInt(18), fxFromInt(19)).result).toBe('ok');
  });

  it('井戸の跡地はその試合中ずっと建てられない（forbidRebuildHere）', () => {
    const w = makeWorld();
    const id = spawnBuilding(w, 0, 'well', fxFromInt(22), fxFromInt(22));
    onBuildingDestroyed(w, entityIndex(id));
    const rubbleTicks = Math.round(cfgNum('construction.rubbleSec') * TICK_RATE);
    for (let t = 0; t <= rubbleTicks * 2; t++) {
      construction(w);
      w.tick += 1;
    }
    expect(isRebuildBlocked(w, 'house', fxFromInt(22), fxFromInt(22))).toBe(true);
  });
});

describe('進捗の表示用変換', () => {
  it('progressRatio は 0..FX_ONE に収まり、完了で FX_ONE', () => {
    expect(progressRatio(0, fxFromInt(100))).toBe(0);
    expect(fxToNumber(progressRatio(fxFromInt(50), fxFromInt(100)))).toBeCloseTo(0.5, 2);
    expect(progressRatio(fxFromInt(200), fxFromInt(100))).toBe(FX_ONE);
    expect(progressRatio(PROGRESS_DONE, fxFromInt(100))).toBe(FX_ONE);
  });
});
