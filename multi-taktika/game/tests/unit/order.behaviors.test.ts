/**
 * T-M9-06〜09: 令 6 種の挙動 / 二重旗 / 固有令 8 種 / 手動操作との共存
 *
 * 完了条件:
 *  - T-M9-06 `07§5` の表の「結果として起きる挙動」を**数値で**検証する
 *      突撃 = 距離が縮む・射程の有利を捨てる / 包囲 = 兵器が前で歩兵が付いて下がる /
 *      死守 = 持ち場から離れない / 略奪 = 村人を狙い井戸は狙わない /
 *      建設 = 村人が建設地へ・兵は村人の護衛 / 後退 = 拠点へ下がる
 *  - T-M9-07「**死守 + 包囲**が成立し「**突撃 + 死守**」が拒否される」
 *  - T-M9-08 固有令 8 種が `orders.json` の段（`docs/ISSUES.md` の判断）どおりに機能する
 *  - T-M9-09「同じ戦域の他の部隊が令のまま動き続ける」
 *
 * M8 が未完成なので戦域は手で立てる。移動を伴う検証は
 * `unitDecision` → `movement` を必要な回数だけ回して確かめる（`stepWorld` の 5→6 と同じ順序）。
 */

import { describe, expect, it } from 'vitest';
import type { CivId, OrderId } from '@/shared/types';
import { EntityKind, INVALID_ENTITY } from '@/shared/types';
import { applyCommands } from '@/sim/command';
import { TICK_RATE, cfgNum } from '@/sim/core/config';
import { ORDER_DEFS, buildingDefById, orderDefById, techIndex, unitDefById } from '@/sim/core/defs';
import { PROGRESS_DONE, markModifiersDirty } from '@/sim/core/effects';
import { UnitState, entityIndex, idOfIndex, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fx, fxFromInt, fxToNumber } from '@/sim/core/fx';
import { rebuildGrid } from '@/sim/core/grid';
import { allocateTerrain } from '@/sim/core/terrain';
import { LINE_OF_FIRE_WIDTH, distFx, nearSegment } from '@/sim/core/order';
import { createWorld, getFront, type Front, type World } from '@/sim/core/world';
import { movement } from '@/sim/systems/movement';
import { orderDelivery } from '@/sim/systems/orderDelivery';
import { unitDecision } from '@/sim/systems/unitDecision';

const MAP = 200;
const SWITCH_TICKS = Math.round(cfgNum('order.switchIntervalSec') * TICK_RATE);

function makeWorld(civ: CivId = 'yamato'): World {
  const w = createWorld({
    seed: 7,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 512,
    civs: [civ, 'roma'],
  });
  allocateTerrain(w.map);
  w.map.starts[0] = fxFromInt(20);
  w.map.starts[1] = fxFromInt(20);
  w.map.starts[2] = fxFromInt(180);
  w.map.starts[3] = fxFromInt(180);
  w.players[0]!.frontSlots = 6;
  w.players[1]!.frontSlots = 6;
  return w;
}

/** M8 の代わりに戦域を手で立てる。 */
function makeFront(w: World, owner: number, slot: number, tileX: number, tileY: number): Front {
  const f = getFront(w, owner, slot)!;
  f.active = true;
  f.x = fxFromInt(tileX);
  f.y = fxFromInt(tileY);
  f.radius = fx(cfgNum('front.growMaxRadiusTiles'));
  return f;
}

function putUnit(w: World, id: string, owner: number, tileX: number, tileY: number, frontId = 0): number {
  const d = unitDefById(id);
  const i = entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: d.index,
      x: fxFromInt(tileX),
      y: fxFromInt(tileY),
      hpMax: d.hp,
    })
  );
  w.entities.frontId[i] = frontId;
  return i;
}

function putBuilding(
  w: World,
  id: string,
  owner: number,
  tileX: number,
  tileY: number,
  complete = true
): number {
  const d = buildingDefById(id);
  const i = entityIndex(
    spawnEntity(w.entities, {
      kind: d.kind === 'attachment' ? EntityKind.Attachment : EntityKind.Building,
      owner,
      typeId: d.index,
      x: fxFromInt(tileX),
      y: fxFromInt(tileY),
      hpMax: d.hp,
    })
  );
  w.entities.buildProgress[i] = complete ? PROGRESS_DONE : 0;
  markModifiersDirty(w, owner);
  return i;
}

function research(w: World, p: number, techId: string): void {
  w.players[p]!.researched[techIndex(techId)] = 1;
  markModifiersDirty(w, p);
}

