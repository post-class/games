/**
 * T-M10-05 / 07 / 09 / 11: 収容・堀と跳ね橋・付属物・移動できる発信点
 *
 * 検証（各タスクの完了条件）:
 *  - T-M10-05 **ヤマトの櫓が 5 名（兵）収容できる**。見張り塔は村人だけ。収容中は矢を放つ
 *  - T-M10-07 堀は攻城兵器が通れず、跳ね橋の上だけ通れる（橋を上げると誰も通れない）
 *  - T-M10-09 井戸・種籾蔵が自動で付属し、独立して破壊でき、**自動ターゲットに入らない**
 *  - T-M10-11 大天幕を畳んで動かすと**令の遅延が変わる**
 */

import { describe, expect, it } from 'vitest';
import type { CivId, EntityId } from '@/shared/types';
import { EntityKind, RESOURCE_IDS } from '@/shared/types';
import { fx } from '@/sim/core/fx';
import { createWorld, type World } from '@/sim/core/world';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { UnitState, entityIndex, markDeadIndex, resolveIndex, spawnEntity } from '@/sim/core/entity';
import { isRebuildBlocked } from '@/sim/core/effects';
import { Move, allocateTerrain, isPassableFor } from '@/sim/core/terrain';
import { rebuildGrid } from '@/sim/core/grid';
import { orderDelayTicks } from '@/sim/core/order';
import { frontBaseRadius } from '@/sim/core/front';
import { getFront } from '@/sim/core/world';
import {
  canGarrison,
  digMoat,
  garrisonAllowsOf,
  garrisonUnit,
  garrisonVolley,
  garrisonedUnits,
  isDrawbridgeTile,
  isMoatTile,
  isWheeledPassable,
  lawViolationOnDestroy,
  moveStructure,
  placeDrawbridge,
  releaseGarrison,
  setDrawbridgeLowered,
  tileCenterFx,
} from '@/sim/core/structure';
import { onBuildingDestroyed, spawnBuilding } from '@/sim/systems/construction';
import { recomputeFrontSlots } from '@/sim/systems/production';

function makeWorld(civs: CivId[] = ['yamato'], age = 2): World {
  const w = createWorld({
    seed: 33,
    playerCount: civs.length,
    mapWidthTiles: 64,
    mapHeightTiles: 64,
    civs,
  });
  allocateTerrain(w.map);
  for (let p = 0; p < civs.length; p++) {
    const pl = w.players[p]!;
    pl.age = age;
    pl.popCap = 200;
    for (let r = 0; r < RESOURCE_IDS.length; r++) pl.resources[r] = fx(100000);
  }
  return w;
}

function spawnUnit(w: World, p: number, id: string, tx: number, ty: number): EntityId {
  const def = unitDefById(id);
  return spawnEntity(w.entities, {
    kind: EntityKind.Unit,
    owner: p,
    typeId: def.index,
    x: tileCenterFx(tx),
    y: tileCenterFx(ty),
    hpMax: def.hp,
  });
}

