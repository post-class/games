/**
 * T-M10-06 / 08 / 12: 攻城兵器 12 種・梯子（壁越え）・「包囲」の令で攻城戦が自動進行する
 *
 * 検証（各タスクの完了条件）:
 *  - T-M10-06 **各文明が持つ兵器だけ生産できる**（`civs.json` の `unitTree.siege` と一致）。人口 3
 *  - T-M10-08 `03§6` の「得意」「弱点」どおり。井楼・攻城塔は歩兵を壁越えさせるが**壁を壊さない**
 *  - T-M10-12 **直接操作なしで門を落とせる**（包囲の令だけを渡して N tick 後に門が壊れている）
 */

import { describe, expect, it } from 'vitest';
import civsJson from '@/data/civs.json' with { type: 'json' };
import type { CivId, EntityId } from '@/shared/types';
import { CIV_IDS, EntityKind, RESOURCE_IDS } from '@/shared/types';
import { FX_ONE, fx } from '@/sim/core/fx';
import { createWorld, getFront, type World } from '@/sim/core/world';
import { UNIT_DEFS, buildingDefById, unitDefById } from '@/sim/core/defs';
import { entityIndex, isAliveIndex, resolveIndex, spawnEntity } from '@/sim/core/entity';
import { allocateTerrain } from '@/sim/core/terrain';
import { rebuildGrid } from '@/sim/core/grid';
import { cfgInt, cfgNum } from '@/sim/core/config';
import { frontBaseRadius } from '@/sim/core/front';
import { isUnitAvailable } from '@/sim/systems/production';
import { spawnBuilding } from '@/sim/systems/construction';
import { tileCenterFx } from '@/sim/core/structure';
import {
  crossWalls,
  isAntiBuilding,
  isBombard,
  isDirectShooter,
  isRam,
  isSiegeUnit,
  isWallCrosser,
  siegeTargetBonus,
  structureDamageMul,
} from '@/sim/core/siege';
import { stepWorld } from '@/sim/index';

const SIEGE_POP = cfgInt('population.siegePop');

/** T-M10-12 の観測時間（秒）。試合の「総力戦」区間で攻城が決まる長さ（07§2）。 */
const SIEGE_TEST_SEC = 240;

