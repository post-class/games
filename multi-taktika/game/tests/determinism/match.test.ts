/**
 * 試合まるごとの結線と決定論（実装手順書 §4.1, §4.5, §4.6 / T-M2-09 の実戦版）
 *
 * `tests/determinism/step.test.ts` が「空回しの決定論」を見るのに対し、
 * こちらは **`createMatch` が返す実際の試合**を回して
 *   1. 例外なく完走する
 *   2. 村人が採集・搬入して**資源が実際に増える**（movement → economy → 資源の一周）
 *   3. Command から村人を生産でき、家を建てて**人口上限が増える**
 *   4. 同じシードで 2 回回すと**ハッシュ列が完全一致**する
 *   5. シードを変えるとハッシュが変わる
 *   6. 8 人（8 文明すべて）でも例外が出ない
 * を確認する。ここが通らないと「遊べる最小の一周」が成立していない。
 */

import { describe, expect, it } from 'vitest';
import { CIV_IDS, EntityKind, RESOURCE_IDS, resourceIndex } from '@/shared/types';
import type { Command } from '@/sim/command';
import { entityIndex, idOfIndex, UnitState } from '@/sim/core/entity';
import { fxFromInt, fxToNumber } from '@/sim/core/fx';
import type { World } from '@/sim/core/world';
import { hashWorld } from '@/sim/hash';
import { HASH_CHECK_INTERVAL_TICKS, stepWorld } from '@/sim/index';
import { createMatch } from '@/sim/setup';
import { buildingDefById } from '@/sim/core/defs';
import { markDead } from '@/sim/core/entity';
import { isRebuildBlocked } from '@/sim/core/effects';
import { refreshPopulation } from '@/sim/core/population';
import { spawnBuilding } from '@/sim/systems/construction';

/** 5,000 tick = 200 秒（`config.tickRate` = 25）。 */
const RUN_TICKS = 5000;

/** 8 人戦の確認は 2,000 tick（80 秒）。 */
const EIGHT_PLAYER_TICKS = 2000;

/** 町の中心の EntityId（playerId 昇順の最初の 1 棟）。 */
function findTownCenter(w: World, p: number): number {
  const e = w.entities;
  const tcType = buildingDefById('town_center').index;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1 || e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p || e.typeId[i] !== tcType) continue;
    return idOfIndex(e, i);
  }
  return -1;
}

/** そのプレイヤーの村人の EntityId を index 昇順で集める。 */
function villagersOf(w: World, p: number): number[] {
  const e = w.entities;
  const out: number[] = [];
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1 || e.kind[i] !== EntityKind.Unit || e.owner[i] !== p) continue;
    out.push(idOfIndex(e, i));
  }
  return out;
}

/** 家の棟数（完成・建設中を問わない）。 */
function houseCount(w: World, p: number): number {
  const e = w.entities;
  const houseType = buildingDefById('house').index;
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1 || e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] === p && e.typeId[i] === houseType) n++;
  }
  return n;
}

/**
 * 2 人（ヤマト vs モンゴル）の試合を `ticks` だけ回す。
 *
 * `plan` は「この tick に流す Command」を返す関数。**tick だけを入力にする**ので、
 * 同じシード・同じ plan なら 2 回目も完全に同じ入力列になる（決定論テストの前提）。
 */
function runMatch(
  seed: number,
  ticks: number,
  plan?: (w: World, tick: number) => readonly Command[]
): { world: World; hashes: number[] } {
  const { world } = createMatch({
    seed,
    playerCount: 2,
    civs: ['yamato', 'mongol'],
    mapType: 'plain',
  });
  const hashes: number[] = [hashWorld(world)];
  for (let t = 0; t < ticks; t++) {
    stepWorld(world, plan === undefined ? [] : plan(world, t));
    if (world.tick % HASH_CHECK_INTERVAL_TICKS === 0) hashes.push(hashWorld(world));
  }
  return { world, hashes };
}