/** 判断 → 移動を n tick 回す（`stepWorld` の 5 → 6 と同じ順序）。 */
function run(w: World, ticks: number): void {
  for (let k = 0; k < ticks; k++) {
    rebuildGrid(w.grid, w.entities, w.tick);
    unitDecision(w);
    movement(w);
    w.tick++;
  }
}

/** その index が評価される tick に合わせて 1 回だけ判断させる。 */
function decideOnce(w: World, i: number): void {
  rebuildGrid(w.grid, w.entities, w.tick);
  w.tick = i % 12;
  unitDecision(w);
}

/** マス単位の距離。 */
function distTiles(w: World, a: number, b: number): number {
  const e = w.entities;
  return fxToNumber(distFx(e.x[a]!, e.y[a]!, e.x[b]!, e.y[b]!));
}

/** 座標（マス）までの距離。 */
function distToTile(w: World, i: number, tileX: number, tileY: number): number {
  const e = w.entities;
  return fxToNumber(distFx(e.x[i]!, e.y[i]!, fxFromInt(tileX), fxFromInt(tileY)));
}

/** 敵を「動かない置物」にする（手動扱いにすると判断エンジンが触らない）。 */
function freeze(w: World, i: number): void {
  w.entities.manual[i] = 1;
}

// ---------------------------------------------------------------------------
// T-M9-06 令 6 種
// ---------------------------------------------------------------------------

describe('T-M9-06: 突撃（前進最大・持ち場 0・最も近い敵）', () => {
  it('止まらずに距離を詰める（20 マス → 5 マス未満）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'charge';
    const me = putUnit(w, 'y-ashigaru', 0, 50, 50, 1);
    const enemy = putUnit(w, 'r-hastati', 1, 70, 50);
    freeze(w, enemy);
    expect(distTiles(w, me, enemy)).toBeCloseTo(20, 1);
    run(w, 700); // 20 マス / 徒歩 ≒ 25 秒
    expect(distTiles(w, me, enemy)).toBeLessThan(5);
  });

  it('最も近い敵を選ぶ（`targetPriority: nearest`）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'charge';
    const me = putUnit(w, 'y-ashigaru', 0, 50, 50, 1);
    const far = putUnit(w, 'r-hastati', 1, 70, 50);
    const near = putUnit(w, 'r-hastati', 1, 58, 50);
    freeze(w, far);
    freeze(w, near);
    decideOnce(w, me);
    expect(w.entities.target[me]).toBe(idOfIndex(w.entities, near));
  });

  it('**射程の有利を捨てて距離を詰める**（遠隔でも目標の足元を目指す）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    const archer = putUnit(w, 'y-yumiashigaru', 0, 50, 50, 1);
    const enemy = putUnit(w, 'r-hastati', 1, 62, 50);
    freeze(w, enemy);
    expect(unitDefById('y-yumiashigaru').range).toBeGreaterThan(0);

    // 突撃: 目標の足元（= 射程ぶん手前で止まらない）
    f.order = 'charge';
    decideOnce(w, archer);
    expect(w.entities.destX[archer]).toBe(fxFromInt(62));

    // 死守（前進 0）: 射程ぶん手前で止まる
    f.order = 'hold';
    decideOnce(w, archer);
    expect(w.entities.destX[archer]).toBeLessThan(fxFromInt(62));
  });
});

