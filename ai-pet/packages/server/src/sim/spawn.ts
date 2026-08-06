/**
 * 動物の初期散布（docs/02_ゲーム実装プラン/04_サーバ設計.md §3-6）
 *
 * worldgen は資源までしか作らないので、動物はここで種ごとの好適地形へ散らす。
 *
 * 方針:
 * - 候補タイルは島ごと・種ごとに1度だけ全走査して作り、以降は使い回す（起動時の1回だけ）
 * - 乱数は world.rng のみ（同じseedなら同じ配置）
 * - 年齢を散らす。全員が同じ島日に寿命を迎えると島が突然空になる
 *
 * 制約: Math.random() 禁止 / parameter property 禁止 / enum 禁止
 */
import { INITIAL_CRITTERS, MAP_H, MAP_W, SPAWN, type Actor, type Terrain, type Vec2 } from '@ai-pet/shared';
import { CRITTER_SPECIES, createCritterActor } from './actors.ts';
import { distanceSq, inBounds, tileIndex, type IslandWorld } from './world.ts';

/** 種ごとの好適地形 */
const PREFERRED: Record<string, readonly Terrain[]> = {
  rabbit: ['grass', 'dirt'],
  cat: ['grass', 'plaza'],
  bird: ['forest', 'grass'],
  frog: ['sand'],
  squirrel: ['forest'],
  boar: ['forest', 'dirt'],
};

/** 好適地形が無い島（森が極端に小さいseedなど）で使う緩い候補 */
const ANY_TERRAINS: readonly Terrain[] = ['grass', 'dirt', 'sand', 'forest', 'plaza'];
/** 候補キャッシュ上で「緩い候補」を表すキー（種名と衝突しない文字） */
const ANY_KEY = '*';

/** 水辺を好む種。隣に水があるタイルだけを候補にする */
const WATERSIDE_SPECIES: ReadonlySet<string> = new Set<string>(['frog']);

const NEIGHBORS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** 島ごと・種ごとの候補タイル（tileIndex の配列） */
const candidateCache = new WeakMap<IslandWorld, Map<string, number[]>>();

/** 種ごとの好適地形 */
export function preferredTerrains(species: string): readonly Terrain[] {
  return PREFERRED[species] ?? ANY_TERRAINS;
}

/**
 * 種ごとの好適地形から、置けるタイルを1つ探す。
 * 好適地形が見つからない島では歩けるタイルへ緩める（配置に失敗して個体数が減るより良い）。
 */
export function findSpawnTile(world: IslandWorld, species: string, maxTries = SPAWN.findTileMaxTries): Vec2 | null {
  const preferred = pickTile(world, candidatesFor(world, species), maxTries);
  if (preferred) return preferred;
  return pickTile(world, candidatesFor(world, ANY_KEY), maxTries);
}

/** 島に動物を初期配置する。worldgenは資源までしか作らないのでここで散布する */
export function spawnInitialCritters(world: IslandWorld, count = INITIAL_CRITTERS): Actor[] {
  const out: Actor[] = [];
  for (let i = 0; i < count; i++) {
    // 種を順番に回して、どの種も必ず島にいる状態にする
    const species = CRITTER_SPECIES[i % CRITTER_SPECIES.length] as string;
    const pos = findSpawnTile(world, species);
    if (!pos) continue;
    const actor = createCritterActor(world, { species, pos });
    // 寿命は個体ごとに違うので、生成後にその寿命を基準として年齢を散らす
    actor.ageDays = Math.round(world.rng.range(0, actor.lifespanDays * SPAWN.initialAgeMaxRatio));
    out.push(actor);
  }
  return out;
}

/** 地形を書き換えたとき（M7の橋など）とテストで候補を作り直させる */
export function clearSpawnCache(world: IslandWorld): void {
  candidateCache.delete(world);
}

function candidatesFor(world: IslandWorld, key: string): number[] {
  let byKey = candidateCache.get(world);
  if (!byKey) {
    byKey = new Map<string, number[]>();
    candidateCache.set(world, byKey);
  }
  const cached = byKey.get(key);
  if (cached) return cached;

  const terrains = key === ANY_KEY ? ANY_TERRAINS : preferredTerrains(key);
  const waterside = WATERSIDE_SPECIES.has(key);
  const list: number[] = [];
  // 外周1タイルは常に水なので走査から外す
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (!world.isWalkableTile(x, y)) continue;
      if (!terrains.includes(world.terrainAt(x, y))) continue;
      if (waterside && !isWaterAdjacent(world, x, y)) continue;
      list.push(tileIndex(x, y));
    }
  }
  byKey.set(key, list);
  return list;
}

function pickTile(world: IslandWorld, list: readonly number[], maxTries: number): Vec2 | null {
  if (list.length === 0) return null;
  for (let i = 0; i < maxTries; i++) {
    const idx = list[world.rng.int(0, list.length - 1)] as number;
    const pos: Vec2 = { x: (idx % MAP_W) + 0.5, y: Math.floor(idx / MAP_W) + 0.5 };
    if (!world.canStandAt(pos)) continue;
    if (isCrowded(world, pos)) continue;
    return pos;
  }
  return null;
}

/** 既にいる個体と重ならないか（起動時にしか呼ばないので素朴な線形探索でよい） */
function isCrowded(world: IslandWorld, pos: Vec2): boolean {
  const min2 = SPAWN.minSpacing * SPAWN.minSpacing;
  for (const a of world.actors.values()) {
    if (distanceSq(a.pos, pos) < min2) return true;
  }
  return false;
}

function isWaterAdjacent(world: IslandWorld, x: number, y: number): boolean {
  for (const [dx, dy] of NEIGHBORS) {
    const nx = x + dx;
    const ny = y + dy;
    if (inBounds(nx, ny) && world.terrainAt(nx, ny) === 'water') return true;
  }
  return false;
}