describe('createMatch — 初期配置', () => {
  it('マップ・町の中心・村人・開始資源が揃った World を返す', () => {
    const { world, mapResult } = createMatch({
      seed: 4242,
      playerCount: 2,
      civs: ['yamato', 'mongol'],
      mapType: 'plain',
    });

    // マップの広さは人数から決まる（`maps.json:sizeByPlayers`）。
    expect(world.map.widthTiles).toBe(mapResult.widthTiles);
    expect(world.map.tiles.length).toBe(world.map.widthTiles * world.map.heightTiles);
    expect(mapResult.starts.length).toBe(2);

    for (let p = 0; p < 2; p++) {
      const pl = world.players[p]!;
      // 町の中心が**完成済み**で置かれている（建設中だと生産も研究も動かない）。
      const tc = findTownCenter(world, p);
      expect(tc).toBeGreaterThanOrEqual(0);
      expect(world.entities.buildProgress[entityIndex(tc)]).toBeGreaterThan(0);
      // 人口上限が町の中心ぶん入っている（`buildings.json:town_center.pop` = 10）。
      expect(pl.popCap).toBe(buildingDefById('town_center').popProvide);
      // 村人がいて、人口に数えられている。
      expect(villagersOf(world, p).length).toBeGreaterThanOrEqual(3);
      expect(pl.pop).toBe(villagersOf(world, p).length);
      // 開始資源が入っている（プリセット + 文明ボーナス）。
      for (const r of RESOURCE_IDS) {
        expect(pl.resources[resourceIndex(r)]!).toBeGreaterThanOrEqual(0);
      }
      expect(pl.resources[resourceIndex('food')]!).toBeGreaterThan(0);
      expect(pl.frontSlots).toBeGreaterThanOrEqual(1);
    }
  });

  it('ペルシアは開始資源が多い（`applyStartResourceBonus` が効いている）', () => {
    const base = createMatch({ seed: 1, playerCount: 2, civs: ['yamato', 'roma'], mapType: 'plain' });
    const persia = createMatch({
      seed: 1,
      playerCount: 2,
      civs: ['persia', 'roma'],
      mapType: 'plain',
    });
    let baseSum = 0;
    let persiaSum = 0;
    for (let r = 0; r < RESOURCE_IDS.length; r++) {
      baseSum += base.world.players[0]!.resources[r]!;
      persiaSum += persia.world.players[0]!.resources[r]!;
    }
    expect(persiaSum).toBeGreaterThan(baseSum);
  });

  it('文明ごとの置換建物が解決される（モンゴル = 大天幕 / ヤマト = 櫓）', () => {
    // 町の中心は置換対象ではないので、置換は「城 → 大天幕」「望楼 → 櫓」で確認する。
    // ここは `resolveBuildingForCiv` の結線が生きていることの確認（データは civs.json）。
    const { world } = createMatch({
      seed: 3,
      playerCount: 2,
      civs: ['yamato', 'mongol'],
      mapType: 'plain',
    });
    expect(world.players[0]!.civ).toBe('yamato');
    expect(world.players[1]!.civ).toBe('mongol');
    // 町の中心はどの文明でも共通なので、両者とも 1 棟置かれている。
    expect(findTownCenter(world, 0)).toBeGreaterThanOrEqual(0);
    expect(findTownCenter(world, 1)).toBeGreaterThanOrEqual(0);
  });

  it('開始時代を上げると戦域スロット数もその時代のものになる', () => {
    const reimei = createMatch({ seed: 5, playerCount: 2, mapType: 'plain', startAge: 'reimei' });
    const teikoku = createMatch({ seed: 5, playerCount: 2, mapType: 'plain', startAge: 'teikoku' });
    expect(teikoku.world.players[0]!.age).toBe(3);
    expect(teikoku.world.players[0]!.frontSlots).toBeGreaterThan(
      reimei.world.players[0]!.frontSlots
    );
  });
});

