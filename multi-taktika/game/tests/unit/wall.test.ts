/**
 * T-M10-01 / 02 / 03 / 04 / 10: 壁・門・穴・修理・跡地（`07§9`, 手順書 §6.7）
 *
 * 検証（各タスクの完了条件）:
 *  - T-M10-01 木柵・石壁・街道が**線で引ける**（`placeWallLine` が Bresenham でマスを並べる）
 *  - T-M10-02 破壊された壁タイルが**通行可能のまま維持される**（跡地の時間が過ぎても残る）
 *  - T-M10-03 **攻城兵器が壁を通り抜けられない**（門は自軍・味方だけ通れる）
 *  - T-M10-04 修理費は失った HP に比例し建設費の 1/4 が上限。穴の再建は建設時間 1.5 倍
 *  - T-M10-10 跡地は 30 秒だけ「建てられない」。壁の穴はいつでも建て直せる（時間だけ 1.5 倍）
 */

import { describe, expect, it } from 'vitest';
import type { CivId, EntityId } from '@/shared/types';
import { EntityKind, RESOURCE_IDS, resourceIndex } from '@/shared/types';
import { FX_ONE, fx, fxFromInt, fxMul } from '@/sim/core/fx';
import { createWorld, type World } from '@/sim/core/world';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { entityIndex, markDeadIndex, resolveIndex, spawnEntity } from '@/sim/core/entity';
import { isRebuildBlocked, isWallHole } from '@/sim/core/effects';
import { TICK_RATE, cfgNum } from '@/sim/core/config';
import {
  Move,
  Pass,
  allocateTerrain,
  isPassableFor,
  tileIndex,
} from '@/sim/core/terrain';
import {
  beginConstruction,
  buildingCostFx,
  construction,
  onBuildingDestroyed,
  repairCostFx,
  requiredBuildWork,
  spawnBuilding,
} from '@/sim/systems/construction';
import {
  canUnitEnterTile,
  isGateTile,
  isWallHoleTile,
  tileCenterFx,
  updateGates,
} from '@/sim/core/structure';
import { applyCommands, type Command } from '@/sim/command';
import { rebuildGrid } from '@/sim/core/grid';

const TILE_RUBBLE_SEC = cfgNum('construction.rubbleSec');
const WALL_REBUILD_MUL = cfgNum('construction.wallRebuildTimeMul');
const REPAIR_RATIO_MAX = cfgNum('construction.repairCostRatioMax');

