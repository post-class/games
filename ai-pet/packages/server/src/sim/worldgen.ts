/**
 * 島の生成（docs/02_ゲーム実装プラン/04_サーバ設計.md §3）
 *
 * seed → value noise → radial falloff → 地形 → 広場 → 畑の土 → 資源。
 *
 * 原則:
 * - Math.random() 禁止。すべて Rng(seed) から作る（同じseedなら必ず同じ島）
 * - 外部ノイズライブラリを使わない（格子点の乱数値 + smoothstep 補間の value noise）
 * - 生成後に spawn からの flood fill で「歩いて行けない陸」を消す
 */
import {
  MAP_H,
  MAP_W,
  RESOURCE,
  Rng,
  type ResourceNode,
  type Terrain,
} from '@ai-pet/shared';
import { IslandWorld, inBounds, tileIndex } from './world.ts';

// ---------- 生成パラメータ ----------
// バランス定数ではなく「島の見た目」を決める値なので、constants.ts ではなくここに置く。

/** 最低周波数のオクターブが持つ格子セル数（島の大まかな輪郭の粗さ） */
const NOISE_BASE_CELLS = 4;
/** 重ねるオクターブ数。5で 4→64セルまで（1セル=2タイル）細部が出る */
const NOISE_OCTAVES = 5;
/** オクターブごとの振幅減衰 */
const NOISE_PERSISTENCE = 0.5;

/** radial falloff の減衰開始/終了（マップ中心からの正規化距離 0..1超） */
const FALLOFF_INNER = 0.45;
const FALLOFF_OUTER = 1.05;

/** 地形のしきい値（設計書 §3-2） */
const BASE_LEVELS = { water: 0.3, sand: 0.36, grass: 0.7 } as const;
/** 再生成のたびに水位を下げる量（陸を増やす方向へ寄せる） */
const LEVEL_STEP_PER_ATTEMPT = 0.03;

/** 広場の半径と、広場の中心を探す範囲（マップ中心から） */
const PLAZA_RADIUS = 4;
const PLAZA_SEARCH_RADIUS = 18;

/** 畑の土。patchごとに小さな円を塗る */
const DIRT_PATCH_MIN = 3;
const DIRT_PATCH_MAX = 5;
const DIRT_PATCH_RADIUS = 2;

/** 資源の量。設計書 §3-4 */
const BERRY_DENSITY = 0.06;
const FIELD_MIN = 6;
const FIELD_MAX = 10;
const FISHING_MIN = 8;
const FISHING_MAX = 14;
const WATER_SOURCE_COUNT = 20;

/**
 * 釣り場と水場は constants.ts に定数がない（他の作業者が編集中のため追加しない）。
 * 釣り場は berry_tree より渋く、水場は実質枯れない量にしてある。
 */
const FISHING_SPOT_MAX = 4;
const FISHING_REGEN_PER_ISLAND_HOUR = 0.5;
const WATER_SOURCE_MAX = 20;
const WATER_REGEN_PER_ISLAND_HOUR = 20;

/** 到達可能な陸がこの比率を下回ったら作り直す */
const MIN_WALKABLE_RATIO = 0.15;
const MAX_ATTEMPTS = 5;

const TILE_COUNT = MAP_W * MAP_H;

// ---------- value noise ----------

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 0..1 に丸めた上で smoothstep をかける（範囲付き） */
function smoothRange(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return smoothstep(t);
}

/** (cells+1)^2 の格子点にランダム値を敷く */
function makeLattice(rng: Rng, cells: number): Float64Array {
  const n = cells + 1;
  const lat = new Float64Array(n * n);
  for (let i = 0; i < lat.length; i++) lat[i] = rng.next();
  return lat;
}