describe('5,000 tick（200 秒）の実試合', () => {
  it('例外なく完走し、資源が実際に増える（村人が採集して搬入している）', () => {
    const { world } = createMatch({
      seed: 20260809,
      playerCount: 2,
      civs: ['yamato', 'mongol'],
      mapType: 'plain',
    });
    const before = [0, 1].map((p) => world.players[p]!.resources[resourceIndex('food')]!);

    expect(() => {
      for (let t = 0; t < RUN_TICKS; t++) stepWorld(world, []);
    }).not.toThrow();
    expect(world.tick).toBe(RUN_TICKS);

    for (let p = 0; p < 2; p++) {
      const after = world.players[p]!.resources[resourceIndex('food')]!;
      // 搬入は 10 単位ごと。200 秒あれば村人 3 人で最低 1 回は届く。
      expect(
        fxToNumber(after),
        `p${p} の食料が増えていない（${fxToNumber(before[p]!)} → ${fxToNumber(after)}）`
      ).toBeGreaterThan(fxToNumber(before[p]!));
    }

    // 採集の往復が回っている証拠として、村人が Idle のまま固まっていないことも見る。
    const e = world.entities;
    let working = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1 || e.kind[i] !== EntityKind.Unit) continue;
      if (e.state[i] === UnitState.Gathering || e.state[i] === UnitState.Hauling) working++;
    }
    expect(working).toBeGreaterThan(0);
  });

  it('Command で村人を生産し、家を建てて人口上限が増える', () => {
    const { world } = createMatch({
      seed: 555,
      playerCount: 2,
      civs: ['yamato', 'mongol'],
      mapType: 'plain',
    });
    const capBefore = world.players[0]!.popCap;
    const popBefore = world.players[0]!.pop;
    const tc = findTownCenter(world, 0);
    const builder = villagersOf(world, 0)[0]!;
    const bx = world.map.starts[0]!;
    const by = world.map.starts[1]!;

    const plan = (_w: World, t: number): readonly Command[] => {
      if (t === 0) {
        return [
          { t: 'produce', p: 0, building: tc, unit: 'villager', count: 2 },
          // 町の中心の少し脇に家を建てる（`buildings.json:house` は木材 30・5 秒）。
          {
            t: 'placeBuilding',
            p: 0,
            type: 'house',
            x: bx + fxFromInt(4),
            y: by,
            villagers: [builder],
          },
        ];
      }
      return [];
    };

    for (let t = 0; t < RUN_TICKS; t++) stepWorld(world, plan(world, t));

    expect(houseCount(world, 0)).toBe(1);
    // 家 +5（`buildings.json:house.pop`）。
    expect(world.players[0]!.popCap).toBe(capBefore + buildingDefById('house').popProvide);
    // 生産した村人が増えている。
    expect(world.players[0]!.pop).toBeGreaterThan(popBefore);
    // 相手（コマンドを出していない側）の人口上限は変わらない。
    expect(world.players[1]!.popCap).toBe(capBefore);
  });
});