describe('T-M9-06: 包囲（兵器が前・歩兵が周囲・兵器が下がると歩兵も下がる）', () => {
  function siegeSetup(): { w: World; ram: number; foot: number; f: Front } {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.orderLower = 'siege';
    const ram = putUnit(w, 'y-seiro', 0, 60, 50, 1);
    const foot = putUnit(w, 'y-ashigaru', 0, 50, 50, 1);
    return { w, ram, foot, f };
  }

  it('歩兵は兵器のそばへ寄る（護衛の重み最大）', () => {
    const { w, ram, foot } = siegeSetup();
    decideOnce(w, foot);
    expect(w.entities.destX[foot]).toBe(w.entities.x[ram]!);
    expect(w.entities.destY[foot]).toBe(w.entities.y[ram]!);
  });

  it('**兵器が下がると歩兵も下がる**（`followSiege`）', () => {
    const { w, ram, foot } = siegeSetup();
    decideOnce(w, foot);
    const before = w.entities.destX[foot]!;
    // 兵器が 20 マス後退する
    w.entities.x[ram] = fxFromInt(40);
    decideOnce(w, foot);
    expect(w.entities.destX[foot]).toBe(fxFromInt(40));
    expect(w.entities.destX[foot]!).toBeLessThan(before);
  });

  it('兵器自身は前進を最優先にする（`siegeLead`。壁・門を狙う）', () => {
    const { w, ram } = siegeSetup();
    const wall = putBuilding(w, 'palisade', 1, 70, 50);
    decideOnce(w, ram);
    expect(w.entities.target[ram]).toBe(idOfIndex(w.entities, wall));
    // 前進が最大なので射程ぶん手前で止まらない（壁の足元まで行く）
    expect(w.entities.destX[ram]).toBe(fxFromInt(70));
  });

  it('投石系の射線に味方を置かない（味方の射線上は減点される）', () => {
    const w = makeWorld('azteca');
    const f = makeFront(w, 0, 1, 50, 50);
    f.orderLower = 'siege';
    const cata = putUnit(w, 'a-catapult', 0, 50, 50, 1);
    const enemy = putUnit(w, 'r-hastati', 1, 70, 50);
    freeze(w, enemy);
    w.entities.target[cata] = idOfIndex(w.entities, enemy);
    expect(unitDefById('a-catapult').traits).toContain('friendly_fire');

    const foot = putUnit(w, 'y-ashigaru', 0, 52, 53, 1);
    decideOnce(w, foot);
    // 選ばれた行き先が射線（投石手 → 目標）の上に乗っていない
    const onLine = nearSegment(
      w.entities.destX[foot]!,
      w.entities.destY[foot]!,
      w.entities.x[cata]!,
      w.entities.y[cata]!,
      w.entities.x[enemy]!,
      w.entities.y[enemy]!,
      LINE_OF_FIRE_WIDTH
    );
    expect(onLine).toBe(false);
  });
});

describe('T-M9-06: 死守（持ち場最大・前進 0・射程内の敵だけ）', () => {
  it('**指定地点から離れない**（20 マス先の敵を追わない）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'hold';
    const me = putUnit(w, 'y-ashigaru', 0, 50, 50, 1);
    const enemy = putUnit(w, 'r-hastati', 1, 70, 50);
    freeze(w, enemy);
    run(w, 200);
    // 持ち場（戦域の中心）から 1 マス以内
    expect(distToTile(w, me, 50, 50)).toBeLessThan(1);
    expect(w.entities.target[me]).toBe(INVALID_ENTITY);
  });

  it('射程内に来た敵は撃つ（`in_range` の加点）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'hold';
    const me = putUnit(w, 'y-yumiashigaru', 0, 50, 50, 1);
    const enemy = putUnit(w, 'r-hastati', 1, 53, 50);
    freeze(w, enemy);
    decideOnce(w, me);
    expect(w.entities.target[me]).toBe(idOfIndex(w.entities, enemy));
    // それでも持ち場からは離れない
    run(w, 60);
    expect(distToTile(w, me, 50, 50)).toBeLessThan(3);
  });

  it('隊列は密集（`formation: dense`）', () => {
    expect(orderDefById('hold').formation).toBe('dense');
  });
});

describe('T-M9-06: 略奪（村人 → 資源施設 → 家。井戸と種籾蔵は狙わない）', () => {
  it('**戦闘ユニットより村人を狙う**（近くにいるのは兵の方でも）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.orderLower = 'raid';
    const me = putUnit(w, 'y-kiba', 0, 50, 50, 1);
    const soldier = putUnit(w, 'r-hastati', 1, 54, 50);
    const villager = putUnit(w, 'villager', 1, 62, 50);
    freeze(w, soldier);
    freeze(w, villager);
    decideOnce(w, me);
    expect(w.entities.target[me]).toBe(idOfIndex(w.entities, villager));
  });

  it('村人がいなければ資源施設 → 家の順', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.orderLower = 'raid';
    const me = putUnit(w, 'y-kiba', 0, 50, 50, 1);
    const house = putBuilding(w, 'house', 1, 54, 50);
    const camp = putBuilding(w, 'lumber_camp', 1, 58, 50);
    decideOnce(w, me);
    expect(w.entities.target[me]).toBe(idOfIndex(w.entities, camp));
    expect(w.entities.target[me]).not.toBe(idOfIndex(w.entities, house));
  });

  it('**井戸・種籾蔵は自動ターゲットに含めない**（§16-7 / `03§3` の掟）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.orderLower = 'raid';
    const me = putUnit(w, 'y-kiba', 0, 50, 50, 1);
    putBuilding(w, 'well', 1, 52, 50);
    putBuilding(w, 'seed_store', 1, 53, 50);
    expect(buildingDefById('well').autoTargetable).toBe(false);
    expect(buildingDefById('seed_store').autoTargetable).toBe(false);
    decideOnce(w, me);
    expect(w.entities.target[me]).toBe(INVALID_ENTITY);
  });
});

