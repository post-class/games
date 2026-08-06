/**
 * spawn.ts（動物の初期散布）のテスト
 * 好適地形の判定に地形の広がりが必要なので、ここでは worldgen で作った島を使う。
 */
import { describe, expect, it } from 'vitest';
import { INITIAL_CRITTERS, MAP_W, Rng, SPAWN, type Actor, type Terrain } from '@ai-pet/shared';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { generateIsland } from '../../packages/server/src/sim/worldgen.ts';
import { CRITTER_SPECIES } from '../../packages/server/src/sim/actors.ts';
import {
  clearSpawnCache,
  findSpawnTile,
  preferredTerrains,
  spawnInitialCritters,
} from '../../packages/server/src/sim/spawn.ts';

function terrainOf(world: IslandWorld, a: Actor): Terrain {
  return world.terrainAt(Math.floor(a.pos.x), Math.floor(a.pos.y));
}

function ratioOnPreferred(world: IslandWorld, critters: Actor[], species: string): number {
  const list = critters.filter((a) => a.species === species);
  if (list.length === 0) return 0;
  const pref = preferredTerrains(species);
  const hit = list.filter((a) => pref.includes(terrainOf(world, a))).length;
  return hit / list.length;
}

describe('spawnInitialCritters', () => {
  it('既定の個体数が置かれ、全種が揃う', () => {
    const w = generateIsland('spawn-a');
    const critters = spawnInitialCritters(w);
    expect(critters.length).toBe(INITIAL_CRITTERS);
    expect(w.countActors('critter')).toBe(INITIAL_CRITTERS);
    for (const s of CRITTER_SPECIES) {
      expect(critters.some((a) => a.species === s)).toBe(true);
    }
  });

  it('個体数を指定できる', () => {
    const w = generateIsland('spawn-b');
    expect(spawnInitialCritters(w, 5).length).toBe(5);
    expect(spawnInitialCritters(w, 0).length).toBe(0);
  });

  it('全個体が歩けるタイルに立っている', () => {
    const w = generateIsland('spawn-c');
    for (const a of spawnInitialCritters(w)) {
      expect(w.canStandAt(a.pos)).toBe(true);
      expect(w.isWalkableTile(Math.floor(a.pos.x), Math.floor(a.pos.y))).toBe(true);
    }
  });

  it('個体同士が重なっていない', () => {
    const w = generateIsland('spawn-d');
    const critters = spawnInitialCritters(w);
    for (let i = 0; i < critters.length; i++) {
      for (let j = i + 1; j < critters.length; j++) {
        const a = critters[i] as Actor;
        const b = critters[j] as Actor;
        expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)).toBeGreaterThanOrEqual(SPAWN.minSpacing - 1e-9);
      }
    }
  });

  it('種ごとに好適地形へ偏る', () => {
    const w = generateIsland('spawn-e');
    const critters = spawnInitialCritters(w);
    for (const s of CRITTER_SPECIES) {
      expect(ratioOnPreferred(w, critters, s)).toBeGreaterThan(0.8);
    }
    // りすは森、うさぎは草地/土
    expect(ratioOnPreferred(w, critters, 'squirrel')).toBeGreaterThan(0.9);
    expect(ratioOnPreferred(w, critters, 'rabbit')).toBeGreaterThan(0.9);
  });

  it('かえるは水辺に置かれる', () => {
    const w = generateIsland('spawn-f');
    const frogs = spawnInitialCritters(w).filter((a) => a.species === 'frog');
    expect(frogs.length).toBeGreaterThan(0);
    const nearWater = frogs.filter((a) => {
      const x = Math.floor(a.pos.x);
      const y = Math.floor(a.pos.y);
      return (
        w.terrainAt(x + 1, y) === 'water' ||
        w.terrainAt(x - 1, y) === 'water' ||
        w.terrainAt(x, y + 1) === 'water' ||
        w.terrainAt(x, y - 1) === 'water'
      );
    });
    expect(nearWater.length / frogs.length).toBeGreaterThan(0.8);
  });

  it('年齢がばらけていて、寿命の6割を超えない', () => {
    const w = generateIsland('spawn-g');
    const critters = spawnInitialCritters(w);
    const ages = critters.map((a) => a.ageDays);
    expect(new Set(ages).size).toBeGreaterThan(10);
    expect(Math.max(...ages)).toBeGreaterThan(10);
    expect(Math.min(...ages)).toBeLessThan(10);
    for (const a of critters) {
      expect(a.ageDays).toBeGreaterThanOrEqual(0);
      expect(a.ageDays).toBeLessThanOrEqual(Math.round(a.lifespanDays * SPAWN.initialAgeMaxRatio));
    }
  });

  it('同じseedなら配置・種・年齢が完全に一致する（決定論）', () => {
    const key = (list: Actor[]): string =>
      JSON.stringify(list.map((a) => [a.species, a.name, a.pos.x, a.pos.y, a.ageDays, a.lifespanDays]));
    expect(key(spawnInitialCritters(generateIsland('det')))).toBe(key(spawnInitialCritters(generateIsland('det'))));
  });
});

describe('preferredTerrains / findSpawnTile', () => {
  it('種ごとの好適地形を返し、未知の種は歩ける地形すべてになる', () => {
    expect(preferredTerrains('rabbit')).toEqual(['grass', 'dirt']);
    expect(preferredTerrains('squirrel')).toEqual(['forest']);
    expect(preferredTerrains('frog')).toEqual(['sand']);
    expect(preferredTerrains('unknown')).not.toContain('water');
    expect(preferredTerrains('unknown').length).toBeGreaterThan(1);
  });

  it('好適地形のタイルを返す', () => {
    const w = generateIsland('find-a');
    const pos = findSpawnTile(w, 'squirrel');
    expect(pos).not.toBeNull();
    const p = pos as { x: number; y: number };
    expect(w.terrainAt(Math.floor(p.x), Math.floor(p.y))).toBe('forest');
    // タイル中心に置く
    expect(p.x % 1).toBeCloseTo(0.5, 10);
  });

  it('好適地形が無ければ歩けるタイルへ緩める', () => {
    // 全面 grass の世界（森が無い）でも りす は置ける
    const w = new IslandWorld(new Rng('find-b'));
    const pos = findSpawnTile(w, 'squirrel');
    expect(pos).not.toBeNull();
    expect(w.terrainAt(Math.floor((pos as { x: number }).x), 0)).toBe('grass');
  });

  it('置ける場所が無ければ null', () => {
    const w = new IslandWorld(new Rng('find-c'));
    for (let y = 0; y < MAP_W; y++) {
      for (let x = 0; x < MAP_W; x++) w.setTerrain(x, y, 'water');
    }
    clearSpawnCache(w);
    expect(findSpawnTile(w, 'rabbit')).toBeNull();
  });
});
