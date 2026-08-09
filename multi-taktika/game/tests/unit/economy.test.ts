/**
 * T-M4-01, 03, 04, 06, 09, 10: economy システムの毎 tick の挙動（`07§8` / 手順書 §6.6）
 *
 * M3（マップ生成・移動）と並行作業なので、
 *  - 資源ノードはテスト内のヘルパで直接置く（mapgen に依存しない）
 *  - 移動は `movement.ts` の責務なので、村人・荷車は手で「瞬間移動」させて到着を作る
 *    （economy 側の責務は `destX/destY` を置くことと到着判定だけ）
 */

import { describe, expect, it } from 'vitest';

import { EntityKind, resourceIndex } from '@/shared/types';
import { PROGRESS_DONE, UnitState, isAlive, resolveIndex, spawnEntity } from '@/sim/core/entity';
import { fx, fxFromInt, fxToNumber } from '@/sim/core/fx';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { rebuildGrid } from '@/sim/core/grid';
import { createWorld, type World } from '@/sim/core/world';
import {
  assignVillagerToNode,
  carryCapacityFx,
  collectIdleVillagers,
  effectiveGatherRatePerSecFx,
  resourceNodeIndex,
  spawnFarm,
  spawnResourceNode,
} from '@/sim/core/gather';
import { GOLD_RESOURCE } from '@/sim/core/market';
import { assignTradeRoute, economy } from '@/sim/systems/economy';

const FOOD = resourceIndex('food');
const WOOD = resourceIndex('wood');
const FOREST = resourceNodeIndex('forest');