describe('T-M9-06: 建設（村人の建てる重み最大・兵は村人の護衛）', () => {
  it('手の空いた村人が建設地へ向かう', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'build';
    const v = putUnit(w, 'villager', 0, 50, 50, 1);
    const site = putBuilding(w, 'watch_tower', 0, 58, 52, false);
    w.entities.state[v] = UnitState.Idle;
    decideOnce(w, v);
    expect(w.entities.destX[v]).toBe(w.entities.x[site]!);
    expect(w.entities.destY[v]).toBe(w.entities.y[site]!);
  });

  it('兵は村人のそばに付く（護衛 0.8）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'build';
    const v = putUnit(w, 'villager', 0, 60, 50, 1);
    putBuilding(w, 'watch_tower', 0, 62, 50, false);
    const soldier = putUnit(w, 'y-ashigaru', 0, 50, 50, 1);
    run(w, 500);
    expect(distTiles(w, soldier, v)).toBeLessThan(3);
  });
});

describe('T-M9-06: 後退（前進を負・被弾回避最大・最寄りの拠点へ）', () => {
  it('**戦いながら最寄りの拠点まで下がる**（拠点までの距離が縮む）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 60, 60);
    f.order = 'retreat';
    const me = putUnit(w, 'y-ashigaru', 0, 60, 60, 1);
    const enemy = putUnit(w, 'r-hastati', 1, 62, 60);
    freeze(w, enemy);
    const before = distToTile(w, me, 20, 20); // 本陣 (20,20)
    run(w, 200);
    const after = distToTile(w, me, 20, 20);
    expect(after).toBeLessThan(before - 5);
  });

  it('前進が負で被弾回避が最大（`orders.json`）', () => {
    const d = orderDefById('retreat');
    expect(d.weights['advance']).toBe(fx(-1));
    expect(d.weights['evade']).toBe(FX_ONE);
    expect(d.formation).toBe('loose');
  });
});

// ---------------------------------------------------------------------------
// T-M9-07 二重旗
// ---------------------------------------------------------------------------

describe('T-M9-07: 二重旗（上段 1 + 下段 1、同段は拒否）', () => {
  /** 令をセットして配達を完了させる。通らなければ false。 */
  function setAndDeliver(w: World, order: OrderId, tier: 'upper' | 'lower'): boolean {
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order, tier }]);
    const f = getFront(w, 0, 1)!;
    if (f.pendingOrder === null) return false;
    const at = f.pendingOrder.deliverAtTick;
    while (w.tick <= at) {
      orderDelivery(w);
      w.tick++;
    }
    return true;
  }

  it('**「死守 + 包囲」が成立する**（完了条件）', () => {
    const w = makeWorld();
    research(w, 0, 'nijuuhata');
    const f = makeFront(w, 0, 1, 30, 30);
    expect(setAndDeliver(w, 'hold', 'upper')).toBe(true);
    w.tick += SWITCH_TICKS;
    expect(setAndDeliver(w, 'siege', 'lower')).toBe(true);
    expect(f.order).toBe('hold');
    expect(f.orderLower).toBe('siege');
  });

  it('**「突撃 + 死守」は拒否される**（同段は重ねられない。上書きになる）', () => {
    const w = makeWorld();
    research(w, 0, 'nijuuhata');
    const f = makeFront(w, 0, 1, 30, 30);
    expect(setAndDeliver(w, 'charge', 'upper')).toBe(true);
    w.tick += SWITCH_TICKS;
    expect(setAndDeliver(w, 'hold', 'upper')).toBe(true);
    // 2 枚にはならない。上段は 1 枚のまま差し替わる。
    expect(f.order).toBe('hold');
    expect(f.orderLower).toBeNull();
    // 段を偽って下段に入れようとしても拒否される
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'lower' }]);
    expect(f.pendingOrder).toBeNull();
  });

  it('二重旗を取るまで下段は使えない', () => {
    const w = makeWorld();
    makeFront(w, 0, 1, 30, 30);
    expect(setAndDeliver(w, 'siege', 'lower')).toBe(false);
    research(w, 0, 'nijuuhata');
    expect(setAndDeliver(w, 'siege', 'lower')).toBe(true);
  });

  it('上段が移動、下段が攻撃目標を担当する（死守 + 包囲の実挙動）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'hold';
    f.orderLower = 'siege';
    const me = putUnit(w, 'y-ashigaru', 0, 50, 50, 1);
    const wall = putBuilding(w, 'palisade', 1, 70, 50);
    freeze(w, wall);
    // 上段の死守で持ち場から離れない（遠い壁には出て行かない）。
    run(w, 300);
    expect(distToTile(w, me, 50, 50)).toBeLessThan(3);
    // 壁が持ち場のそば（射程内）に来れば、下段の対象優先で壁を狙う。
    w.entities.x[wall] = fxFromInt(52);
    decideOnce(w, me);
    expect(w.entities.target[me]).toBe(idOfIndex(w.entities, wall));
  });
});