/** u,v は 0..1。格子値をバイリニア（smoothstep補間）でサンプルする */
function sampleLattice(lat: Float64Array, cells: number, u: number, v: number): number {
  const n = cells + 1;
  const fx = u * cells;
  const fy = v * cells;
  const ix = Math.min(cells - 1, Math.floor(fx));
  const iy = Math.min(cells - 1, Math.floor(fy));
  const tx = smoothstep(fx - ix);
  const ty = smoothstep(fy - iy);
  const i00 = iy * n + ix;
  const a = lat[i00] as number;
  const b = lat[i00 + 1] as number;
  const c = lat[i00 + n] as number;
  const d = lat[i00 + n + 1] as number;
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/**
 * 高度マップ。value noise を複数オクターブ重ねて 0..1 に正規化し、
 * 中心からの距離で減衰させる（外周が必ず水になる）。
 */
function buildHeightMap(rng: Rng): Float64Array {
  const lattices: { cells: number; lat: Float64Array; amp: number }[] = [];
  let cells = NOISE_BASE_CELLS;
  let amp = 1;
  let ampSum = 0;
  for (let o = 0; o < NOISE_OCTAVES; o++) {
    lattices.push({ cells, lat: makeLattice(rng, cells), amp });
    ampSum += amp;
    cells *= 2;
    amp *= NOISE_PERSISTENCE;
  }

  const out = new Float64Array(TILE_COUNT);
  let min = Infinity;
  let max = -Infinity;
  for (let y = 0; y < MAP_H; y++) {
    const v = (y + 0.5) / MAP_H;
    const dy = ((y + 0.5) / MAP_H) * 2 - 1;
    for (let x = 0; x < MAP_W; x++) {
      const u = (x + 0.5) / MAP_W;
      let sum = 0;
      for (const oct of lattices) sum += sampleLattice(oct.lat, oct.cells, u, v) * oct.amp;
      // 中心からの距離で減衰させる。外周は必ず 0 になる（= 水）
      const dx = ((x + 0.5) / MAP_W) * 2 - 1;
      const falloff = 1 - smoothRange(FALLOFF_INNER, FALLOFF_OUTER, Math.hypot(dx, dy));
      const h = (sum / ampSum) * falloff;
      out[tileIndex(x, y)] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }

  // 減衰後に min-max 正規化する。
  // seedによって島が全部水/全部森に寄るのを防ぎ、しきい値（§3-2）を素直に使えるようにする。
  const span = max - min || 1;
  for (let i = 0; i < out.length; i++) out[i] = ((out[i] as number) - min) / span;
  return out;
}

// ---------- 地形 ----------

function terrainFromHeight(h: number, levels: { water: number; sand: number; grass: number }): Terrain {
  if (h < levels.water) return 'water';
  if (h < levels.sand) return 'sand';
  if (h < levels.grass) return 'grass';
  return 'forest';
}

/** 外周1タイルを水にする（境界処理を単純化するため。設計書 §3-5） */
function forceBorderWater(world: IslandWorld): void {
  for (let x = 0; x < MAP_W; x++) {
    world.setTerrain(x, 0, 'water');
    world.setTerrain(x, MAP_H - 1, 'water');
  }
  for (let y = 0; y < MAP_H; y++) {
    world.setTerrain(0, y, 'water');
    world.setTerrain(MAP_W - 1, y, 'water');
  }
}

// ---------- 広場 ----------

/**
 * マップ中心付近から「歩けるタイルが多く・平坦な」円を探し、そこを plaza にする。
 * 見つけた円は穴（水）ごと plaza で塗るので、必ず歩ける広場になる。
 */
function carvePlaza(world: IslandWorld, height: Float64Array): void {
  const ccx = Math.floor(MAP_W / 2);
  const ccy = Math.floor(MAP_H / 2);
  let bestX = ccx;
  let bestY = ccy;
  let bestScore = -Infinity;

  for (let cy = ccy - PLAZA_SEARCH_RADIUS; cy <= ccy + PLAZA_SEARCH_RADIUS; cy++) {
    for (let cx = ccx - PLAZA_SEARCH_RADIUS; cx <= ccx + PLAZA_SEARCH_RADIUS; cx++) {
      if (cx - PLAZA_RADIUS < 1 || cy - PLAZA_RADIUS < 1) continue;
      if (cx + PLAZA_RADIUS >= MAP_W - 1 || cy + PLAZA_RADIUS >= MAP_H - 1) continue;

      let walkable = 0;
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let dy = -PLAZA_RADIUS; dy <= PLAZA_RADIUS; dy++) {
        for (let dx = -PLAZA_RADIUS; dx <= PLAZA_RADIUS; dx++) {
          if (dx * dx + dy * dy > PLAZA_RADIUS * PLAZA_RADIUS) continue;
          const h = height[tileIndex(cx + dx, cy + dy)] as number;
          if (world.isWalkableTile(cx + dx, cy + dy)) walkable++;
          sum += h;
          sumSq += h * h;
          n++;
        }
      }
      const mean = sum / n;
      const variance = Math.max(0, sumSq / n - mean * mean);
      // 歩ける面積を最優先、次に平坦さ。中心に近いほうを僅かに優先する
      const dist = Math.hypot(cx - ccx, cy - ccy);
      const score = walkable - variance * 200 - dist * 0.05;
      if (score > bestScore) {
        bestScore = score;
        bestX = cx;
        bestY = cy;
      }
    }
  }

  for (let dy = -PLAZA_RADIUS; dy <= PLAZA_RADIUS; dy++) {
    for (let dx = -PLAZA_RADIUS; dx <= PLAZA_RADIUS; dx++) {
      if (dx * dx + dy * dy > PLAZA_RADIUS * PLAZA_RADIUS) continue;
      world.setTerrain(bestX + dx, bestY + dy, 'plaza');
    }
  }
  world.spawn = { x: bestX + 0.5, y: bestY + 0.5 };
}

// ---------- 畑の土 ----------

/** 広場の周りの草地に土のパッチを作る（後で field を置く場所） */
function scatterDirt(world: IslandWorld, rng: Rng): void {
  const sx = Math.floor(world.spawn.x);
  const sy = Math.floor(world.spawn.y);

  // 広場から少し離れた草地を候補にする
  const candidates: number[] = [];
  for (let y = 2; y < MAP_H - 2; y++) {
    for (let x = 2; x < MAP_W - 2; x++) {
      if (world.terrainAt(x, y) !== 'grass') continue;
      const d = Math.hypot(x - sx, y - sy);
      if (d < PLAZA_RADIUS + 2 || d > 32) continue;
      candidates.push(tileIndex(x, y));
    }
  }
  if (candidates.length === 0) return;
  rng.shuffle(candidates);

  const patches = rng.int(DIRT_PATCH_MIN, DIRT_PATCH_MAX);
  let placed = 0;
  for (const idx of candidates) {
    if (placed >= patches) break;
    const cx = idx % MAP_W;
    const cy = Math.floor(idx / MAP_W);
    // パッチ同士が重ならないように、既に土があるなら飛ばす
    if (hasNearbyTerrain(world, cx, cy, 'dirt', DIRT_PATCH_RADIUS * 3)) continue;
    for (let dy = -DIRT_PATCH_RADIUS; dy <= DIRT_PATCH_RADIUS; dy++) {
      for (let dx = -DIRT_PATCH_RADIUS; dx <= DIRT_PATCH_RADIUS; dx++) {
        if (dx * dx + dy * dy > DIRT_PATCH_RADIUS * DIRT_PATCH_RADIUS) continue;
        if (world.terrainAt(cx + dx, cy + dy) !== 'grass') continue;
        world.setTerrain(cx + dx, cy + dy, 'dirt');
      }
    }
    placed++;
  }
}

function hasNearbyTerrain(world: IslandWorld, x: number, y: number, t: Terrain, radius: number): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (world.terrainAt(x + dx, y + dy) === t) return true;
    }
  }
  return false;
}