describe('T-M10-05 塔・砲塔・櫓の収容（完了条件: ヤマトの櫓が 5 名収容できる）', () => {
  it('ヤマトの櫓は兵を 5 名まで収容でき、6 人目は入れない', () => {
    const w = makeWorld(['yamato'], 2);
    const tower = spawnBuilding(w, 0, 'yagura', tileCenterFx(20), tileCenterFx(20));
    const cap = buildingDefById('yagura').garrisonCapacity;
    expect(cap).toBe(5);
    expect(garrisonAllowsOf(buildingDefById('yagura').index)).toContain('military');

    for (let k = 0; k < cap; k++) {
      const u = spawnUnit(w, 0, 'y-ashigaru', 21 + k, 20);
      expect(garrisonUnit(w, u, tower), `${k + 1} 人目`).toBe(true);
    }
    const over = spawnUnit(w, 0, 'y-ashigaru', 30, 20);
    expect(garrisonUnit(w, over, tower)).toBe(false);

    const ti = resolveIndex(w.entities, tower);
    expect(w.entities.garrisonCount[ti]!).toBe(cap);
    const list: number[] = [];
    expect(garrisonedUnits(w, ti, list)).toBe(cap);
  });

  it('見張り塔は村人だけ（兵は入れない）', () => {
    const w = makeWorld(['roma'], 2);
    const tower = spawnBuilding(w, 0, 'watch_tower', tileCenterFx(20), tileCenterFx(20));
    const villager = spawnUnit(w, 0, 'villager', 21, 20);
    const soldier = spawnUnit(w, 0, 'r-legion', 21, 21);
    expect(garrisonUnit(w, villager, tower)).toBe(true);
    expect(garrisonUnit(w, soldier, tower)).toBe(false);
  });

  it('攻城兵器は収容できない（城でも）', () => {
    const w = makeWorld(['roma'], 2);
    const castle = spawnBuilding(w, 0, 'castle', tileCenterFx(30), tileCenterFx(30));
    const ram = spawnUnit(w, 0, 'r-ram', 33, 30);
    expect(canGarrison(w, entityIndex(ram), resolveIndex(w.entities, castle))).toBe(false);
  });

  it('収容中の者が塔から矢を放つ（射程内の敵の HP が減る）', () => {
    const w = makeWorld(['yamato', 'roma'], 2);
    const tower = spawnBuilding(w, 0, 'yagura', tileCenterFx(20), tileCenterFx(20));
    const villager = spawnUnit(w, 0, 'villager', 21, 20);
    expect(garrisonUnit(w, villager, tower)).toBe(true);

    const enemy = spawnUnit(w, 1, 'r-legion', 24, 20);
    const ei = resolveIndex(w.entities, enemy);
    const before = w.entities.hp[ei]!;
    for (let t = 0; t < 100; t++) {
      rebuildGrid(w.grid, w.entities, w.tick);
      garrisonVolley(w);
      w.tick += 1;
    }
    expect(w.entities.hp[ei]!).toBeLessThan(before);
  });

  it('塔が壊れると収容していた者は外に出る（永久 Garrisoned にならない）', () => {
    const w = makeWorld(['yamato'], 2);
    const tower = spawnBuilding(w, 0, 'yagura', tileCenterFx(20), tileCenterFx(20));
    const u = spawnUnit(w, 0, 'y-ashigaru', 21, 20);
    garrisonUnit(w, u, tower);
    const ti = resolveIndex(w.entities, tower);
    onBuildingDestroyed(w, ti);
    markDeadIndex(w.entities, ti);
    const ui = resolveIndex(w.entities, u);
    expect(w.entities.state[ui]!).toBe(UnitState.Idle);
    expect(w.entities.garrisonCount[ti]!).toBe(0);
  });

  it('releaseGarrison は中身の人数を返す', () => {
    const w = makeWorld(['yamato'], 2);
    const tower = spawnBuilding(w, 0, 'yagura', tileCenterFx(24), tileCenterFx(24));
    for (let k = 0; k < 3; k++) garrisonUnit(w, spawnUnit(w, 0, 'y-ashigaru', 26 + k, 24), tower);
    expect(releaseGarrison(w, resolveIndex(w.entities, tower))).toBe(3);
  });
});

describe('T-M10-07 堀と跳ね橋（攻城兵器は橋を通るしかない）', () => {
  it('堀は歩兵は渡れるが攻城兵器は通れない', () => {
    const w = makeWorld(['persia'], 2);
    expect(digMoat(w, 10, 10)).toBe(true);
    expect(isMoatTile(w, 10, 10)).toBe(true);
    expect(isPassableFor(w.map, 10, 10, Move.Land)).toBe(true);
    expect(isWheeledPassable(w, 10, 10)).toBe(false);
  });

  it('跳ね橋の上だけ攻城兵器が渡れる。橋を上げると誰も通れない', () => {
    const w = makeWorld(['persia'], 2);
    digMoat(w, 10, 10);
    digMoat(w, 10, 11);
    expect(placeDrawbridge(w, 10, 11)).toBe(true);
    expect(isDrawbridgeTile(w, 10, 11)).toBe(true);
    expect(isWheeledPassable(w, 10, 11)).toBe(true);
    expect(isWheeledPassable(w, 10, 10)).toBe(false);

    expect(setDrawbridgeLowered(w, 10, 11, false)).toBe(true);
    expect(isWheeledPassable(w, 10, 11)).toBe(false);
    expect(isPassableFor(w.map, 10, 11, Move.Land)).toBe(false);

    expect(setDrawbridgeLowered(w, 10, 11, true)).toBe(true);
    expect(isWheeledPassable(w, 10, 11)).toBe(true);
  });

  it('堀の線に橋が 1 本だけあると、攻城兵器の通り道はそこだけになる', () => {
    const w = makeWorld(['persia'], 2);
    for (let ty = 0; ty < 20; ty++) digMoat(w, 15, ty);
    placeDrawbridge(w, 15, 7);
    let open = 0;
    for (let ty = 0; ty < 20; ty++) if (isWheeledPassable(w, 15, ty)) open++;
    expect(open).toBe(1);
  });
});

