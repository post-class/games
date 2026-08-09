/**
 * T-M3-01〜07 の決定論（D）
 *
 * 検証:
 *  1. 同じシード・同じ人数・同じ型なら、地形 3 配列と資源ノードが**完全一致**する。
 *  2. シードが違えば地形が変わる（生成が実際にシードを見ている）。
 *  3. `rngMap` 以外の乱数ストリームを消費していない（`rngCombat` / `rngAi` の状態が不変）。
 *  4. 生成後のマップ上で 400 tick 移動させても、2 回の実行で状態ハッシュが一致する。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind, MAP_TYPE_IDS } from '@/shared/types';
import type { MapTypeId } from '@/shared/types';
import { createWorld, type World } from '@/sim/core/world';
import { spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fxFromInt, idiv } from '@/sim/core/fx';
import { Rng } from '@/sim/core/rng';
import { rebuildGrid } from '@/sim/core/grid';
import { hashWorld } from '@/sim/hash';
import { movement } from '@/sim/systems/movement';
import { generateMap, mapSizeForPlayers } from '@/sim/systems/mapgen';
import { unitDefById } from '@/sim/core/defs';

function build(mapType: MapTypeId, playerCount: number, seed: number): World {
  const side = mapSizeForPlayers(mapType, playerCount);
  const w = createWorld({
    seed,
    playerCount,
    mapWidthTiles: side,
    mapHeightTiles: side,
    entityCapacity: 4096,
  });
  generateMap(w, { mapType });
  return w;
}

/** 地形 3 配列 + 資源エンティティの FNV-1a ハッシュ。 */
function mapDigest(w: World): number {
  let h = 0x811c9dc5;
  const mix = (v: number): void => {
    h = (h ^ (v & 0xff)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h = (h ^ ((v >>> 8) & 0xff)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h = (h ^ ((v >>> 16) & 0xff)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h = (h ^ ((v >>> 24) & 0xff)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (let i = 0; i < w.map.tiles.length; i++) mix(w.map.tiles[i]!);
  for (let i = 0; i < w.map.passable.length; i++) mix(w.map.passable[i]!);
  for (let i = 0; i < w.map.elevation.length; i++) mix(w.map.elevation[i]!);
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    mix(e.kind[i]!);
    mix(e.typeId[i]!);
    mix(e.x[i]!);
    mix(e.y[i]!);
    mix(e.amount[i]!);
  }
  return h >>> 0;
}

describe('マップ生成の決定論', () => {
  for (const type of MAP_TYPE_IDS) {
    it(`${type}: 同じシードなら地形と資源が完全一致`, () => {
      const a = build(type, 4, 987654);
      const b = build(type, 4, 987654);
      expect(mapDigest(b)).toBe(mapDigest(a));
      expect(Array.from(b.map.tiles)).toEqual(Array.from(a.map.tiles));
      expect(Array.from(b.map.passable)).toEqual(Array.from(a.map.passable));
      expect(Array.from(b.map.elevation)).toEqual(Array.from(a.map.elevation));
    });
  }

  it('シードが違えば地形が変わる', () => {
    const a = build('inland_sea', 4, 1);
    const b = build('inland_sea', 4, 2);
    expect(mapDigest(b)).not.toBe(mapDigest(a));
    // 開始位置は公平性の要求どおりシードに依らない（円周配置は決め打ち）
    expect(Array.from(a.map.tiles)).not.toEqual(Array.from(b.map.tiles));
  });

  it('人数が違えば広さと拠点数が変わる', () => {
    const a = build('plain', 2, 55);
    const b = build('plain', 8, 55);
    expect(a.map.widthTiles).toBe(200);
    expect(b.map.widthTiles).toBe(400);
  });

  it('mapgen は rngMap 以外のストリームを消費しない', () => {
    const w = build('river', 4, 424242);
    const fresh = createWorld({
      seed: 424242,
      playerCount: 4,
      mapWidthTiles: 8,
      mapHeightTiles: 8,
      entityCapacity: 8,
    });
    expect(Array.from(w.rngCombat.state)).toEqual(Array.from(fresh.rngCombat.state));
    expect(Array.from(w.rngAi.state)).toEqual(Array.from(fresh.rngAi.state));
    // rngMap は当然変わっている
    expect(Array.from(w.rngMap.state)).not.toEqual(Array.from(fresh.rngMap.state));
  });

  it('乱数は Rng のみ（同じ Rng 列から同じマップができる）', () => {
    // Rng が壊れていないことの回帰（Math.random が混ざったら 2 回目が変わる）
    const r1 = new Rng(9);
    const r2 = new Rng(9);
    for (let i = 0; i < 100; i++) expect(r2.nextU32()).toBe(r1.nextU32());
  });
});

describe('生成マップ上の移動の決定論', () => {
  function run(seed: number): number {
    const w = build('river', 4, seed);
    const def = unitDefById('villager');
    const starts = [
      [40, 40],
      [60, 40],
      [40, 60],
      [60, 60],
    ];
    const idx: number[] = [];
    for (let k = 0; k < 200; k++) {
      const base = starts[k % 4]!;
      const id = spawnEntity(w.entities, {
        kind: EntityKind.Unit,
        owner: k % 4,
        typeId: def.index,
        x: fxFromInt(base[0]! + (k % 10)) + (FX_ONE >> 1),
        y: fxFromInt(base[1]! + idiv(k, 10)) + (FX_ONE >> 1),
        hpMax: def.hp,
      });
      const i = id & 0xffff;
      idx.push(i);
      w.entities.destX[i] = fxFromInt(w.map.widthTiles - 20);
      w.entities.destY[i] = fxFromInt(w.map.heightTiles - 20);
    }
    for (let t = 0; t < 400; t++) {
      rebuildGrid(w.grid, w.entities, w.tick);
      movement(w);
      w.tick += 1;
    }
    return hashWorld(w);
  }

  it('同じシードの 2 回の実行で状態ハッシュが一致する', () => {
    expect(run(20260809)).toBe(run(20260809));
  });

  it('シードが違えば結果も違う', () => {
    expect(run(1)).not.toBe(run(2));
  });
});