// ---------- 到達可能性 ----------

const NEIGHBORS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** spawn から歩いて到達できるタイル（tileIndex）の集合 */
export function reachableFromSpawn(world: IslandWorld): Set<number> {
  const seen = new Set<number>();
  const sx = Math.floor(world.spawn.x);
  const sy = Math.floor(world.spawn.y);
  if (!world.isWalkableTile(sx, sy)) return seen;

  const stack: number[] = [tileIndex(sx, sy)];
  seen.add(stack[0] as number);
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    const x = cur % MAP_W;
    const y = Math.floor(cur / MAP_W);
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny) || !world.isWalkableTile(nx, ny)) continue;
      const ni = tileIndex(nx, ny);
      if (seen.has(ni)) continue;
      seen.add(ni);
      stack.push(ni);
    }
  }
  return seen;
}

/** 歩けるタイルの総数 */
export function walkableTileCount(world: IslandWorld): number {
  let n = 0;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) if (world.isWalkableTile(x, y)) n++;
  }
  return n;
}

/** spawn から行けない陸（孤島）を水に沈める。戻り値は到達可能タイル数 */
function sinkUnreachableLand(world: IslandWorld): number {
  const reachable = reachableFromSpawn(world);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (!world.isWalkableTile(x, y)) continue;
      if (reachable.has(tileIndex(x, y))) continue;
      world.setTerrain(x, y, 'water');
    }
  }
  return reachable.size;
}

// ---------- 資源 ----------

function isWaterAdjacent(world: IslandWorld, x: number, y: number): boolean {
  for (const [dx, dy] of NEIGHBORS) if (world.terrainAt(x + dx, y + dy) === 'water') return true;
  return false;
}

function isLandAdjacent(world: IslandWorld, x: number, y: number): boolean {
  for (const [dx, dy] of NEIGHBORS) {
    const nx = x + dx;
    const ny = y + dy;
    if (inBounds(nx, ny) && world.isWalkableTile(nx, ny)) return true;
  }
  return false;
}

function addNode(
  world: IslandWorld,
  type: ResourceNode['type'],
  x: number,
  y: number,
  max: number,
  regen: number,
): void {
  world.addResource({
    id: world.allocId(),
    type,
    pos: { x: x + 0.5, y: y + 0.5 },
    amount: max,
    max,
    regenPerIslandHour: regen,
  });
}