function makeWorld(teams?: readonly number[]): World {
  return createWorld({
    seed: 11,
    playerCount: 2,
    mapWidthTiles: 200,
    mapHeightTiles: 200,
    ...(teams !== undefined ? { teams } : {}),
  });
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
  // **完成済み**として置く。建設中（buildProgress < PROGRESS_DONE）の建物は
  // 人口を提供せず搬入点にもならないので、これを入れないと経済が動かない。
  w.entities.buildProgress[resolveIndex(w.entities, eid)] = PROGRESS_DONE;
  return eid;
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

/** n tick 進める（economy 以外のシステムは動かさない）。 */
function run(w: World, ticks: number, rebuild = false): void {
  for (let k = 0; k < ticks; k++) {
    if (rebuild) rebuildGrid(w.grid, w.entities, w.tick);
    economy(w);
    w.tick += 1;
  }
}

/** ユニットを目的地（destX/destY）へ瞬間移動させる（movement の代役）。 */
function teleportToDest(w: World, id: number): void {
  const i = resolveIndex(w.entities, id);
  w.entities.x[i] = w.entities.destX[i]!;
  w.entities.y[i] = w.entities.destY[i]!;
}

describe('採集・搬入ループ（T-M4-01）', () => {
  it('森のそばに伐採所を建てると収集速度が上がる（1 秒で 0.449 単位 vs 0.293 単位）', () => {
    // --- 伐採所が森の隣（片道 2 マス → 運搬損失 0%）---
    const near = makeWorld();
    putBuilding(near, 'lumber_camp', 0, 52, 50);
    const nearNode = spawnResourceNode(near, FOREST, fxFromInt(50), fxFromInt(50));
    const nearVil = putUnit(near, 'villager', 0, 50, 50);
    assignVillagerToNode(near, nearVil, nearNode);
    run(near, 25); // 1 秒

    // --- 町の中心だけ（片道 30 マス → 運搬損失 35%）---
    const far = makeWorld();
    putBuilding(far, 'town_center', 0, 80, 50);
    const farNode = spawnResourceNode(far, FOREST, fxFromInt(50), fxFromInt(50));
    const farVil = putUnit(far, 'villager', 0, 50, 50);
    assignVillagerToNode(far, farVil, farNode);
    run(far, 25);

    const nearCarry = near.entities.carryAmount[resolveIndex(near.entities, nearVil)]!;
    const farCarry = far.entities.carryAmount[resolveIndex(far.entities, farVil)]!;

    expect(nearCarry).toBeGreaterThan(farCarry);
    expect(fxToNumber(nearCarry)).toBeCloseTo(0.449, 3);
    expect(fxToNumber(farCarry)).toBeCloseTo(0.293, 3);
    // 1 秒分の実効収集速度と一致する（丸めで目減りしない）
    expect(nearCarry).toBe(effectiveGatherRatePerSecFx(FOREST, fxFromInt(2)));
    expect(farCarry).toBe(effectiveGatherRatePerSecFx(FOREST, fxFromInt(30)));
    expect(near.entities.carryKind[resolveIndex(near.entities, nearVil)]).toBe(WOOD + 1);
  });

  it('10 単位持つと搬入点へ向かい、着いたら手持ちに加算されて採集に戻る', () => {
    const w = makeWorld();
    const camp = putBuilding(w, 'lumber_camp', 0, 60, 50);
    const node = spawnResourceNode(w, FOREST, fxFromInt(50), fxFromInt(50));
    const v = putUnit(w, 'villager', 0, 50, 50);
    assignVillagerToNode(w, v, node);
    const vi = resolveIndex(w.entities, v);

    // 満載になるまで（10 単位 ÷ 約 0.42/秒 ≒ 24 秒）
    run(w, 25 * 30);
    expect(w.entities.carryAmount[vi]).toBe(carryCapacityFx());
    expect(w.entities.state[vi]).toBe(UnitState.Hauling);
    expect(w.entities.homeId[vi]).toBe(camp);
    expect(w.entities.destX[vi]).toBe(fxFromInt(60));
    expect(w.players[0]!.resources[WOOD]).toBe(0); // まだ届いていない

    // 搬入点まで歩いた（movement の代役）→ 次の tick で搬入される
    teleportToDest(w, v);
    run(w, 1);
    expect(w.players[0]!.resources[WOOD]).toBe(fx(10));
    expect(w.entities.carryAmount[vi]).toBe(0);
    expect(w.entities.carryKind[vi]).toBe(0);
    expect(w.entities.state[vi]).toBe(UnitState.Gathering);
    expect(w.entities.destX[vi]).toBe(fxFromInt(50)); // 森へ戻る
  });

  it('搬入点が 1 つも無いプレイヤーの村人は損失なしで採集し、満載で手が空く', () => {
    const w = makeWorld();
    const node = spawnResourceNode(w, FOREST, fxFromInt(50), fxFromInt(50));
    const v = putUnit(w, 'villager', 0, 50, 50);
    assignVillagerToNode(w, v, node);
    run(w, 25);
    const vi = resolveIndex(w.entities, v);
    expect(w.entities.carryAmount[vi]).toBe(effectiveGatherRatePerSecFx(FOREST, 0));
    run(w, 25 * 30);
    expect(w.entities.state[vi]).toBe(UnitState.Idle);
    expect(w.entities.carryAmount[vi]).toBe(carryCapacityFx());
  });

  it('手動操作中（manual = 1）でも、指示された採集は進む（06§5 / 06§9）', () => {
    // `manual` が止めるのは**自律判断**（勝手に逃げる・勝手に次の仕事を探す）だけ。
    // `gather` コマンドは仕様どおり manual を立てるので、ここで採集まで止めると
    // 「採集を命じた村人が 1 tick も働かない」ことになる。
    const w = makeWorld();
    putBuilding(w, 'lumber_camp', 0, 52, 50);
    const node = spawnResourceNode(w, FOREST, fxFromInt(50), fxFromInt(50));
    const v = putUnit(w, 'villager', 0, 50, 50);
    assignVillagerToNode(w, v, node);
    const vi = resolveIndex(w.entities, v);
    w.entities.manual[vi] = 1;
    run(w, 25);
    expect(w.entities.carryAmount[vi]).toBeGreaterThan(0);
  });

  it('手動操作中の村人は、手が空いても自分で次の仕事を探さない（06§5）', () => {
    const w = makeWorld();
    putBuilding(w, 'lumber_camp', 0, 52, 50);
    spawnResourceNode(w, FOREST, fxFromInt(50), fxFromInt(50));
    const v = putUnit(w, 'villager', 0, 50, 50);
    const vi = resolveIndex(w.entities, v);
    // 作業対象を持たない（Idle）状態で manual を立てる
    w.entities.manual[vi] = 1;
    run(w, 50);
    // 目の前に森があっても勝手に採集を始めない
    expect(w.entities.carryAmount[vi]).toBe(0);
  });
});

describe('埋蔵量と枯渇（T-M4-03）', () => {
  it('採った分だけ減る。時間経過では減らない', () => {
    const w = makeWorld();
    putBuilding(w, 'lumber_camp', 0, 52, 50);
    const node = spawnResourceNode(w, FOREST, fxFromInt(50), fxFromInt(50));
    const ni = resolveIndex(w.entities, node);
    const deposit = w.entities.amount[ni]!;

    // 村人を置かずに 10 秒経過 → 減らない
    run(w, 250);
    expect(w.entities.amount[ni]).toBe(deposit);

    // 村人が 1 秒採る → 採った分（= 手持ち）だけ減る
    const v = putUnit(w, 'villager', 0, 50, 50);
    assignVillagerToNode(w, v, node);
    run(w, 25);
    const carried = w.entities.carryAmount[resolveIndex(w.entities, v)]!;
    expect(carried).toBeGreaterThan(0);
    expect(w.entities.amount[ni]).toBe(deposit - carried);
  });

  it('採り切るとエンティティが消え、村人は搬入に回る', () => {
    const w = makeWorld();
    putBuilding(w, 'lumber_camp', 0, 52, 50);
    const node = spawnResourceNode(w, FOREST, fxFromInt(50), fxFromInt(50));
    const ni = resolveIndex(w.entities, node);
    w.entities.amount[ni] = fx(2); // 残り 2 単位だけ
    const v = putUnit(w, 'villager', 0, 50, 50);
    assignVillagerToNode(w, v, node);
    const vi = resolveIndex(w.entities, v);

    run(w, 25 * 10);
    expect(isAlive(w.entities, node)).toBe(false);
    expect(fxToNumber(w.entities.carryAmount[vi]!)).toBeCloseTo(2, 5);
    expect(w.entities.state[vi]).toBe(UnitState.Hauling);
  });
});

describe('農地の再建（T-M4-04）', () => {
  it('自動再建 ON なら、枯れた瞬間に木材半額で建て直して採集が続く', () => {
    const w = makeWorld();
    putBuilding(w, 'town_center', 0, 52, 50);
    const farm = spawnFarm(w, 0, fxFromInt(50), fxFromInt(50));
    w.players[0]!.resources[WOOD] = fx(100);
    const ni = resolveIndex(w.entities, farm.node);
    w.entities.amount[ni] = fx(1); // すぐ枯れる状態にする
    const v = putUnit(w, 'villager', 0, 50, 50);
    assignVillagerToNode(w, v, farm.node);
    const vi = resolveIndex(w.entities, v);

    run(w, 25 * 5);
    // 元のノードは消え、新しいノードが同じ場所にある
    expect(isAlive(w.entities, farm.node)).toBe(false);
    expect(isAlive(w.entities, farm.building)).toBe(true);
    const newNode = w.entities.target[vi]!;
    expect(newNode).not.toBe(farm.node);
    expect(isAlive(w.entities, newNode)).toBe(true);
    // 木材が半額（60 → 30）だけ減っている
    expect(w.players[0]!.resources[WOOD]).toBe(fx(70));
    // 採集は止まっていない（食料が溜まり続けている）
    expect(w.entities.state[vi]).toBe(UnitState.Gathering);
    expect(w.entities.carryKind[vi]).toBe(FOOD + 1);
    const carried = w.entities.carryAmount[vi]!;
    run(w, 25);
    expect(w.entities.carryAmount[vi]!).toBeGreaterThan(carried);
  });

  it('木材が無ければ再建されず、農地も消えて村人の仕事が無くなる', () => {
    const w = makeWorld();
    putBuilding(w, 'town_center', 0, 52, 50);
    const farm = spawnFarm(w, 0, fxFromInt(50), fxFromInt(50));
    w.players[0]!.resources[WOOD] = 0;
    w.entities.amount[resolveIndex(w.entities, farm.node)] = fx(1);
    const v = putUnit(w, 'villager', 0, 50, 50);
    assignVillagerToNode(w, v, farm.node);
    const vi = resolveIndex(w.entities, v);

    run(w, 25 * 5);
    expect(isAlive(w.entities, farm.node)).toBe(false);
    expect(isAlive(w.entities, farm.building)).toBe(false);
    // 持っている分は搬入に回る
    expect(w.entities.state[vi]).toBe(UnitState.Hauling);
    teleportToDest(w, v);
    run(w, 1);
    expect(fxToNumber(w.players[0]!.resources[FOOD]!)).toBeCloseTo(1, 5);
    // 搬入し終わると仕事が無くなり、遊休村人として列挙される
    const idle: number[] = [];
    expect(collectIdleVillagers(w, 0, idle)).toBe(1);
    expect(idle[0]).toBe(v);
  });
});

describe('村人の自動退避（T-M4-09）', () => {
  it('敵兵が視界に入ると最寄りの塔へ退避し、その間の収入が止まる。敵が去れば戻る', () => {
    const w = makeWorld();
    putBuilding(w, 'lumber_camp', 0, 52, 50);
    putBuilding(w, 'watch_tower', 0, 45, 50);
    const node = spawnResourceNode(w, FOREST, fxFromInt(50), fxFromInt(50));
    const v = putUnit(w, 'villager', 0, 50, 50);
    assignVillagerToNode(w, v, node);
    const vi = resolveIndex(w.entities, v);

    run(w, 25, true);
    const before = w.entities.carryAmount[vi]!;
    expect(before).toBeGreaterThan(0);

    // 敵の足軽が 3 マスに現れる（村人の視界 6 マス以内）
    const enemy = putUnit(w, 'y-ashigaru', 1, 53, 50);
    run(w, 25, true);
    expect(w.entities.state[vi]).toBe(UnitState.Moving);
    expect(w.entities.destX[vi]).toBe(fxFromInt(45)); // 塔の位置
    // 壊滅はしないが、収入は止まる
    expect(w.entities.carryAmount[vi]).toBe(before);
    expect(isAlive(w.entities, v)).toBe(true);

    // 敵がいなくなれば仕事に戻る
    w.entities.alive[resolveIndex(w.entities, enemy)] = 0;
    run(w, 25, true);
    expect(w.entities.state[vi]).toBe(UnitState.Gathering);
    expect(w.entities.carryAmount[vi]!).toBeGreaterThan(before);
  });

  it('敵の村人だけなら逃げない（戦闘ユニットだけを脅威とする）', () => {
    const w = makeWorld();
    putBuilding(w, 'lumber_camp', 0, 52, 50);
    putBuilding(w, 'watch_tower', 0, 45, 50);
    const node = spawnResourceNode(w, FOREST, fxFromInt(50), fxFromInt(50));
    const v = putUnit(w, 'villager', 0, 50, 50);
    assignVillagerToNode(w, v, node);
    putUnit(w, 'villager', 1, 53, 50);
    run(w, 25, true);
    expect(w.entities.state[resolveIndex(w.entities, v)]).toBe(UnitState.Gathering);
    expect(w.entities.carryAmount[resolveIndex(w.entities, v)]!).toBeGreaterThan(0);
  });
});

describe('交易荷車（T-M4-06）', () => {
  /** 荷車を 1 往復させ、往復で得た金（Fx）を返す。 */
  function oneRoundTrip(partnerTileX: number): number {
    const w = makeWorld([0, 0]);
    const home = putBuilding(w, 'market', 0, 20, 20);
    const partner = putBuilding(w, 'market', 1, partnerTileX, 20);
    const cart = putUnit(w, 'trade_cart', 0, 20, 20);
    expect(assignTradeRoute(w, cart, home, partner)).toBe(true);

    // 往路: 相手の市場へ（移動は M3 の担当なので瞬間移動で代役）
    run(w, 1);
    expect(w.entities.destX[resolveIndex(w.entities, cart)]).toBe(fxFromInt(partnerTileX));
    teleportToDest(w, cart);
    run(w, 1);
    // 復路: 金を積んで自分の市場へ
    expect(w.entities.carryKind[resolveIndex(w.entities, cart)]).toBe(GOLD_RESOURCE + 1);
    expect(w.entities.destX[resolveIndex(w.entities, cart)]).toBe(fxFromInt(20));
    teleportToDest(w, cart);
    run(w, 1);
    expect(w.entities.carryKind[resolveIndex(w.entities, cart)]).toBe(0);
    return w.players[0]!.resources[GOLD_RESOURCE]!;
  }

  it('片道 100 マスの往復で 50 の金が入る', () => {
    expect(oneRoundTrip(120)).toBe(fx(50));
  });

  it('遠い相手と繋ぐほど収入が増える', () => {
    const near = oneRoundTrip(40); // 片道 20 マス
    const mid = oneRoundTrip(70); // 片道 50 マス
    const farAway = oneRoundTrip(170); // 片道 150 マス
    expect(near).toBe(fx(10));
    expect(mid).toBe(fx(25));
    expect(farAway).toBe(fx(75));
    expect(farAway).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(near);
  });
});

describe('人口の集計（T-M4-08）', () => {
  it('economy が毎 tick pop / popCap を更新する', () => {
    const w = makeWorld();
    putBuilding(w, 'town_center', 0, 20, 20);
    putBuilding(w, 'house', 0, 22, 20);
    putUnit(w, 'villager', 0, 21, 20);
    putUnit(w, 'a-catapult', 0, 23, 20);
    run(w, 1);
    expect(w.players[0]!.popCap).toBe(15);
    expect(w.players[0]!.pop).toBe(4);
  });
});

describe('決定論（同じ初期状態からは同じ結果）', () => {
  it('2 回まわして資源・埋蔵量・状態が完全に一致する', () => {
    function play(): number[] {
      const w = makeWorld();
      putBuilding(w, 'lumber_camp', 0, 52, 50);
      const node = spawnResourceNode(w, FOREST, fxFromInt(50), fxFromInt(50));
      for (let k = 0; k < 5; k++) {
        const v = putUnit(w, 'villager', 0, 50, 50);
        assignVillagerToNode(w, v, node);
      }
      run(w, 25 * 20, true);
      const ni = resolveIndex(w.entities, node);
      const out = [w.players[0]!.resources[WOOD]!, ni >= 0 ? w.entities.amount[ni]! : -1];
      for (let i = 0; i < w.entities.highWater; i++) {
        out.push(w.entities.state[i]!, w.entities.carryAmount[i]!);
      }
      return out;
    }
    expect(play()).toEqual(play());
  });
});
