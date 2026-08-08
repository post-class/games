/**
 * 「暮らしの痕跡」のテスト（docs/03_宣伝用との乖離是正プラン C-1 / C-2）。
 *
 * ここで守りたいのは4つ:
 * - 歩行不可の建物を置いても**到達できない陸が0**であること（AI_CODING.md §8）
 * - 幅1タイルの通路を作らないこと（A*の maxNodes は4000）
 * - 同じseedなら建物の位置・種別・向きまで完全一致すること（決定論）
 * - 広場が円形で、噴水が中心にあり、spawn地点が歩けること（C-2）
 */
import { describe, expect, it } from 'vitest';
import { MAP_H, MAP_W, type Placeable, type PlaceableType } from '@ai-pet/shared';
import type { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { tileIndex } from '../../packages/server/src/sim/world.ts';
import {
  generateIsland,
  reachableFromSpawn,
  walkableTileCount,
} from '../../packages/server/src/sim/worldgen.ts';

/** 生成に時間がかかるので島は1回だけ作って共有する */
const SEEDS = ['pokomofu-2', 'pokomofu-001', 'shizuka-no-shima', 'seed-2026-08-06'] as const;

const HOUSE_TYPES: readonly PlaceableType[] = ['house_a', 'house_b', 'house_c'];
const FENCE_TYPES: readonly PlaceableType[] = ['fence_h', 'fence_v'];
/** worldgen が置く設置物（プレイヤーが置けるものは1つも含まれない） */
const VILLAGE_TYPES: readonly PlaceableType[] = [...HOUSE_TYPES, ...FENCE_TYPES, 'windmill', 'fountain'];

function villagePlaceables(world: IslandWorld): Placeable[] {
  return [...world.placeables.values()].filter((p) => VILLAGE_TYPES.includes(p.type));
}

function solidCount(world: IslandWorld): number {
  let n = 0;
  for (let i = 0; i < world.solid.length; i++) if ((world.solid[i] as number) !== 0) n++;
  return n;
}

describe('placeVillage: 決定論', () => {
  it('同じseedなら建物の種別・位置・attractまで一致する', () => {
    const a = generateIsland('village-seed');
    const b = generateIsland('village-seed');
    expect(villagePlaceables(a)).toEqual(villagePlaceables(b));
    // 歩行不可のタイル（footprint）も一致すること
    expect(Array.from(a.solid)).toEqual(Array.from(b.solid));
    expect(a.spawn).toEqual(b.spawn);
  });

  it('違うseedなら村の場所が変わる', () => {
    const a = generateIsland('village-alpha');
    const b = generateIsland('village-beta');
    const pa = villagePlaceables(a).map((p) => `${p.type}@${p.pos.x},${p.pos.y}`);
    const pb = villagePlaceables(b).map((p) => `${p.type}@${p.pos.x},${p.pos.y}`);
    expect(pa).not.toEqual(pb);
  });
});

describe.each(SEEDS)('placeVillage(%s)', (seed) => {
  const world = generateIsland(seed);
  const village = villagePlaceables(world);

  it('家が3軒以上・風車が1基ある', () => {
    const houses = village.filter((p) => HOUSE_TYPES.includes(p.type));
    expect(houses.length).toBeGreaterThanOrEqual(3);
    expect(houses.length).toBeLessThanOrEqual(5);
    expect(village.filter((p) => p.type === 'windmill').length).toBe(1);
  });

  it('家と風車は広場から歩いて1分以内（spawnから20タイル以内）にある', () => {
    // 完了条件「広場から歩いて1分以内に家と風車が視界に入る」。
    // 動物より速いプレイヤーの速度でも20タイルは十数秒で着く
    const buildings = village.filter((p) => HOUSE_TYPES.includes(p.type) || p.type === 'windmill');
    for (const b of buildings) {
      const d = Math.hypot(b.pos.x - world.spawn.x, b.pos.y - world.spawn.y);
      expect(d, `${b.type} が広場から遠すぎる: ${d.toFixed(1)}`).toBeLessThanOrEqual(20);
    }
  });

  it('噴水が広場の中心（plazaタイル）に1つだけある', () => {
    const fountains = village.filter((p) => p.type === 'fountain');
    expect(fountains.length).toBe(1);
    const f = fountains[0] as Placeable;
    const fx = Math.floor(f.pos.x);
    const fy = Math.floor(f.pos.y);
    expect(world.terrainAt(fx, fy)).toBe('plaza');
    // spawn には重ねない。かつ設置物の最小間隔（2タイル）を割らない
    expect(Math.hypot(f.pos.x - world.spawn.x, f.pos.y - world.spawn.y)).toBeGreaterThanOrEqual(2);
  });

  it('村の設置物はすべて歩行不可タイルの上にあり、島の所有物になっている', () => {
    for (const p of village) {
      expect(world.isSolid(Math.floor(p.pos.x), Math.floor(p.pos.y)), `${p.type} が歩けてしまう`).toBe(true);
      expect(p.ownerId).toBe('__island__');
      // 動物を引き寄せない（餌の無い村へ通い続けて餓死するのを避ける）
      expect(p.attract).toBe(0);
    }
  });

  it('建物の下に資源が無い', () => {
    for (const r of world.resources.values()) {
      const x = Math.floor(r.pos.x);
      const y = Math.floor(r.pos.y);
      if (r.type === 'water') continue; // 水資源は水タイル
      expect(world.isSolid(x, y), `${r.type} が建物の下にある`).toBe(false);
    }
  });

  it('建物を置いたあとでも到達できない陸が0', () => {
    const reachable = reachableFromSpawn(world);
    const walkable = walkableTileCount(world);
    expect(reachable.size).toBe(walkable);
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (!world.isWalkableTile(x, y)) continue;
        expect(reachable.has(tileIndex(x, y))).toBe(true);
      }
    }
  });

  it('歩行不可タイルが1枚以上あり、島の1%未満に収まっている', () => {
    const solid = solidCount(world);
    expect(solid).toBeGreaterThan(0);
    expect(solid).toBeLessThan(MAP_W * MAP_H * 0.01);
  });

  it('spawn地点が広場の歩けるタイルで、周囲にも立てる', () => {
    const sx = Math.floor(world.spawn.x);
    const sy = Math.floor(world.spawn.y);
    expect(world.terrainAt(sx, sy)).toBe('plaza');
    expect(world.isWalkableTile(sx, sy)).toBe(true);
    expect(world.isSolid(sx, sy)).toBe(false);
    expect(world.canStandAt(world.spawn)).toBe(true);
  });

  it('歩行不可タイルの隣に水が無い（幅1タイルの通路を作らない）', () => {
    // footprint 同士は隣接するので「自分と同じ塊」は除く。
    // ここでは「建物の隣が水」になっていないことを確かめる
    // （水と建物で挟むと幅1タイルの通路ができ、A*の maxNodes=4000 で詰まりやすい）
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (!world.isSolid(x, y)) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const t = world.terrainAt(x + dx, y + dy);
            expect(t, `建物(${x},${y})の隣が水`).not.toBe('water');
          }
        }
      }
    }
  });
});