/** 資源を配置する（設計書 §3-4）。1タイルに1つまで（world.resourceAt の制約） */
function placeResources(world: IslandWorld, rng: Rng, reachable: Set<number>): void {
  const forest: number[] = [];
  const farm: number[] = [];
  const shore: number[] = [];
  const waterEdge: number[] = [];

  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      const i = tileIndex(x, y);
      const t = world.terrainAt(x, y);
      if (t === 'water') {
        if (isLandAdjacent(world, x, y)) waterEdge.push(i);
        continue;
      }
      // 陸側は spawn から到達できるところだけを使う
      if (!reachable.has(i)) continue;
      if (t === 'forest') forest.push(i);
      if (t === 'grass' || t === 'dirt') farm.push(i);
      if (isWaterAdjacent(world, x, y)) shore.push(i);
    }
  }

  const free = (i: number): boolean => (world.resourceAt[i] as number) === 0;
  const take = (list: number[], count: number, fn: (x: number, y: number) => void): void => {
    let n = 0;
    for (const i of list) {
      if (n >= count) break;
      if (!free(i)) continue;
      fn(i % MAP_W, Math.floor(i / MAP_W));
      n++;
    }
  };

  // berry_tree: forest に密度 0.06
  for (const i of forest) {
    if (!rng.chance(BERRY_DENSITY)) continue;
    addNode(world, 'berry_tree', i % MAP_W, Math.floor(i / MAP_W), RESOURCE.berryTreeMax, RESOURCE.berryRegenPerIslandHour);
  }
  // 森が極端に小さいseedでも1本は生えるようにする
  if (world.resources.size === 0 && forest.length > 0) {
    const i = rng.pick(forest);
    addNode(world, 'berry_tree', i % MAP_W, Math.floor(i / MAP_W), RESOURCE.berryTreeMax, RESOURCE.berryRegenPerIslandHour);
  }

  // field: 土 → 草の順に優先して 6〜10箇所
  const dirtFirst = [...farm];
  rng.shuffle(dirtFirst);
  dirtFirst.sort((a, b) => {
    const ta = world.terrainAt(a % MAP_W, Math.floor(a / MAP_W)) === 'dirt' ? 0 : 1;
    const tb = world.terrainAt(b % MAP_W, Math.floor(b / MAP_W)) === 'dirt' ? 0 : 1;
    return ta - tb;
  });
  take(dirtFirst, rng.int(FIELD_MIN, FIELD_MAX), (x, y) =>
    addNode(world, 'field', x, y, RESOURCE.fieldMax, RESOURCE.fieldRegenPerIslandHour),
  );

  // fishing_spot: 水に隣接する歩けるタイル
  rng.shuffle(shore);
  take(shore, rng.int(FISHING_MIN, FISHING_MAX), (x, y) =>
    addNode(world, 'fishing_spot', x, y, FISHING_SPOT_MAX, FISHING_REGEN_PER_ISLAND_HOUR),
  );

  // water: 陸に隣接する水タイル（動物が水を飲む場所）
  rng.shuffle(waterEdge);
  take(waterEdge, WATER_SOURCE_COUNT, (x, y) =>
    addNode(world, 'water', x, y, WATER_SOURCE_MAX, WATER_REGEN_PER_ISLAND_HOUR),
  );
}

// ---------- エントリポイント ----------

/**
 * seed から島を1つ作る。同じ seed なら常に同じ島になる。
 * 到達可能な陸が少なすぎる場合は水位を下げて作り直す（最大 MAX_ATTEMPTS 回）。
 */
export function generateIsland(seed: string): IslandWorld {
  let last: IslandWorld | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = new Rng(seed);
    const world = new IslandWorld(rng);
    const shift = attempt * LEVEL_STEP_PER_ATTEMPT;
    const levels = {
      water: BASE_LEVELS.water - shift,
      sand: BASE_LEVELS.sand - shift,
      grass: BASE_LEVELS.grass,
    };

    const height = buildHeightMap(rng);
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        world.setTerrain(x, y, terrainFromHeight(height[tileIndex(x, y)] as number, levels));
      }
    }
    forceBorderWater(world);

    carvePlaza(world, height);
    scatterDirt(world, rng);
    forceBorderWater(world);

    const reachableCount = sinkUnreachableLand(world);
    last = world;

    if (reachableCount / TILE_COUNT >= MIN_WALKABLE_RATIO) {
      placeResources(world, rng, reachableFromSpawn(world));
      return world;
    }
  }

  // 5回試しても足りなかった場合は最後の島をそのまま使う（生成が止まるより良い）
  const world = last as IslandWorld;
  placeResources(world, world.rng, reachableFromSpawn(world));
  return world;
}