// ---------------------------------------------------------------------------
// T-M9-08 固有令 8 種
// ---------------------------------------------------------------------------

describe('T-M9-08: 固有令 8 種', () => {
  const UNIQUE: readonly { id: OrderId; civ: CivId; tier: 'upper' | 'lower' }[] = [
    { id: 'jindate', civ: 'yamato', tier: 'upper' },
    { id: 'hojin', civ: 'roma', tier: 'upper' },
    { id: 'kakei', civ: 'tou', tier: 'lower' },
    { id: 'jouriku', civ: 'viking', tier: 'upper' },
    { id: 'koeki', civ: 'mali', tier: 'lower' },
    { id: 'hounou', civ: 'azteca', tier: 'lower' },
    { id: 'assai', civ: 'persia', tier: 'upper' },
    { id: 'yugeki', civ: 'mongol', tier: 'upper' },
  ];

  it('8 件あり、段は `orders.json` / `docs/ISSUES.md` の判断どおり', () => {
    const civOrders = ORDER_DEFS.filter((d) => d.civ !== null);
    expect(civOrders.length).toBe(8);
    for (const u of UNIQUE) {
      const d = orderDefById(u.id);
      expect(d.civ, u.id).toBe(u.civ);
      expect(d.tier, u.id).toBe(u.tier);
      expect(d.key, u.id).toBe(7); // 固有令は全文明とも Shift+7
    }
    // 上段 5 / 下段 3（ISSUES.md の内訳）
    expect(civOrders.filter((d) => d.tier === 'upper').length).toBe(5);
    expect(civOrders.filter((d) => d.tier === 'lower').length).toBe(3);
  });

  it('8 文明それぞれで固有令がセットでき、配達されて発効する', () => {
    for (const u of UNIQUE) {
      const w = makeWorld(u.civ);
      if (u.tier === 'lower') research(w, 0, 'nijuuhata');
      const f = makeFront(w, 0, 1, 30, 30);
      applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: u.id, tier: u.tier }]);
      expect(f.pendingOrder, u.id).not.toBeNull();
      w.tick = f.pendingOrder!.deliverAtTick;
      orderDelivery(w);
      expect(u.tier === 'upper' ? f.order : f.orderLower, u.id).toBe(u.id);
    }
  });

  it('他文明の固有令は使えない', () => {
    const w = makeWorld('roma');
    const f = makeFront(w, 0, 1, 30, 30);
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'yugeki', tier: 'upper' }]);
    expect(f.pendingOrder).toBeNull();
  });

  it('圧壊（ペルシア）は突撃と同じく距離を詰めきる（前進 1.0 / 密集）', () => {
    const w = makeWorld('persia');
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'assai';
    expect(orderDefById('assai').formation).toBe('dense');
    const me = putUnit(w, 'p-gun', 0, 50, 50, 1); // 射程を持つ兵
    const enemy = putUnit(w, 'r-hastati', 1, 60, 50);
    freeze(w, enemy);
    decideOnce(w, me);
    expect(w.entities.destX[me]).toBe(fxFromInt(60)); // 射程ぶん手前で止まらない
  });

  it('遊撃（モンゴル）は村人を狙い、持ち場に縛られない（`crossFront`）', () => {
    const w = makeWorld('mongol');
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'yugeki';
    const me = putUnit(w, 'm-camel', 0, 50, 50, 1);
    const soldier = putUnit(w, 'r-hastati', 1, 54, 50);
    const villager = putUnit(w, 'villager', 1, 75, 50); // 戦域の外
    freeze(w, soldier);
    freeze(w, villager);
    decideOnce(w, me);
    expect(w.entities.target[me]).toBe(idOfIndex(w.entities, villager));
  });

  it('火計（唐）は建物を優先する（下段 = 攻撃目標の令）', () => {
    const w = makeWorld('tou');
    const f = makeFront(w, 0, 1, 50, 50);
    f.orderLower = 'kakei';
    const me = putUnit(w, 't-hosotsu', 0, 50, 50, 1);
    const soldier = putUnit(w, 'r-hastati', 1, 52, 50);
    const house = putBuilding(w, 'house', 1, 60, 50);
    freeze(w, soldier);
    decideOnce(w, me);
    expect(w.entities.target[me]).toBe(idOfIndex(w.entities, house));
  });

  it('陣立て（ヤマト）・方陣（ローマ）・交易（マリ）は持ち場を固める', () => {
    for (const [civ, id, unit] of [
      ['yamato', 'jindate', 'y-ashigaru'],
      ['roma', 'hojin', 'r-hastati'],
      ['mali', 'koeki', 'clubman'],
    ] as const) {
      const w = makeWorld(civ);
      const f = makeFront(w, 0, 1, 50, 50);
      if (orderDefById(id).tier === 'lower') f.orderLower = id;
      else f.order = id;
      const me = putUnit(w, unit, 0, 50, 50, 1);
      const enemy = putUnit(w, 'v-raider', 1, 70, 50);
      freeze(w, enemy);
      run(w, 150);
      // 20 マス先の敵に飛び出さない（持ち場 0.7〜0.8）
      expect(distToTile(w, me, 50, 50), id).toBeLessThan(6);
    }
  });

  it('上陸（ヴァイキング）は前進最大（水辺への強襲）', () => {
    const d = orderDefById('jouriku');
    expect(d.weights['advance']).toBe(FX_ONE);
    expect(d.flags['waterAssault']).toBe(true);
  });

  it('奉納（アステカ）は建物より生きた敵を狙う', () => {
    const w = makeWorld('azteca');
    const f = makeFront(w, 0, 1, 50, 50);
    f.orderLower = 'hounou';
    const me = putUnit(w, 'a-jaguar', 0, 50, 50, 1);
    const soldier = putUnit(w, 'r-hastati', 1, 58, 50);
    putBuilding(w, 'house', 1, 52, 50);
    freeze(w, soldier);
    decideOnce(w, me);
    expect(w.entities.target[me]).toBe(idOfIndex(w.entities, soldier));
  });
});