describe('T-M10-09 付属物（井戸・種籾蔵）', () => {
  it('町の中心に井戸が自動で付き、独立したエンティティになる', () => {
    const w = makeWorld(['yamato'], 2);
    const tc = spawnBuilding(w, 0, 'town_center', tileCenterFx(20), tileCenterFx(20));
    const wellDef = buildingDefById('well');
    let found = -1;
    for (let i = 0; i < w.entities.highWater; i++) {
      if (w.entities.alive[i] !== 1) continue;
      if (w.entities.typeId[i] !== wellDef.index) continue;
      found = i;
    }
    expect(found).toBeGreaterThanOrEqual(0);
    expect(w.entities.kind[found]!).toBe(EntityKind.Attachment);
    expect(w.entities.attachParent[found]!).toBe(tc);
  });

  it('井戸・種籾蔵は「略奪」の令の自動ターゲットに入らない（autoTargetable = false）', () => {
    expect(buildingDefById('well').autoTargetable).toBe(false);
    expect(buildingDefById('seed_store').autoTargetable).toBe(false);
    expect(buildingDefById('well').buildable).toBe(false);
    expect(buildingDefById('seed_store').buildable).toBe(false);
  });

  it('井戸を壊しても親の町の中心は残り、その場所には二度と建てられない', () => {
    const w = makeWorld(['yamato'], 2);
    const tc = spawnBuilding(w, 0, 'town_center', tileCenterFx(20), tileCenterFx(20));
    const wellDef = buildingDefById('well');
    let wi = -1;
    for (let i = 0; i < w.entities.highWater; i++) {
      if (w.entities.alive[i] === 1 && w.entities.typeId[i] === wellDef.index) wi = i;
    }
    const wx = w.entities.x[wi]!;
    const wy = w.entities.y[wi]!;
    onBuildingDestroyed(w, wi);
    markDeadIndex(w.entities, wi);

    expect(w.entities.alive[resolveIndex(w.entities, tc)]).toBe(1);
    // forbidRebuildHere（durationSec -1）なので試合中ずっと建てられない。
    expect(isRebuildBlocked(w, 'house', wx, wy)).toBe(true);
    w.tick += 100000;
    expect(isRebuildBlocked(w, 'house', wx, wy)).toBe(true);
  });

  it('種籾蔵は農地の数面ごとに 1 つ。壊すと一帯の農地が再建できない', () => {
    const w = makeWorld(['yamato'], 2);
    const seedDef = buildingDefById('seed_store');
    const per = 3;
    for (let k = 0; k < per * 2; k++) {
      spawnBuilding(w, 0, 'farm', tileCenterFx(20 + k * 4), tileCenterFx(30));
    }
    let stores = 0;
    let si = -1;
    for (let i = 0; i < w.entities.highWater; i++) {
      if (w.entities.alive[i] === 1 && w.entities.typeId[i] === seedDef.index) {
        stores++;
        si = i;
      }
    }
    expect(stores).toBe(2);

    const sx = w.entities.x[si]!;
    const sy = w.entities.y[si]!;
    onBuildingDestroyed(w, si);
    markDeadIndex(w.entities, si);
    expect(isRebuildBlocked(w, 'farm', sx, sy)).toBe(true);
  });

  it('掟の ID をフック関数で引ける（忠誠度の減算は M11 の担当）', () => {
    expect(lawViolationOnDestroy(buildingDefById('well').index)).toBe('law2');
    expect(lawViolationOnDestroy(buildingDefById('seed_store').index)).toBe('law3');
    expect(lawViolationOnDestroy(buildingDefById('house').index)).toBeNull();
  });
});

describe('T-M10-11 城と大天幕（完了条件: 畳んで動かすと令の遅延が変わる）', () => {
  it('城は戦域スロット +1 かつ令の発信点', () => {
    const w = makeWorld(['roma'], 2);
    recomputeFrontSlots(w, 0);
    const before = w.players[0]!.frontSlots;
    spawnBuilding(w, 0, 'castle', tileCenterFx(30), tileCenterFx(30));
    expect(w.players[0]!.frontSlots).toBe(before + 1);
    expect(buildingDefById('castle').isOrderSource).toBe(true);
  });

  it('大天幕を畳んで戦域へ近づけると令の遅延が短くなる', () => {
    const w = makeWorld(['mongol'], 2);
    // 本陣は (0,0) 側にあるので、遠くに戦域を立てる。
    const f = getFront(w, 0, 1)!;
    f.active = true;
    f.x = tileCenterFx(60);
    f.y = tileCenterFx(60);
    f.radius = frontBaseRadius();

    const tent = spawnBuilding(w, 0, 'great_tent', tileCenterFx(5), tileCenterFx(5));
    const far = orderDelayTicks(w, f);

    expect(moveStructure(w, tent, tileCenterFx(56), tileCenterFx(56))).toBe(true);
    const near = orderDelayTicks(w, f);
    expect(near).toBeLessThan(far);
  });

  it('畳めるのは movable な建物だけ（城は動かせない）', () => {
    const w = makeWorld(['roma'], 2);
    const castle = spawnBuilding(w, 0, 'castle', tileCenterFx(30), tileCenterFx(30));
    expect(moveStructure(w, castle, tileCenterFx(40), tileCenterFx(40))).toBe(false);
    expect(buildingDefById('great_tent').movable).toBe(true);
    // 耐久は城の 60%
    expect(buildingDefById('great_tent').hp).toBe(
      Math.round(buildingDefById('castle').hp * 0.6)
    );
  });
});