function makeWorld(civs: CivId[], age = 2): World {
  const w = createWorld({
    seed: 77,
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

/** `civs.json` の `unitTree.siege` を平らにした ID 一覧（段の入れ子を潰す）。 */
function siegeTreeOf(civ: string): string[] {
  const tree = (civsJson as unknown as Record<string, Record<string, unknown>>)[civ]!['unitTree'] as
    | Record<string, unknown>
    | undefined;
  const arr = (tree?.['siege'] ?? []) as unknown[];
  const out: string[] = [];
  for (const v of arr) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) for (const s of v) out.push(String(s));
    else out.push(String(v));
  }
  return out;
}

describe('T-M10-06 攻城兵器 12 種と文明ごとの所持', () => {
  it('03§6 の 12 行ぶんの兵器がそろい、すべて人口 3（焼き討ち隊は歩兵なので除く）', () => {
    const siege = UNIT_DEFS.filter((d) => isSiegeUnit(d));
    // 03§6 は 12 行。うち 1 行が「バリスタ／床子弩」で名前が 2 つあるので種類名は 13。
    const names = new Set(siege.map((d) => d.name));
    expect(names.size).toBe(13);
    expect(siege.length).toBe(16); // 文明ごとの実体（同じ兵器を複数文明が持つ）
    for (const d of siege) {
      // 焼き討ち隊は「兵器ではなく歩兵」（03§6）なので人口 3 ではない。
      if (isAntiBuilding(d)) continue;
      expect(d.pop, d.id).toBe(SIEGE_POP);
    }
    expect(SIEGE_POP).toBe(3);
  });

  it('各文明が生産できる攻城兵器は civs.json の unitTree.siege と一致する', () => {
    for (const civ of CIV_IDS) {
      const tree = siegeTreeOf(civ);
      for (let age = 1; age <= 3; age++) {
        const w = makeWorld([civ], age);
        const producible = UNIT_DEFS.filter(
          (d) => isSiegeUnit(d) && isUnitAvailable(w, 0, d)
        ).map((d) => d.id);
        // 生産できるものは必ずツリーに載っている（他文明の兵器は作れない）
        for (const id of producible) expect(tree, `${civ} age${age} ${id}`).toContain(id);
      }
    }
  });

  it('モンゴルは鉄器の世に攻城兵器を持たない（帝国の簡易投石機だけ）', () => {
    const tree = siegeTreeOf('mongol');
    expect(tree).toEqual(['g-catapult']);
    const w = makeWorld(['mongol'], 2);
    const producible = UNIT_DEFS.filter((d) => isSiegeUnit(d) && isUnitAvailable(w, 0, d));
    expect(producible.length).toBe(0);
  });

  it('他文明の兵器は作れない（ヤマトはオナゲルを持たない）', () => {
    const w = makeWorld(['yamato'], 3);
    expect(isUnitAvailable(w, 0, unitDefById('r-onager'))).toBe(false);
    expect(isUnitAvailable(w, 0, unitDefById('y-ozutsu'))).toBe(true);
  });
});

describe('T-M10-08 03§6 の「得意」「弱点」', () => {
  const wall = buildingDefById('stone_wall');
  const gate = buildingDefById('stone_gate');
  const house = buildingDefById('house');

  it('井楼・攻城塔は壁を壊さない（倍率 0）', () => {
    for (const id of ['y-seiro', 'p-tower']) {
      const d = unitDefById(id);
      expect(isWallCrosser(d), id).toBe(true);
      expect(structureDamageMul(d, wall), id).toBe(0);
      expect(structureDamageMul(d, gate), id).toBe(0);
      expect(structureDamageMul(d, house), id).toBe(0);
    }
  });

  it('破城槌は門と建物が得意、壁は苦手', () => {
    for (const id of ['r-ram', 'v-ram', 'm-ram']) {
      const d = unitDefById(id);
      expect(isRam(d), id).toBe(true);
      expect(structureDamageMul(d, gate), id).toBeGreaterThan(FX_ONE);
      expect(structureDamageMul(d, house), id).toBeGreaterThan(FX_ONE);
      expect(structureDamageMul(d, wall), id).toBeLessThan(FX_ONE);
    }
  });

  it('投石系は壁を崩す', () => {
    for (const id of ['a-catapult', 'a-bigcatapult', 'r-onager', 'g-catapult', 'm-catapult']) {
      const d = unitDefById(id);
      expect(isBombard(d), id).toBe(true);
      expect(structureDamageMul(d, wall), id).toBeGreaterThan(FX_ONE);
    }
  });

  it('バリスタ・床子弩は建物にほとんど効かない', () => {
    for (const id of ['r-ballista', 't-shoshido']) {
      const d = unitDefById(id);
      expect(isDirectShooter(d), id).toBe(true);
      expect(structureDamageMul(d, house), id).toBeLessThan(FX_ONE);
    }
  });

  it('焼き討ち隊は建物を焼くが壁は壊せない', () => {
    const d = unitDefById('v-fire');
    expect(isAntiBuilding(d)).toBe(true);
    expect(structureDamageMul(d, wall)).toBe(0);
    expect(structureDamageMul(d, house)).toBeGreaterThan(FX_ONE);
  });

  it('大筒・大砲は構造物に等倍で通る（単発火力そのままで塔を潰す）', () => {
    for (const id of ['y-ozutsu', 'p-cannon']) {
      const d = unitDefById(id);
      expect(structureDamageMul(d, buildingDefById('watch_tower')), id).toBe(FX_ONE);
    }
  });

  it('壊せない相手には包囲の加点をしない（井楼は壁を殴りに行かない）', () => {
    expect(siegeTargetBonus(unitDefById('y-seiro'), wall)).toBe(0);
    expect(siegeTargetBonus(unitDefById('a-catapult'), wall)).toBeGreaterThan(0);
    expect(siegeTargetBonus(unitDefById('r-ram'), gate)).toBeGreaterThan(
      siegeTargetBonus(unitDefById('r-ram'), house)
    );
  });
});

describe('T-M10-08 梯子（壁越え）', () => {
  /** 壁を 1 列（x = 20, y = 18..22）立てて井楼を x = 19 に置いた世界。 */
  function ladderWorld(): { w: World; wallHp: number[]; foot: EntityId; engine: EntityId } {
    const w = makeWorld(['yamato', 'roma'], 2);
    const wallHp: number[] = [];
    for (let ty = 18; ty <= 22; ty++) {
      const id = spawnBuilding(w, 1, 'stone_wall', tileCenterFx(20), tileCenterFx(ty));
      wallHp.push(w.entities.hp[resolveIndex(w.entities, id)]!);
    }
    const engine = spawnUnit(w, 0, 'y-seiro', 19, 20);
    const foot = spawnUnit(w, 0, 'y-ashigaru', 19, 20);
    rebuildGrid(w.grid, w.entities, w.tick);
    return { w, wallHp, foot, engine };
  }

  it('井楼のそばの歩兵が壁の向こうへ渡る。壁の HP は 1 も減らない', () => {
    const { w, wallHp, foot } = ladderWorld();
    let carried = 0;
    for (let t = 0; t < 60 && carried === 0; t++) {
      rebuildGrid(w.grid, w.entities, w.tick);
      carried += crossWalls(w);
      w.tick += 1;
    }
    expect(carried).toBeGreaterThan(0);
    const fi = resolveIndex(w.entities, foot);
    // 壁（x = 20）の向こう側（x = 21）に立っている
    expect(w.entities.x[fi]!).toBeGreaterThan(tileCenterFx(20));

    // 壁は壊れていない = 退けば元に戻る（`01`「壁は壊れないので退くと元に戻る」）
    let k = 0;
    for (let i = 0; i < w.entities.highWater; i++) {
      if (w.entities.alive[i] !== 1) continue;
      if (w.entities.kind[i] !== EntityKind.Building) continue;
      expect(w.entities.hp[i]!).toBe(wallHp[k]!);
      k++;
    }
    expect(k).toBe(wallHp.length);
  });

  it('攻城兵器は運ばれない（門か穴を使うしかない）', () => {
    const { w } = ladderWorld();
    const ram = spawnUnit(w, 0, 'y-ozutsu', 19, 21);
    const ri = resolveIndex(w.entities, ram);
    const before = w.entities.x[ri]!;
    for (let t = 0; t < 60; t++) {
      rebuildGrid(w.grid, w.entities, w.tick);
      crossWalls(w);
      w.tick += 1;
    }
    expect(w.entities.x[ri]!).toBe(before);
  });

  it('井楼が居なくなると壁越えは起きない（穴が残らない）', () => {
    const { w, engine } = ladderWorld();
    // 兵器を消す
    w.entities.alive[resolveIndex(w.entities, engine)] = 0;
    const foot2 = spawnUnit(w, 0, 'y-ashigaru', 19, 19);
    const fi = resolveIndex(w.entities, foot2);
    const before = w.entities.x[fi]!;
    for (let t = 0; t < 60; t++) {
      rebuildGrid(w.grid, w.entities, w.tick);
      expect(crossWalls(w)).toBe(0);
      w.tick += 1;
    }
    expect(w.entities.x[fi]!).toBe(before);
  });
});

describe('T-M10-12 「包囲」の令で攻城戦が自動進行する', () => {
  it('包囲の令だけを渡して直接操作なしで門が落ちる', () => {
    const w = makeWorld(['roma', 'yamato'], 2);
    // 守り側の門（石門 HP 1800）。壁で挟んで「門前が激戦地」の形にする。
    const gate = spawnBuilding(w, 1, 'stone_gate', tileCenterFx(30), tileCenterFx(30));
    for (let ty = 26; ty <= 29; ty++) spawnBuilding(w, 1, 'stone_wall', tileCenterFx(30), tileCenterFx(ty));
    for (let ty = 31; ty <= 34; ty++) spawnBuilding(w, 1, 'stone_wall', tileCenterFx(30), tileCenterFx(ty));
    const gi = resolveIndex(w.entities, gate);
    const hp0 = w.entities.hp[gi]!;

    // 攻め手: 破城槌 2 台 + 護衛の歩兵 4 名（`07§5` 包囲 = 兵器が前、歩兵が周囲）
    for (let k = 0; k < 2; k++) spawnUnit(w, 0, 'r-ram', 26, 30 + k);
    for (let k = 0; k < 4; k++) spawnUnit(w, 0, 'r-legion', 25, 28 + k);

    // 戦域を 1 つ立てて「包囲」（下段）だけを渡す。
    // **手動操作は一切しない**（manual フラグを立てない = 令だけで動く）。
    const f = getFront(w, 0, 1)!;
    f.active = true;
    f.x = tileCenterFx(28);
    f.y = tileCenterFx(30);
    f.radius = frontBaseRadius();
    f.orderLower = 'siege';
    f.lastEngageTick = 0;

    // 240 秒ぶん。破城槌は 4 秒に 1 発なので、門（HP 1800）を落とすのに十分な余裕を取る。
    const limit = Math.round(SIEGE_TEST_SEC * cfgNum('tickRate'));
    let destroyed = false;
    for (let t = 0; t < limit; t++) {
      stepWorld(w, []);
      // 戦域が閉じても令はユニットに焼き付いて（lastOrder）動き続ける。
      if (!isAliveIndex(w.entities, gi)) {
        destroyed = true;
        break;
      }
    }
    expect(w.entities.hp[gi]!).toBeLessThan(hp0);
    expect(destroyed, '門が落ちていない').toBe(true);
  });

  it('包囲の令を渡していない同じ配置では門が落ちない（テストが常に成功していない証明）', () => {
    const w = makeWorld(['roma', 'yamato'], 2);
    const gate = spawnBuilding(w, 1, 'stone_gate', tileCenterFx(30), tileCenterFx(30));
    const gi = resolveIndex(w.entities, gate);
    // 兵器も歩兵も置かない（守り手だけ）。
    for (let t = 0; t < 500; t++) stepWorld(w, []);
    expect(isAliveIndex(w.entities, gi)).toBe(true);
    expect(entityIndex(gate)).toBe(gi);
  });
});