// ---------------------------------------------------------------------------
// T-M9-09 手動操作と令の共存
// ---------------------------------------------------------------------------

describe('T-M9-09: 手動操作と令の共存（`06§9` 混ぜ方の型）', () => {
  it('**同じ戦域の他の部隊は令のまま動き続ける**（完了条件）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'charge';
    const auto = putUnit(w, 'y-ashigaru', 0, 50, 50, 1);
    const hand = putUnit(w, 'y-kiba', 0, 50, 52, 1);
    const enemy = putUnit(w, 'r-hastati', 1, 70, 50);
    freeze(w, enemy);

    // 騎兵だけを手で選んで別方向へ回り込ませる（`moveUnits` が manual = 1 にする）
    applyCommands(w, [
      {
        t: 'moveUnits',
        p: 0,
        units: [idOfIndex(w.entities, hand)],
        x: fxFromInt(50),
        y: fxFromInt(80),
        queued: false,
      },
    ]);
    expect(w.entities.manual[hand]).toBe(1);

    run(w, 700);
    // 令のままの兵は敵に取り付いている
    expect(distTiles(w, auto, enemy)).toBeLessThan(5);
    // 手動の兵はプレイヤーが指した方へ行った（敵に寄っていない）
    expect(distToTile(w, hand, 50, 80)).toBeLessThan(5);
  });

  it('`Esc`（releaseManual）で令の管理下に戻る', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'charge';
    const hand = putUnit(w, 'y-kiba', 0, 50, 50, 1);
    const enemy = putUnit(w, 'r-hastati', 1, 66, 50);
    freeze(w, enemy);
    w.entities.manual[hand] = 1;
    decideOnce(w, hand);
    expect(w.entities.target[hand]).toBe(INVALID_ENTITY);

    applyCommands(w, [{ t: 'releaseManual', p: 0, units: [idOfIndex(w.entities, hand)] }]);
    expect(w.entities.manual[hand]).toBe(0);
    decideOnce(w, hand);
    expect(w.entities.target[hand]).toBe(idOfIndex(w.entities, enemy));
  });
});