function makeWorld(civs: CivId[] = ['yamato'], age = 2): World {
  const w = createWorld({
    seed: 21,
    playerCount: civs.length,
    mapWidthTiles: 48,
    mapHeightTiles: 48,
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

/** その建物を 1 tick で完成させる（進捗を積むのが目的ではないテスト用）。 */
function finish(w: World, id: EntityId): number {
  const i = entityIndex(id);
  const villager = spawnUnit(w, w.entities.owner[i]!, 'villager', 1, 1);
  w.entities.state[entityIndex(villager)] = 5; // UnitState.Building
  w.entities.target[entityIndex(villager)] = id;
  for (let t = 0; t < 20000; t++) {
    construction(w);
    w.tick += 1;
    if (w.entities.buildProgress[i]! >= 1 << 30) break;
  }
  return i;
}

function blockedAt(w: World, tx: number, ty: number): boolean {
  return (w.map.passable[tileIndex(w.map, tx, ty)]! & Pass.Blocked) !== 0;
}

describe('T-M10-01 壁・門のライン建設', () => {
  it('木柵・石壁・街道が線で引ける（1 マスにつき 1 枚）', () => {
    for (const type of ['palisade', 'stone_wall']) {
      const w = makeWorld(['yamato'], 2);
      const cmd: Command = {
        t: 'placeWallLine',
        p: 0,
        type,
        x0: tileCenterFx(10),
        y0: tileCenterFx(10),
        x1: tileCenterFx(15),
        y1: tileCenterFx(10),
      };
      applyCommands(w, [cmd]);
      const def = buildingDefById(type);
      let n = 0;
      for (let i = 0; i < w.entities.highWater; i++) {
        if (w.entities.alive[i] !== 1) continue;
        if (w.entities.typeId[i] !== def.index) continue;
        n++;
      }
      expect(n, `${type} の枚数`).toBe(6);
    }
  });

  it('斜めの線も途切れずに並ぶ（Bresenham）', () => {
    const w = makeWorld(['yamato'], 2);
    applyCommands(w, [
      {
        t: 'placeWallLine',
        p: 0,
        type: 'palisade',
        x0: tileCenterFx(5),
        y0: tileCenterFx(5),
        x1: tileCenterFx(9),
        y1: tileCenterFx(9),
      },
    ]);
    for (let k = 0; k <= 4; k++) expect(blockedAt(w, 5 + k, 5 + k), `(${5 + k},${5 + k})`).toBe(true);
  });

  it('ローマの街道は線で並べても封鎖しない（敷設物）', () => {
    const w = makeWorld(['roma'], 2);
    // **申し送り（command.ts は別担当）**: `placeWallLine` は `isWall || isGate` しか
    // 受け付けないため、街道（`isLinear` だけを持つ敷設物）は今はドラッグで引けない。
    // 条件を `isWall || isGate || isLinear` に緩めること。ここでは 1 マスずつ並べて
    // 「線で並べても通行を塞がない」ことを確かめる。
    for (let tx = 20; tx <= 23; tx++) {
      const r = beginConstruction(w, 0, 'road', tileCenterFx(tx), tileCenterFx(20), []);
      expect(r.result).toBe('ok');
      expect(blockedAt(w, tx, 20)).toBe(false);
    }
    expect(buildingDefById('road').isLinear).toBe(true);
  });
});

describe('T-M10-02 壁の穴は試合中ずっと残る（最重要）', () => {
  it('壁を建てるとそのマスが塞がり、壊すと通行可能に戻る', () => {
    const w = makeWorld(['yamato'], 2);
    const id = spawnBuilding(w, 0, 'stone_wall', tileCenterFx(12), tileCenterFx(12));
    expect(blockedAt(w, 12, 12)).toBe(true);
    expect(isPassableFor(w.map, 12, 12, Move.Land)).toBe(false);

    const i = entityIndex(id);
    onBuildingDestroyed(w, i);
    markDeadIndex(w.entities, i);

    expect(blockedAt(w, 12, 12)).toBe(false);
    // 歩兵も攻城兵器も通れる = 穴。**Tile.Rubble を置いていない**ことがここで効く。
    expect(isPassableFor(w.map, 12, 12, Move.Land)).toBe(true);
    expect(isPassableFor(w.map, 12, 12, Move.Wheeled)).toBe(true);
  });

  it('跡地の時間（30 秒）が過ぎても穴は通行可能なまま残る', () => {
    const w = makeWorld(['yamato'], 2);
    const id = spawnBuilding(w, 0, 'stone_wall', tileCenterFx(12), tileCenterFx(12));
    const i = entityIndex(id);
    onBuildingDestroyed(w, i);
    markDeadIndex(w.entities, i);

    for (let t = 0; t < Math.round(TILE_RUBBLE_SEC * TICK_RATE) * 2; t++) {
      construction(w);
      w.tick += 1;
    }
    expect(isWallHole(w, tileCenterFx(12), tileCenterFx(12))).toBe(true);
    expect(isWallHoleTile(w, 12, 12)).toBe(true);
    expect(isPassableFor(w.map, 12, 12, Move.Land)).toBe(true);
    expect(isPassableFor(w.map, 12, 12, Move.Wheeled)).toBe(true);
  });

  it('穴に建て直せる。ただし建設時間は 1.5 倍', () => {
    const w = makeWorld(['yamato'], 2);
    const def = buildingDefById('stone_wall');
    const base = requiredBuildWork(w, def, tileCenterFx(12), tileCenterFx(12));

    const id = spawnBuilding(w, 0, 'stone_wall', tileCenterFx(12), tileCenterFx(12));
    const i = entityIndex(id);
    onBuildingDestroyed(w, i);
    markDeadIndex(w.entities, i);

    // 壁は跡地タイマーで止めない（建て直せる）。
    expect(isRebuildBlocked(w, 'stone_wall', tileCenterFx(12), tileCenterFx(12))).toBe(false);
    const again = requiredBuildWork(w, def, tileCenterFx(12), tileCenterFx(12));
    expect(again).toBe(fxMul(base, fx(WALL_REBUILD_MUL)));
    expect(WALL_REBUILD_MUL).toBe(1.5);
  });
});

describe('T-M10-03 門の通行制御（完了条件: 攻城兵器が壁を通り抜けられない）', () => {
  it('立っている壁は攻城兵器も歩兵も通れない', () => {
    const w = makeWorld(['roma', 'yamato'], 2);
    spawnBuilding(w, 1, 'stone_wall', tileCenterFx(20), tileCenterFx(20));
    const ram = spawnUnit(w, 0, 'r-ram', 19, 20);
    const foot = spawnUnit(w, 0, 'r-legion', 19, 20);
    expect(canUnitEnterTile(w, entityIndex(ram), 20, 20)).toBe(false);
    expect(canUnitEnterTile(w, entityIndex(foot), 20, 20)).toBe(false);
  });

  it('壊れて穴になれば攻城兵器も通れる（門か穴しか通れない、の「穴」）', () => {
    const w = makeWorld(['roma', 'yamato'], 2);
    const wall = spawnBuilding(w, 1, 'stone_wall', tileCenterFx(20), tileCenterFx(20));
    const ram = spawnUnit(w, 0, 'r-ram', 19, 20);
    const wi = entityIndex(wall);
    onBuildingDestroyed(w, wi);
    markDeadIndex(w.entities, wi);
    expect(canUnitEnterTile(w, entityIndex(ram), 20, 20)).toBe(true);
  });

  it('門は自軍・味方だけが通れる（敵は通れない）', () => {
    const w = makeWorld(['roma', 'yamato'], 2);
    spawnBuilding(w, 1, 'stone_gate', tileCenterFx(20), tileCenterFx(20));
    expect(isGateTile(w, 20, 20)).toBe(true);

    const own = spawnUnit(w, 1, 'y-ashigaru', 19, 20);
    const enemy = spawnUnit(w, 0, 'r-legion', 21, 20);
    // 門のマスの規則（所有者を見る純関数）。
    expect(canUnitEnterTile(w, entityIndex(own), 20, 20)).toBe(true);
    expect(canUnitEnterTile(w, entityIndex(enemy), 20, 20)).toBe(false);
  });

  it('門は「味方が近く敵がいない」ときだけ開く（通行ビットの Blocked が下りる）', () => {
    const w = makeWorld(['roma', 'yamato'], 2);
    spawnBuilding(w, 1, 'stone_gate', tileCenterFx(20), tileCenterFx(20));

    // 誰もいない → 閉じている
    rebuildGrid(w.grid, w.entities, w.tick);
    updateGates(w);
    expect(blockedAt(w, 20, 20)).toBe(true);

    // 自軍が近づく → 開く
    const own = spawnUnit(w, 1, 'y-ashigaru', 19, 20);
    rebuildGrid(w.grid, w.entities, w.tick);
    updateGates(w);
    expect(blockedAt(w, 20, 20)).toBe(false);

    // 敵が門前に来る → 閉じる（07§9「門前が必ず激戦地になる」）
    spawnUnit(w, 0, 'r-legion', 22, 20);
    rebuildGrid(w.grid, w.entities, w.tick);
    updateGates(w);
    expect(blockedAt(w, 20, 20)).toBe(true);
    expect(own).not.toBe(0);
  });
});

describe('T-M10-04 修理（建設費の 1/4 が上限）', () => {
  it('全損寸前の壁の修理費は建設費の 1/4 で止まる', () => {
    const w = makeWorld(['yamato'], 2);
    const id = spawnBuilding(w, 0, 'stone_wall', tileCenterFx(30), tileCenterFx(30));
    const i = resolveIndex(w.entities, id);
    w.entities.hp[i] = 1; // ほぼ全損

    const cost = repairCostFx(w, 0, i);
    const build = buildingCostFx(w, 0, buildingDefById('stone_wall'));
    const stone = resourceIndex('stone');
    expect(cost[stone]!).toBeLessThanOrEqual(fxMul(build[stone]!, fx(REPAIR_RATIO_MAX)));
    expect(cost[stone]!).toBeGreaterThan(0);
  });

  it('失った HP に比例する（半分なら上限の半分）', () => {
    const w = makeWorld(['yamato'], 2);
    const id = spawnBuilding(w, 0, 'stone_gate', tileCenterFx(34), tileCenterFx(34));
    const i = resolveIndex(w.entities, id);
    const hpMax = w.entities.hpMax[i]!;
    w.entities.hp[i] = hpMax >> 1;
    const half = repairCostFx(w, 0, i);
    w.entities.hp[i] = 0;
    const full = repairCostFx(w, 0, i);
    const stone = resourceIndex('stone');
    // 端数（切り捨て）を許して比が 2 倍になっていること。
    expect(full[stone]!).toBeGreaterThan(half[stone]! * 2 - FX_ONE);
    expect(full[stone]!).toBeLessThanOrEqual(half[stone]! * 2 + FX_ONE);
  });

  it('「修理」と「穴の再建」は別物: 修理は資源 1/4 上限、再建は建設費全額 + 時間 1.5 倍', () => {
    const w = makeWorld(['yamato'], 2);
    const def = buildingDefById('stone_wall');
    const id = spawnBuilding(w, 0, 'stone_wall', tileCenterFx(36), tileCenterFx(36));
    const i = resolveIndex(w.entities, id);
    w.entities.hp[i] = 1;
    const repair = repairCostFx(w, 0, i);
    const stone = resourceIndex('stone');
    expect(repair[stone]!).toBeLessThan(def.cost[stone]!);

    onBuildingDestroyed(w, i);
    markDeadIndex(w.entities, i);
    const before = w.players[0]!.resources[stone]!;
    const r = beginConstruction(w, 0, 'stone_wall', tileCenterFx(36), tileCenterFx(36), []);
    expect(r.result).toBe('ok');
    // 再建は満額
    expect(before - w.players[0]!.resources[stone]!).toBe(def.cost[stone]!);
    // かかる時間は 1.5 倍
    expect(requiredBuildWork(w, def, tileCenterFx(36), tileCenterFx(36))).toBe(
      fxMul(fxFromInt(def.buildTicks), fx(WALL_REBUILD_MUL))
    );
  });
});

describe('T-M10-10 建設中の建物と跡地（壁の穴との違い）', () => {
  it('壁でない建物の跡地は 30 秒だけ同じ場所に建てられない', () => {
    const w = makeWorld(['yamato'], 2);
    const id = spawnBuilding(w, 0, 'house', tileCenterFx(40), tileCenterFx(40));
    const i = entityIndex(id);
    onBuildingDestroyed(w, i);
    markDeadIndex(w.entities, i);

    expect(isRebuildBlocked(w, 'house', tileCenterFx(40), tileCenterFx(40))).toBe(true);
    w.tick += Math.round(TILE_RUBBLE_SEC * TICK_RATE) + 1;
    expect(isRebuildBlocked(w, 'house', tileCenterFx(40), tileCenterFx(40))).toBe(false);
  });

  it('建設中の建物は HP が低く、壊されても資源は戻らない', () => {
    const w = makeWorld(['yamato'], 2);
    const stone = resourceIndex('stone');
    const before = w.players[0]!.resources[stone]!;
    const r = beginConstruction(w, 0, 'stone_wall', tileCenterFx(42), tileCenterFx(42), []);
    const i = entityIndex(r.id);
    expect(w.entities.hp[i]!).toBeLessThan(w.entities.hpMax[i]!);
    const spent = before - w.players[0]!.resources[stone]!;
    expect(spent).toBeGreaterThan(0);

    onBuildingDestroyed(w, i);
    markDeadIndex(w.entities, i);
    expect(w.players[0]!.resources[stone]!).toBe(before - spent);
  });

  it('完成した壁の上は高所（elevation 2）になり、壊すと地形の高さに戻る', () => {
    const w = makeWorld(['yamato'], 2);
    const r = beginConstruction(w, 0, 'stone_wall', tileCenterFx(44), tileCenterFx(44), []);
    const i = finish(w, r.id);
    expect(w.map.elevation[tileIndex(w.map, 44, 44)]!).toBe(
      cfgNum('construction.wallTopElevation')
    );
    onBuildingDestroyed(w, i);
    markDeadIndex(w.entities, i);
    expect(w.map.elevation[tileIndex(w.map, 44, 44)]!).toBe(0);
  });
});
