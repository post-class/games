/**
 * T-M4-01〜04, 10: 採集・搬入・運搬損失・埋蔵量・農地再建・遊休村人（`07§8` / 手順書 §6.6）
 *
 * ここでは `core/gather.ts` の計算とヘルパを単体で検証する。
 * 毎 tick の状態遷移（システム全体）は `economy.test.ts` の担当。
 *
 * M3（マップ生成）と並行作業なので `map.passable` などの地形は空。
 * 資源ノードは `spawnResourceNode` / `spawnFarm` で直接置いてテストする（mapgen に依存しない）。
 */

import { describe, expect, it } from 'vitest';

import { EntityKind, RESOURCE_IDS, resourceIndex } from '@/shared/types';
import { UnitState, isAlive, resolveIndex, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fx, fxFromInt, fxToNumber } from '@/sim/core/fx';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { cfgNum } from '@/sim/core/config';
import { createWorld, type World } from '@/sim/core/world';
import {
  RESOURCE_NODE_DEFS,
  assignVillagerToNode,
  canAffordFarmRebuild,
  carryCapacityFx,
  collectIdleVillagers,
  depleteNode,
  effectiveGatherRatePerSecFx,
  farmRebuildCostFx,
  findNearestDropOffIndex,
  findNearestResourceNodeIndex,
  findNearestShelterIndex,
  gatherAmountForTick,
  haulLossRatioFx,
  rebuildFarm,
  resourceNodeDef,
  resourceNodeIndex,
  spawnFarm,
  spawnResourceNode,
} from '@/sim/core/gather';

const FOOD = resourceIndex('food');
const WOOD = resourceIndex('wood');

function makeWorld(): World {
  return createWorld({ seed: 1, playerCount: 2, mapWidthTiles: 200, mapHeightTiles: 200 });
}

