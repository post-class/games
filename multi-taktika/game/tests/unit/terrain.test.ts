/**
 * T-M3-01: 地形グリッド（タイル種別・通行可否・高低・水域）
 *
 * 完了条件: **200×200 と 400×400 を生成、メモリ 10MB 以内**
 *   → `terrainByteLength` + 経路探索の作業領域を合計して検証する（下の「メモリ」）。
 *
 * ここでは判定ヘルパの意味づけ（とくに「壁の穴が残る」設計）を固定する。
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '@/sim/core/world';
import {
  Move,
  Pass,
  TILE_COUNT,
  TILE_NAMES,
  Tile,
  allocateTerrain,
  blockTiles,
  elevationAt,
  hasTerrain,
  inBounds,
  isForest,
  isPassable,
  isPassableFor,
  isShallow,
  isWater,
  isWet,
  markGate,
  nearestPassable,
  setElevation,
  setTile,
  terrainByteLength,
  tileIndex,
  tileMoveCost,
  tileX,
  tileY,
} from '@/sim/core/terrain';
import { getPathfinder, pathfinderByteLength } from '@/sim/core/pathfind';

function makeMap(w: number, h: number) {
  const world = createWorld({
    seed: 1,
    playerCount: 2,
    mapWidthTiles: w,
    mapHeightTiles: h,
    entityCapacity: 64,
  });
  allocateTerrain(world.map);
  return world.map;
}

describe('タイル種別の表', () => {
  it('種別と名前の数が一致する', () => {
    expect(TILE_NAMES.length).toBe(TILE_COUNT);
    expect(Object.keys(Tile).length).toBe(TILE_COUNT);
  });

  it('通行ビットは種別ごとに決まっている', () => {
    const map = makeMap(8, 8);
    setTile(map, 0, 0, Tile.Grass);
    setTile(map, 1, 0, Tile.Forest);
    setTile(map, 2, 0, Tile.Water);
    setTile(map, 3, 0, Tile.Shallow);
    setTile(map, 4, 0, Tile.Cliff);
    setTile(map, 5, 0, Tile.Road);

    // 平地: 徒歩も車輪も可
    expect(isPassableFor(map, 0, 0, Move.Land)).toBe(true);
    expect(isPassableFor(map, 0, 0, Move.Wheeled)).toBe(true);
    // 森: 徒歩のみ（攻城兵器は通れない）
    expect(isPassableFor(map, 1, 0, Move.Land)).toBe(true);
    expect(isPassableFor(map, 1, 0, Move.Wheeled)).toBe(false);
    // 水域: 船のみ
    expect(isPassableFor(map, 2, 0, Move.Land)).toBe(false);
    expect(isPassableFor(map, 2, 0, Move.Ship)).toBe(true);
    // 浅瀬: 徒歩も船も可
    expect(isPassableFor(map, 3, 0, Move.Land)).toBe(true);
    expect(isPassableFor(map, 3, 0, Move.Ship)).toBe(true);
    // 崖: どれも不可
    expect(isPassableFor(map, 4, 0, Move.Amphibious)).toBe(false);
    // 街道: 平地より安い
    expect(tileMoveCost(Tile.Road)).toBeLessThan(tileMoveCost(Tile.Grass));
    expect(tileMoveCost(Tile.Forest)).toBeGreaterThan(tileMoveCost(Tile.Grass));
  });

  it('高低は丘で 1、城壁上は建物側から 2 を立てられる', () => {
    const map = makeMap(8, 8);
    expect(elevationAt(map, 0, 0)).toBe(0);
    setTile(map, 1, 1, Tile.Hill);
    expect(elevationAt(map, 1, 1)).toBe(1);
    setElevation(map, 2, 2, 2);
    expect(elevationAt(map, 2, 2)).toBe(2);
  });

  it('水域・浅瀬・森の判定', () => {
    const map = makeMap(8, 8);
    setTile(map, 1, 1, Tile.Water);
    setTile(map, 2, 1, Tile.Shallow);
    setTile(map, 3, 1, Tile.Forest);
    expect(isWater(map, 1, 1)).toBe(true);
    expect(isShallow(map, 2, 1)).toBe(true);
    expect(isForest(map, 3, 1)).toBe(true);
    expect(isWet(map, 1, 1)).toBe(true);
    expect(isWet(map, 2, 1)).toBe(true);
    expect(isWet(map, 3, 1)).toBe(false);
  });

  it('範囲外は通行不可（境界で落ちない）', () => {
    const map = makeMap(8, 8);
    expect(inBounds(map, -1, 0)).toBe(false);
    expect(inBounds(map, 8, 0)).toBe(false);
    expect(isPassable(map, -1, 0)).toBe(false);
    expect(isPassable(map, 0, 8)).toBe(false);
  });

  it('添字と座標が往復する', () => {
    const map = makeMap(13, 7);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 13; x++) {
        const i = tileIndex(map, x, y);
        expect(tileX(map, i)).toBe(x);
        expect(tileY(map, i)).toBe(y);
      }
    }
  });
});

describe('建物による封鎖（07§9「壁の穴は試合中ずっと残る」）', () => {
  it('封鎖は passable のビットで表し、解放すると通行が戻る', () => {
    const map = makeMap(16, 16);
    expect(isPassable(map, 5, 5)).toBe(true);
    blockTiles(map, 4, 4, 3, 3, true);
    expect(isPassable(map, 5, 5)).toBe(false);
    expect((map.passable[tileIndex(map, 5, 5)]! & Pass.Blocked) !== 0).toBe(true);
    // 壁が壊れた → ビットを下ろすだけで穴が開く（地形は元のまま）
    blockTiles(map, 5, 5, 1, 1, false);
    expect(isPassable(map, 5, 5)).toBe(true);
    expect(isPassable(map, 4, 4)).toBe(false);
  });

  it('地形の塗り替えでは封鎖ビットが消えない（穴を勝手に塞がない）', () => {
    const map = makeMap(16, 16);
    blockTiles(map, 5, 5, 1, 1, true);
    setTile(map, 5, 5, Tile.Rubble); // 跡地の見た目にする
    expect(map.tiles[tileIndex(map, 5, 5)]).toBe(Tile.Rubble);
    expect(isPassable(map, 5, 5)).toBe(false); // まだ建物がある扱い
    blockTiles(map, 5, 5, 1, 1, false);
    expect(isPassable(map, 5, 5)).toBe(true);
  });

  it('門ビットも地形の塗り替えで保持される', () => {
    const map = makeMap(16, 16);
    markGate(map, 3, 3, true);
    setTile(map, 3, 3, Tile.Road);
    expect((map.passable[tileIndex(map, 3, 3)]! & Pass.Gate) !== 0).toBe(true);
    markGate(map, 3, 3, false);
    expect((map.passable[tileIndex(map, 3, 3)]! & Pass.Gate) !== 0).toBe(false);
  });
});

describe('nearestPassable', () => {
  it('自分が通行可ならそのマスを返す', () => {
    const map = makeMap(16, 16);
    expect(nearestPassable(map, 4, 4, Move.Land, 4)).toBe(tileIndex(map, 4, 4));
  });

  it('塞がっていたら近いマスを (y, x) 昇順で返す（順序が固定されている）', () => {
    const map = makeMap(16, 16);
    setTile(map, 4, 4, Tile.Water);
    const got = nearestPassable(map, 4, 4, Move.Land, 4);
    // 半径 1 のリングを (y, x) 昇順に見るので (3, 3) が最初
    expect(got).toBe(tileIndex(map, 3, 3));
  });

  it('見つからなければ -1', () => {
    const map = makeMap(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) setTile(map, x, y, Tile.Water);
    expect(nearestPassable(map, 4, 4, Move.Land, 8)).toBe(-1);
  });
});

describe('メモリ（T-M3-01 の完了条件: 10MB 以内）', () => {
  const LIMIT = 10 * 1024 * 1024;

  it('200×200 と 400×400 の地形 + 経路探索の作業領域が 10MB 以内', () => {
    for (const side of [200, 400]) {
      const map = makeMap(side, side);
      expect(hasTerrain(map)).toBe(true);
      const terrain = terrainByteLength(map);
      const pf = pathfinderByteLength(getPathfinder(map));
      // 1 マス 3 バイト
      expect(terrain).toBe(side * side * 3);
      expect(terrain + pf).toBeLessThan(LIMIT);
      // 実測値を残す（報告に転記する）
      console.log(
        `[T-M3-01] ${side}x${side}: terrain=${terrain}B pathfinder=${pf}B total=${terrain + pf}B ` +
          `(${((terrain + pf) / 1024 / 1024).toFixed(2)}MB)`,
      );
    }
  });
});