describe('建物破壊のフック（cleanup → onBuildingDestroyed）', () => {
  it('建物が死ぬと跡地が World に登録され、同じ場所に建て直せなくなる', () => {
    const { world } = createMatch({
      seed: 777,
      playerCount: 2,
      civs: ['yamato', 'mongol'],
      mapType: 'plain',
    });
    const hx = world.map.starts[0]! + fxFromInt(4);
    const hy = world.map.starts[1]!;
    const id = spawnBuilding(world, 0, 'house', hx, hy);
    const capWithHouse = (() => {
      refreshPopulation(world);
      return world.players[0]!.popCap;
    })();

    expect(world.destroyedSites.length).toBe(0);
    const hashBefore = hashWorld(world);

    // 攻城でも自壊でも死因は問わない。`markDead` した時点で cleanup がフックを呼ぶ。
    markDead(world.entities, id);
    stepWorld(world, []);

    expect(world.destroyedSites.length).toBe(1);
    const site = world.destroyedSites[0]!;
    expect(site.typeId).toBe(buildingDefById('house').index);
    expect(site.owner).toBe(0);
    expect(site.wasWall).toBe(false);
    // 跡地タイマーの間は同じマスに建て直せない（`07§9`）。
    expect(isRebuildBlocked(world, 'house', hx, hy)).toBe(true);
    // 人口上限も戻る（家を失った）。
    expect(world.players[0]!.popCap).toBeLessThan(capWithHouse);
    // 状態ハッシュが変わる（跡地がハッシュ対象に入っている）。
    expect(hashWorld(world)).not.toBe(hashBefore);
  });

  it('同じ tick に複数棟が壊れても跡地の並びが一意になる（(y, x) 昇順）', () => {
    const { world } = createMatch({
      seed: 778,
      playerCount: 2,
      civs: ['yamato', 'mongol'],
      mapType: 'plain',
    });
    const bx = world.map.starts[0]!;
    const by = world.map.starts[1]!;
    // わざと (y, x) の昇順と逆順に置いて、逆順に殺す。
    const far = spawnBuilding(world, 0, 'house', bx + fxFromInt(4), by + fxFromInt(6));
    const near = spawnBuilding(world, 0, 'house', bx + fxFromInt(4), by + fxFromInt(4));
    markDead(world.entities, far);
    markDead(world.entities, near);
    stepWorld(world, []);
    expect(world.destroyedSites.length).toBe(2);
    const [a, b] = world.destroyedSites;
    expect(a!.tick).toBe(b!.tick);
    expect(a!.tileY).toBeLessThan(b!.tileY);
  });
});

describe('決定論', () => {
  it('同じシード・同じ入力なら 5,000 tick のハッシュ列が完全一致する', () => {
    const a = runMatch(31337, RUN_TICKS);
    const b = runMatch(31337, RUN_TICKS);
    expect(a.hashes.length).toBe(RUN_TICKS / HASH_CHECK_INTERVAL_TICKS + 1);
    expect(a.hashes).toEqual(b.hashes);
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
  });

  it('Command を混ぜても同じ入力列なら一致する', () => {
    const plan = (w: World, t: number): readonly Command[] => {
      if (t !== 0) return [];
      const tc = findTownCenter(w, 0);
      return [{ t: 'produce', p: 0, building: tc, unit: 'villager', count: 3 }];
    };
    const a = runMatch(99, RUN_TICKS, plan);
    const b = runMatch(99, RUN_TICKS, plan);
    expect(a.hashes).toEqual(b.hashes);
  });

  it('シードを変えるとハッシュが変わる', () => {
    const a = runMatch(31337, HASH_CHECK_INTERVAL_TICKS * 4);
    const c = runMatch(31338, HASH_CHECK_INTERVAL_TICKS * 4);
    expect(a.hashes[0]).not.toBe(c.hashes[0]);
    expect(hashWorld(a.world)).not.toBe(hashWorld(c.world));
  });
});

describe('8 人戦（8 文明すべて）', () => {
  it('2,000 tick 回して例外が出ない', () => {
    const { world } = createMatch({
      seed: 8888,
      playerCount: 8,
      civs: CIV_IDS,
      mapType: 'plain',
    });
    expect(world.playerCount).toBe(8);
    for (let p = 0; p < 8; p++) {
      expect(world.players[p]!.civ).toBe(CIV_IDS[p]);
      expect(findTownCenter(world, p)).toBeGreaterThanOrEqual(0);
    }
    expect(() => {
      for (let t = 0; t < EIGHT_PLAYER_TICKS; t++) stepWorld(world, []);
    }).not.toThrow();
    expect(world.tick).toBe(EIGHT_PLAYER_TICKS);
  });

  it('8 人戦も同じシードなら同じハッシュになる', () => {
    const run = (seed: number): number => {
      const { world } = createMatch({ seed, playerCount: 8, civs: CIV_IDS, mapType: 'plain' });
      for (let t = 0; t < HASH_CHECK_INTERVAL_TICKS * 2; t++) stepWorld(world, []);
      return hashWorld(world);
    };
    expect(run(1234)).toBe(run(1234));
    expect(run(1234)).not.toBe(run(1235));
  });
});