/** テスト用: 建物を 1 つ置く。 */
function putBuilding(w: World, id: string, owner: number, tx: number, ty: number): number {
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

/** テスト用: ユニットを 1 体置く。 */
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

describe('資源ノード定義（T-M4-03）', () => {
  it('resources.json の gatherFrom から index が作られ、交易・貢納はノードにならない', () => {
    const ids = RESOURCE_NODE_DEFS.map((n) => n.id);
    expect(ids).toContain('forest');
    expect(ids).toContain('farm');
    expect(ids).toContain('stone_quarry');
    expect(ids).toContain('gold_mine');
    expect(ids).not.toContain('trade');
    expect(ids).not.toContain('tribute');
    // index はこの表の添字（typeId）と一致する
    for (let i = 0; i < RESOURCE_NODE_DEFS.length; i++) {
      expect(RESOURCE_NODE_DEFS[i]!.index).toBe(i);
      expect(resourceNodeDef(i).id).toBe(RESOURCE_NODE_DEFS[i]!.id);
    }
  });

  it('農地 1 面 = 食料 400（07§8）。config.json:economy.farmYield と一致する', () => {
    const farm = resourceNodeDef(resourceNodeIndex('farm'));
    expect(farm.resource).toBe(FOOD);
    expect(farm.deposit).toBe(fx(400));
    expect(fxToNumber(farm.deposit)).toBe(cfgNum('economy.farmYield'));
    expect(farm.rebuildable).toBe(true);
  });

  it('森は木材ノードで、再建できない', () => {
    const forest = resourceNodeDef(resourceNodeIndex('forest'));
    expect(RESOURCE_IDS[forest.resource]).toBe('wood');
    expect(forest.rebuildable).toBe(false);
    expect(forest.depletable).toBe(true);
  });
});

describe('運搬損失（T-M4-02）', () => {
  it('4 マスごとに 5%、40 マスでちょうど 50% で止まる', () => {
    expect(haulLossRatioFx(0)).toBe(0);
    expect(haulLossRatioFx(fxFromInt(3))).toBe(0);
    expect(fxToNumber(haulLossRatioFx(fxFromInt(4)))).toBeCloseTo(0.05, 2);
    expect(fxToNumber(haulLossRatioFx(fxFromInt(8)))).toBeCloseTo(0.1, 2);
    expect(fxToNumber(haulLossRatioFx(fxFromInt(36)))).toBeCloseTo(0.45, 2);
    // 40 マス = floor(40/4) * 0.05 = 0.50 → 上限と一致
    expect(haulLossRatioFx(fxFromInt(40))).toBe(FX_ONE / 2);
    expect(fxToNumber(haulLossRatioFx(fxFromInt(40)))).toBe(0.5);
  });

  it('40 マスを超えても 50% で止まる（上限）', () => {
    expect(haulLossRatioFx(fxFromInt(44))).toBe(FX_ONE / 2);
    expect(haulLossRatioFx(fxFromInt(120))).toBe(FX_ONE / 2);
    expect(haulLossRatioFx(fxFromInt(199))).toBe(FX_ONE / 2);
  });

  it('段の中では損失が変わらない（4 マス刻みの階段になっている）', () => {
    const a = haulLossRatioFx(fxFromInt(8));
    for (let t = 8; t < 12; t++) expect(haulLossRatioFx(fxFromInt(t))).toBe(a);
    expect(haulLossRatioFx(fxFromInt(12))).toBeGreaterThan(a);
  });
});

describe('実効収集速度（T-M4-01）', () => {
  const forest = resourceNodeIndex('forest');

  it('搬入点が隣接（損失 0）なら基礎速度そのまま', () => {
    const r = effectiveGatherRatePerSecFx(forest, fxFromInt(2));
    expect(fxToNumber(r)).toBeCloseTo(0.45, 2);
    expect(r).toBe(resourceNodeDef(forest).baseRatePerSec);
  });

  it('森のそばに伐採所を建てると収集速度が上がる（30 マス → 2 マス）', () => {
    const far = effectiveGatherRatePerSecFx(forest, fxFromInt(30)); // 損失 35%
    const near = effectiveGatherRatePerSecFx(forest, fxFromInt(2)); // 損失 0%
    expect(near).toBeGreaterThan(far);
    expect(fxToNumber(far)).toBeCloseTo(0.29, 2);
    expect(fxToNumber(near)).toBeCloseTo(0.45, 2);
    // 1.5 倍以上速くなる
    expect(near * 100).toBeGreaterThan(far * 150);
  });

  it('研究倍率・文明倍率は引数で受け取り、既定 1.0 で恒等（M6 の結線点）', () => {
    const base = effectiveGatherRatePerSecFx(forest, fxFromInt(2));
    expect(effectiveGatherRatePerSecFx(forest, fxFromInt(2), FX_ONE, FX_ONE)).toBe(base);
    const doubled = effectiveGatherRatePerSecFx(forest, fxFromInt(2), fx(2), FX_ONE);
    expect(doubled).toBe(base * 2);
    const civ = effectiveGatherRatePerSecFx(forest, fxFromInt(2), FX_ONE, fx(1.5));
    expect(civ).toBeGreaterThan(base);
  });

  it('40 マス（損失 50%）で基礎速度の半分になる', () => {
    const half = effectiveGatherRatePerSecFx(forest, fxFromInt(40));
    const full = effectiveGatherRatePerSecFx(forest, 0);
    expect(half).toBe(Math.trunc((full * (FX_ONE / 2)) / FX_ONE));
  });
});

describe('1 tick 分の切り出し（決定論・端数の扱い）', () => {
  it('25 tick 積み上げるとちょうど毎秒の量になる（丸めで目減りしない）', () => {
    const rate = effectiveGatherRatePerSecFx(resourceNodeIndex('forest'), fxFromInt(2));
    let sum = 0;
    for (let t = 0; t < 25; t++) sum += gatherAmountForTick(rate, t);
    expect(sum).toBe(rate);
  });

  it('速度 0 なら 0、負の経過 tick でも例外にしない', () => {
    expect(gatherAmountForTick(0, 5)).toBe(0);
    expect(gatherAmountForTick(fx(1), -3)).toBe(gatherAmountForTick(fx(1), 0));
  });
});

describe('搬入点・ノード・退避先の探索', () => {
  it('搬入点は isDropOff の自軍建物のみ。同距離なら index の小さい方', () => {
    const w = makeWorld();
    putBuilding(w, 'house', 0, 10, 10); // 搬入点ではない
    const camp = putBuilding(w, 'lumber_camp', 0, 12, 10);
    const tc = putBuilding(w, 'town_center', 0, 40, 10);
    const enemyCamp = putBuilding(w, 'lumber_camp', 1, 11, 10); // 敵の伐採所は使えない
    const near = findNearestDropOffIndex(w, 0, fxFromInt(13), fxFromInt(10));
    expect(near).toBe(resolveIndex(w.entities, camp));
    const far = findNearestDropOffIndex(w, 0, fxFromInt(39), fxFromInt(10));
    expect(far).toBe(resolveIndex(w.entities, tc));
    expect(findNearestDropOffIndex(w, 1, fxFromInt(13), fxFromInt(10))).toBe(
      resolveIndex(w.entities, enemyCamp)
    );
  });

  it('資源ノードは資源種別で絞り込める。埋蔵量 0 は候補にならない', () => {
    const w = makeWorld();
    const forest = spawnResourceNode(w, resourceNodeIndex('forest'), fxFromInt(20), fxFromInt(20));
    const gold = spawnResourceNode(w, resourceNodeIndex('gold_mine'), fxFromInt(22), fxFromInt(20));
    expect(findNearestResourceNodeIndex(w, fxFromInt(21), fxFromInt(20), WOOD)).toBe(
      resolveIndex(w.entities, forest)
    );
    expect(findNearestResourceNodeIndex(w, fxFromInt(21), fxFromInt(20), -1)).toBe(
      resolveIndex(w.entities, forest)
    );
    w.entities.amount[resolveIndex(w.entities, forest)] = 0;
    expect(findNearestResourceNodeIndex(w, fxFromInt(21), fxFromInt(20), -1)).toBe(
      resolveIndex(w.entities, gold)
    );
  });

  it('退避先は garrisonCapacity > 0 の自軍建物（塔・櫓・城）だけ', () => {
    const w = makeWorld();
    putBuilding(w, 'house', 0, 10, 10);
    const tower = putBuilding(w, 'watch_tower', 0, 30, 10);
    expect(findNearestShelterIndex(w, 0, fxFromInt(11), fxFromInt(10))).toBe(
      resolveIndex(w.entities, tower)
    );
    // 満員の塔は候補から外れる
    w.entities.garrisonCount[resolveIndex(w.entities, tower)] =
      buildingDefById('watch_tower').garrisonCapacity;
    expect(findNearestShelterIndex(w, 0, fxFromInt(11), fxFromInt(10))).toBe(-1);
  });
});

describe('農地の再建（T-M4-04）', () => {
  it('再建コストは木材の半額（60 → 30）', () => {
    const cost = farmRebuildCostFx();
    expect(cost[WOOD]).toBe(fx(30));
    expect(cost[FOOD]).toBe(0);
    expect(buildingDefById('farm').cost[WOOD]).toBe(fx(60));
  });

  it('木材が足りていれば建て直せる（資源が半額分だけ減り、埋蔵量が満タンに戻る）', () => {
    const w = makeWorld();
    const farm = spawnFarm(w, 0, fxFromInt(20), fxFromInt(20));
    w.players[0]!.resources[WOOD] = fx(100);
    // 枯れさせる
    const ni = resolveIndex(w.entities, farm.node);
    w.entities.amount[ni] = 0;
    expect(canAffordFarmRebuild(w, 0)).toBe(true);
    const revived = depleteNode(w, ni);
    expect(revived).not.toBe(-1);
    expect(isAlive(w.entities, farm.node)).toBe(false);
    expect(isAlive(w.entities, revived)).toBe(true);
    expect(isAlive(w.entities, farm.building)).toBe(true); // 建物は残る
    expect(w.players[0]!.resources[WOOD]).toBe(fx(70));
    expect(w.entities.amount[resolveIndex(w.entities, revived)]).toBe(fx(400));
  });

  it('木材が足りなければ再建されず、農地の建物ごと消える', () => {
    const w = makeWorld();
    const farm = spawnFarm(w, 0, fxFromInt(20), fxFromInt(20));
    w.players[0]!.resources[WOOD] = fx(10);
    expect(canAffordFarmRebuild(w, 0)).toBe(false);
    const ni = resolveIndex(w.entities, farm.node);
    w.entities.amount[ni] = 0;
    expect(depleteNode(w, ni)).toBe(-1);
    expect(isAlive(w.entities, farm.node)).toBe(false);
    expect(isAlive(w.entities, farm.building)).toBe(false);
    expect(w.players[0]!.resources[WOOD]).toBe(fx(10));
  });

  it('森は再建対象ではない（枯れたら消えるだけ）', () => {
    const w = makeWorld();
    const forest = spawnResourceNode(w, resourceNodeIndex('forest'), fxFromInt(20), fxFromInt(20));
    w.players[0]!.resources[WOOD] = fx(1000);
    const ni = resolveIndex(w.entities, forest);
    expect(depleteNode(w, ni)).toBe(-1);
    expect(isAlive(w.entities, forest)).toBe(false);
    expect(w.players[0]!.resources[WOOD]).toBe(fx(1000));
  });

  it('rebuildFarm は農地以外の建物では失敗する', () => {
    const w = makeWorld();
    const house = putBuilding(w, 'house', 0, 5, 5);
    w.players[0]!.resources[WOOD] = fx(1000);
    expect(rebuildFarm(w, house)).toBe(-1);
  });
});

describe('村人への割り当てと遊休村人の列挙（T-M4-10）', () => {
  it('assignVillagerToNode で Gathering に入り、最寄りの搬入点が homeId に入る', () => {
    const w = makeWorld();
    const camp = putBuilding(w, 'lumber_camp', 0, 22, 20);
    const node = spawnResourceNode(w, resourceNodeIndex('forest'), fxFromInt(20), fxFromInt(20));
    const v = putUnit(w, 'villager', 0, 30, 20);
    expect(assignVillagerToNode(w, v, node)).toBe(true);
    const vi = resolveIndex(w.entities, v);
    expect(w.entities.state[vi]).toBe(UnitState.Gathering);
    expect(w.entities.target[vi]).toBe(node);
    expect(w.entities.homeId[vi]).toBe(camp);
    expect(w.entities.destX[vi]).toBe(fxFromInt(20));
  });

  it('手が空いた村人だけを index 昇順で列挙する', () => {
    const w = makeWorld();
    const node = spawnResourceNode(w, resourceNodeIndex('forest'), fxFromInt(20), fxFromInt(20));
    const v0 = putUnit(w, 'villager', 0, 10, 10);
    const v1 = putUnit(w, 'villager', 0, 11, 10);
    const v2 = putUnit(w, 'villager', 0, 12, 10);
    const enemy = putUnit(w, 'villager', 1, 13, 10);
    putUnit(w, 'y-ashigaru', 0, 14, 10); // 兵は対象外

    const out: number[] = [];
    expect(collectIdleVillagers(w, 0, out)).toBe(3);
    expect(out).toEqual([v0, v1, v2]);

    // v1 を働かせると外れる
    assignVillagerToNode(w, v1, node);
    collectIdleVillagers(w, 0, out);
    expect(out).toEqual([v0, v2]);

    // 何か持っている村人も「手が空いている」とはみなさない
    w.entities.carryKind[resolveIndex(w.entities, v0)] = WOOD + 1;
    w.entities.carryAmount[resolveIndex(w.entities, v0)] = carryCapacityFx();
    collectIdleVillagers(w, 0, out);
    expect(out).toEqual([v2]);

    // 相手プレイヤーの村人は自分の一覧に出ない
    collectIdleVillagers(w, 1, out);
    expect(out).toEqual([enemy]);
  });
});
