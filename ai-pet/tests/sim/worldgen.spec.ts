/**
 * 島生成のテスト（docs/02_ゲーム実装プラン/04_サーバ設計.md §3）
 *
 * ここで守りたいのは3つ:
 * - 決定論（同じseedなら同じ島。リロードで島が変わらない）
 * - 歩ける島であること（外周は水、spawnは広場、孤島がない）
 * - 資源が全種類ちゃんと置かれていること
 */
import { describe, expect, it } from 'vitest';
import { MAP_H, MAP_W, RESOURCE, type ResourceType, type Terrain } from '@ai-pet/shared';
import type { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { tileIndex } from '../../packages/server/src/sim/world.ts';
import {
  generateIsland,
  reachableFromSpawn,
  walkableTileCount,
} from '../../packages/server/src/sim/worldgen.ts';

const SEEDS = ['pokomofu-001', 'shizuka-no-shima', 'seed-2026-08-06'] as const;
const TILE_COUNT = MAP_W * MAP_H;
const RESOURCE_TYPES: readonly ResourceType[] = ['berry_tree', 'field', 'fishing_spot', 'water'];

function terrainCounts(world: IslandWorld): Record<Terrain, number> {
  const counts = { grass: 0, dirt: 0, sand: 0, water: 0, forest: 0, plaza: 0 };
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) counts[world.terrainAt(x, y)]++;
  }
  return counts;
}

describe('generateIsland: 決定論', () => {
  it('同じseedなら地形配列が完全一致する', () => {
    const a = generateIsland('same-seed');
    const b = generateIsland('same-seed');
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain));
    expect(a.spawn).toEqual(b.spawn);
    expect(a.resources.size).toBe(b.resources.size);
    expect([...a.resources.values()]).toEqual([...b.resources.values()]);
  });

  it('違うseedなら違う地形になる', () => {
    const a = generateIsland('seed-alpha');
    const b = generateIsland('seed-beta');
    let diff = 0;
    for (let i = 0; i < TILE_COUNT; i++) {
      if ((a.terrain[i] as number) !== (b.terrain[i] as number)) diff++;
    }
    // 少しの差ではなく、はっきり別の島になっていること
    expect(diff).toBeGreaterThan(TILE_COUNT * 0.1);
  });
});

describe('generateIsland: 生成コスト', () => {
  it('1島の生成が1秒以内', () => {
    const t0 = performance.now();
    generateIsland('perf-seed');
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe.each(SEEDS)('generateIsland(%s)', (seed) => {
  const world = generateIsland(seed);
  const reachable = reachableFromSpawn(world);
  const walkable = walkableTileCount(world);

  it('外周1タイルが全てwater', () => {
    for (let x = 0; x < MAP_W; x++) {
      expect(world.terrainAt(x, 0)).toBe('water');
      expect(world.terrainAt(x, MAP_H - 1)).toBe('water');
    }
    for (let y = 0; y < MAP_H; y++) {
      expect(world.terrainAt(0, y)).toBe('water');
      expect(world.terrainAt(MAP_W - 1, y)).toBe('water');
    }
  });

  it('spawnが広場の歩けるタイルで、周囲にも立てる', () => {
    const sx = Math.floor(world.spawn.x);
    const sy = Math.floor(world.spawn.y);
    expect(world.isWalkableTile(sx, sy)).toBe(true);
    expect(world.terrainAt(sx, sy)).toBe('plaza');
    expect(world.canStandAt(world.spawn)).toBe(true);
    // 広場は半径4タイル程度の広がりを持つ
    expect(terrainCounts(world).plaza).toBeGreaterThan(30);
  });

  it('歩けるタイル比率が15%〜75%', () => {
    const ratio = walkable / TILE_COUNT;
    expect(ratio).toBeGreaterThanOrEqual(0.15);
    expect(ratio).toBeLessThanOrEqual(0.75);
  });

  it('spawnから到達できない陸タイルが存在しない', () => {
    expect(reachable.size).toBe(walkable);
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (!world.isWalkableTile(x, y)) continue;
        expect(reachable.has(tileIndex(x, y))).toBe(true);
      }
    }
  });

  it('地形が全種類そろっている', () => {
    const counts = terrainCounts(world);
    for (const t of ['grass', 'dirt', 'sand', 'water', 'forest', 'plaza'] as const) {
      expect(counts[t], `terrain ${t}`).toBeGreaterThan(0);
    }
  });

  it('資源が全種類1つ以上、期待個数の範囲で置かれている', () => {
    const byType = new Map<ResourceType, number>();
    for (const r of world.resources.values()) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    for (const t of RESOURCE_TYPES) {
      expect(byType.get(t) ?? 0, `resource ${t}`).toBeGreaterThan(0);
    }
    expect(byType.get('field') as number).toBeGreaterThanOrEqual(6);
    expect(byType.get('field') as number).toBeLessThanOrEqual(10);
    expect(byType.get('fishing_spot') as number).toBeGreaterThanOrEqual(8);
    expect(byType.get('fishing_spot') as number).toBeLessThanOrEqual(14);
    expect(byType.get('water') as number).toBe(20);
  });

  it('資源が置かれたタイルの地形が妥当', () => {
    for (const r of world.resources.values()) {
      const x = Math.floor(r.pos.x);
      const y = Math.floor(r.pos.y);
      const t = world.terrainAt(x, y);
      switch (r.type) {
        case 'berry_tree':
          expect(t, 'berry_tree は forest').toBe('forest');
          expect(r.max).toBe(RESOURCE.berryTreeMax);
          expect(r.regenPerIslandHour).toBe(RESOURCE.berryRegenPerIslandHour);
          break;
        case 'field':
          expect(['grass', 'dirt'], 'field は grass/dirt').toContain(t);
          expect(r.max).toBe(RESOURCE.fieldMax);
          break;
        case 'fishing_spot': {
          expect(world.isWalkableTile(x, y), 'fishing_spot は歩けるタイル').toBe(true);
          const nearWater = [
            world.terrainAt(x + 1, y),
            world.terrainAt(x - 1, y),
            world.terrainAt(x, y + 1),
            world.terrainAt(x, y - 1),
          ].includes('water');
          expect(nearWater, 'fishing_spot は水に隣接').toBe(true);
          break;
        }
        case 'water':
          expect(t, 'water資源 は water タイル').toBe('water');
          break;
      }
      expect(r.amount).toBeGreaterThan(0);
      expect(r.amount).toBeLessThanOrEqual(r.max);
      expect(r.id).toBeGreaterThan(0);
      // タイルの索引と資源が一致していること
      expect(world.resourceOnTile(x, y)?.id).toBe(r.id);
    }
  });

  it('資源は1タイルに1つまで', () => {
    const tiles = new Set<number>();
    for (const r of world.resources.values()) {
      const i = tileIndex(Math.floor(r.pos.x), Math.floor(r.pos.y));
      expect(tiles.has(i)).toBe(false);
      tiles.add(i);
    }
  });
});