describe('carvePlaza: 円形の広場（C-2）', () => {
  it('広場が円形になっている（外周のタイルが中心から等距離）', () => {
    const world = generateIsland('plaza-shape');
    const tiles: { x: number; y: number }[] = [];
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) if (world.terrainAt(x, y) === 'plaza') tiles.push({ x, y });
    }
    expect(tiles.length).toBeGreaterThan(100);

    // 重心からの距離を測る。矩形なら √2 倍（対角/辺 = 1.41）まで開くが、円なら 1.15 程度に収まる
    let sx = 0;
    let sy = 0;
    for (const t of tiles) {
      sx += t.x + 0.5;
      sy += t.y + 0.5;
    }
    const cx = sx / tiles.length;
    const cy = sy / tiles.length;

    let min = Infinity;
    let max = 0;
    for (const t of tiles) {
      // 外周のタイル（4近傍に広場でないものがある）だけを見る
      const edge =
        world.terrainAt(t.x + 1, t.y) !== 'plaza' ||
        world.terrainAt(t.x - 1, t.y) !== 'plaza' ||
        world.terrainAt(t.x, t.y + 1) !== 'plaza' ||
        world.terrainAt(t.x, t.y - 1) !== 'plaza';
      if (!edge) continue;
      const d = Math.hypot(t.x + 0.5 - cx, t.y + 0.5 - cy);
      if (d < min) min = d;
      if (d > max) max = d;
    }
    expect(max / min).toBeLessThan(1.2);
  });
});

describe('carveVillagePaths: 小道（C-1）', () => {
  it('広場のまわりに dirt の小道があり、木の実の木の本数は減らない', () => {
    // 小道は資源を置いた後に塗るので、木の実の木は forest タイルの上に残る
    const world = generateIsland('path-seed');
    for (const r of world.resources.values()) {
      if (r.type !== 'berry_tree') continue;
      expect(world.terrainAt(Math.floor(r.pos.x), Math.floor(r.pos.y))).toBe('forest');
    }

    // 広場の外周から2〜12タイルの範囲に dirt がある
    const sx = Math.floor(world.spawn.x);
    const sy = Math.floor(world.spawn.y);
    let dirtNear = 0;
    for (let y = sy - 16; y <= sy + 16; y++) {
      for (let x = sx - 16; x <= sx + 16; x++) {
        if (world.terrainAt(x, y) === 'dirt') dirtNear++;
      }
    }
    expect(dirtNear).toBeGreaterThan(20);
  });
});
