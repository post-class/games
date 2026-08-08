/**
 * 島の生成（docs/02_ゲーム実装プラン/04_サーバ設計.md §3）
 *
 * seed → value noise → radial falloff → 地形 → 広場 → 畑の土 → 集落 → 資源 → 小道。
 *
 * 原則:
 * - Math.random() 禁止。すべて Rng(seed) から作る（同じseedなら必ず同じ島）
 * - 外部ノイズライブラリを使わない（格子点の乱数値 + smoothstep 補間の value noise）
 * - 生成後に spawn からの flood fill で「歩いて行けない陸」を消す
 * - 歩行不可のもの（家・風車・柵・噴水）を置いたら**1件ごとに到達性を再検査**して、
 *   塞いでしまったらその1件を取り消す（AI_CODING.md §8「置いた後にもう一度検査」）
 */
import {
  MAP_H,
  MAP_W,
  RESOURCE,
  Rng,
  type PlaceableType,
  type ResourceNode,
  type Terrain,
} from '@ai-pet/shared';
import { ISLAND_OWNER, PLACE_ATTRACT } from './build.ts';
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

/**
 * 広場の半径と、広場の中心を探す範囲（マップ中心から）。
 *
 * 半径4だと離散化の粗さで八角形にしか見えず「四角いクリーム色のベタ塗り」に見えていた（C-2）。
 * 6に広げ、しきい値も (R+0.5)^2 にして角を丸めている。
 */
const PLAZA_RADIUS = 6;
/** 円形マスクのしきい値。半径そのままの R^2 より角が丸くなる */
const PLAZA_R2 = (PLAZA_RADIUS + 0.5) * (PLAZA_RADIUS + 0.5);
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

// 釣り場・水場の量は constants.ts の RESOURCE に集約済み（バランス調整を1ファイルで済ませるため）
const FISHING_SPOT_MAX = RESOURCE.fishingSpotMax;
const FISHING_REGEN_PER_ISLAND_HOUR = RESOURCE.fishingRegenPerIslandHour;
const WATER_SOURCE_MAX = RESOURCE.waterSourceMax;
const WATER_REGEN_PER_ISLAND_HOUR = RESOURCE.waterRegenPerIslandHour;

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

/** 円形マスク（広場の内側か） */
function inPlazaDisc(dx: number, dy: number): boolean {
  return dx * dx + dy * dy <= PLAZA_R2;
}

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
          if (!inPlazaDisc(dx, dy)) continue;
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
      if (!inPlazaDisc(dx, dy)) continue;
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

// ---------- 集落（C-1 家・風車・柵・小道 / C-2 噴水） ----------

/**
 * 家の絵は3種。3軒以上並べるとき同じ絵が続かないよう順番に使う
 * （宣伝資料 hero.png も屋根の色が違う家が並んでいる）
 */
const HOUSE_TYPES: readonly PlaceableType[] = ['house_a', 'house_b', 'house_c'];

/** 家の軒数。3だと村に見えず、6以上だと広場の周りが塞がって到達性検査で落ちる率が上がる */
const HOUSE_MIN = 3;
const HOUSE_MAX = 5;

/** 家・風車の footprint（1辺のタイル数）。2×2 = 実表示 96px の絵とだいたい合う */
const BUILDING_SIZE = 2;

/**
 * 広場の中心から家を置く距離（タイル）。
 * +2 だと家が広場の縁に接してしまい小道が1タイルも引けなかったので +3 から始める。
 */
const HOUSE_DIST_MIN = PLAZA_RADIUS + 3;
const HOUSE_DIST_MAX = PLAZA_RADIUS + 9;
/** 風車は村の外れ。家より遠くに1基だけ */
const WINDMILL_DIST_MIN = PLAZA_RADIUS + 5;
const WINDMILL_DIST_MAX = PLAZA_RADIUS + 11;

/**
 * 建物のまわりに必ず空けるタイル数（Chebyshev距離）。
 *
 * 1だと建物と水／建物同士の間に幅1タイルの通路ができる。
 * A*の maxNodes は4000しかないので幅1の通路は詰まりやすい（AI_CODING.md §8）。
 * 2にすると「必ず2タイル以上の幅」が保証される。
 */
const STRUCTURE_CLEARANCE = 2;

/** 柵の1本の長さ（タイル）。3本ぶんで hero.png の柵と同じくらいの見え方になる */
const FENCE_LENGTH = 3;
/** 柵を立てる家の数（全戸に柵を付けると広場の周りが柵だらけになる） */
const FENCE_HOUSES = 2;
/** 家の中心から柵までの距離（タイル）。CLEARANCE ぶん離さないと置けない */
const FENCE_OFFSET = 4;

/** 小道の幅（タイル）。1タイル幅だと道に見えず、動物も1列に並んでしまう */
const PATH_WIDTH = 2;

/**
 * 家・風車を建てられる地形。
 *
 * 素直に `grass` / `dirt` だけにすると、広場のまわりが森のseed（`shizuka-no-shima` など）で
 * **1軒も建たず、建っても20タイル以上離れて村に見えなかった**。
 * 人が住むなら森は開くはずなので forest も許し、建てたあとに周囲を `grass` に開墾する。
 */
const BUILDING_TERRAIN: readonly Terrain[] = ['grass', 'dirt', 'forest'];
/** 柵は開けた土地にだけ立てる（森の中の柵は意味が分からない） */
const FENCE_TERRAIN: readonly Terrain[] = ['grass', 'dirt'];

/** 建てた建物1件（小道の行き先として使う） */
interface Structure {
  type: PlaceableType;
  /** footprint の左上タイル */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** footprint のタイル index を並べる */
function footprintTiles(x: number, y: number, w: number, h: number): number[] {
  const out: number[] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (!inBounds(x + dx, y + dy)) return [];
      out.push(tileIndex(x + dx, y + dy));
    }
  }
  return out;
}

/**
 * その footprint に建てられるか。
 *
 * - footprint 自身は `allowed` の地形で、まだ塞がれていないこと
 * - footprint から CLEARANCE 以内が全部「歩ける陸」であること
 *   （= 水際・他の建物の隣には建てない。幅1タイルの通路を作らないため）
 */
function canBuildAt(world: IslandWorld, tiles: readonly number[], allowed: readonly Terrain[]): boolean {
  if (tiles.length === 0) return false;
  const own = new Set(tiles);
  for (const i of tiles) {
    const x = i % MAP_W;
    const y = Math.floor(i / MAP_W);
    if (x < 1 || y < 1 || x >= MAP_W - 1 || y >= MAP_H - 1) return false;
    if (!allowed.includes(world.terrainAt(x, y))) return false;
    if (world.isSolid(x, y)) return false;
    // 資源（木の実の木や畑）の上には建てない。資源はこの後に置くので普通は空だが、
    // 復元経路など「資源が既にある world」に対して呼ばれても壊れないようにしておく
    if ((world.resourceAt[i] as number) !== 0) return false;
  }
  const c = STRUCTURE_CLEARANCE;
  for (const i of tiles) {
    const x = i % MAP_W;
    const y = Math.floor(i / MAP_W);
    for (let dy = -c; dy <= c; dy++) {
      for (let dx = -c; dx <= c; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny)) return false;
        if (own.has(tileIndex(nx, ny))) continue;
        if (!world.isWalkableTile(nx, ny)) return false;
      }
    }
  }
  return true;
}

/**
 * 歩行不可の建物を1件建てる。
 *
 * **置いた直後に到達性を再検査する**（AI_CODING.md §8）。
 * 島を分断してしまったらその1件だけ取り消して false を返す。
 * flood fill は1件あたり1回で、建てる件数は10件強なので生成コストへの影響は無視できる。
 */
function tryBuild(
  world: IslandWorld,
  type: PlaceableType,
  x: number,
  y: number,
  w: number,
  h: number,
  allowed: readonly Terrain[],
): Structure | null {
  const tiles = footprintTiles(x, y, w, h);
  if (!canBuildAt(world, tiles, allowed)) return null;

  for (const i of tiles) world.setSolid(i % MAP_W, Math.floor(i / MAP_W), true);
  if (reachableFromSpawn(world).size !== walkableTileCount(world)) {
    for (const i of tiles) world.setSolid(i % MAP_W, Math.floor(i / MAP_W), false);
    return null;
  }

  world.addPlaceable({
    id: world.allocId(),
    type,
    // アンカーは足元中央（`objects.ts` が anchor(0.5, 1) で描く）なので
    // footprint の「下の段のタイル中央」を pos にする。
    // `y + h`（下辺そのもの）にすると他の設置物とタイル中心の基準がずれて、
    // `build.place` の PLACE_MIN_GAP_TILES 判定が半タイルぶん狂う
    pos: { x: x + w / 2, y: y + h - 0.5 },
    ownerId: ISLAND_OWNER,
    attract: PLACE_ATTRACT[type],
  });
  return { type, x, y, w, h };
}

/**
 * 建物のまわりの森を開いて庭にする（forest → grass）。
 *
 * 開くのは footprint の1タイル外側まで。ここを広げると木の実の木が目に見えて減り、
 * 収容力（= 個体数の推移）が変わる（AI_CODING.md §8 の鉄則）。
 * 実測: 1軒あたり4×4=16タイル・全体で60〜100タイルで、木の実の木は数本しか減らない。
 */
function clearYard(world: IslandWorld, s: Structure): void {
  for (let y = s.y - 1; y <= s.y + s.h; y++) {
    for (let x = s.x - 1; x <= s.x + s.w; x++) {
      if (world.terrainAt(x, y) === 'forest') world.setTerrain(x, y, 'grass');
    }
  }
}

/**
 * spawn を広場の中心から南へずらす量（タイル）。
 *
 * 噴水は広場の**中心**に置きたいので、代わりに spawn を動かす。
 * 1タイルだと `build.place` の PLACE_MIN_GAP_TILES=2 に引っかかって
 * **プレイヤーが最初にやること（足元にベンチを置く）ができなくなる**ので、
 * 余裕を見て3タイル南に置く（南＝画面手前なので、噴水がプレイヤーの奥に見える）。
 */
const SPAWN_OFFSET_FROM_PLAZA_CENTER = 3;

/**
 * 広場の中心に噴水を置く（C-2）。
 * spawn と重ならないよう、**噴水ではなく spawn をずらす**（噴水は広場の主役なので中心に据える）。
 */
function placeFountain(world: IslandWorld, cx: number, cy: number): void {
  // 先に spawn を動かす。動かす前に噴水を置くと reachableFromSpawn の起点が
  // 塞がれて空集合になり、到達性検査で必ず取り消されてしまう
  const candidates: readonly (readonly [number, number])[] = [
    [0, SPAWN_OFFSET_FROM_PLAZA_CENTER],
    [0, -SPAWN_OFFSET_FROM_PLAZA_CENTER],
    [SPAWN_OFFSET_FROM_PLAZA_CENTER, 0],
    [-SPAWN_OFFSET_FROM_PLAZA_CENTER, 0],
  ];
  for (const [dx, dy] of candidates) {
    const nx = cx + dx;
    const ny = cy + dy;
    if (world.terrainAt(nx, ny) !== 'plaza' || !world.isWalkableTile(nx, ny)) continue;
    world.spawn = { x: nx + 0.5, y: ny + 0.5 };
    if (tryBuild(world, 'fountain', cx, cy, 1, 1, ['plaza'])) return;
    // 置けなかったら spawn を戻して次の候補へ
    world.spawn = { x: cx + 0.5, y: cy + 0.5 };
  }
}

/**
 * 家・風車を広場のまわりに決定論的に置く。
 *
 * 角度を等分して外へ向かって探す。素直に「1点だけ試す」と地形が合わずほとんど建たないので、
 * 角度のゆらぎ×距離で候補を並べて最初に建てられた場所を採用する。
 */
function placeBuildings(world: IslandWorld, rng: Rng, cx: number, cy: number): Structure[] {
  const out: Structure[] = [];

  // seed ごとに村の向きが変わるように位相をずらす
  const baseAngle = rng.range(0, Math.PI * 2);
  const count = rng.int(HOUSE_MIN, HOUSE_MAX);
  const jitters: readonly number[] = [0, 0.12, -0.12, 0.26, -0.26, 0.42, -0.42];
  const allowed = BUILDING_TERRAIN;

  for (let k = 0; k < count; k++) {
    const slot = baseAngle + (k * Math.PI * 2) / count;
    const type = HOUSE_TYPES[k % HOUSE_TYPES.length] as PlaceableType;
    let built: Structure | null = null;
    for (const j of jitters) {
      for (let d = HOUSE_DIST_MIN; d <= HOUSE_DIST_MAX && !built; d++) {
        const a = slot + j;
        const x = Math.round(cx + Math.cos(a) * d) - Math.floor(BUILDING_SIZE / 2);
        const y = Math.round(cy + Math.sin(a) * d) - Math.floor(BUILDING_SIZE / 2);
        built = tryBuild(world, type, x, y, BUILDING_SIZE, BUILDING_SIZE, allowed);
      }
      if (built) break;
    }
    if (built) {
      clearYard(world, built);
      out.push(built);
    }
  }

  // 風車1基。家の間（半スロットずらした角度）の外側に置く
  const windmillAngle = baseAngle + Math.PI / count;
  let windmill: Structure | null = null;
  for (const j of jitters) {
    for (let d = WINDMILL_DIST_MIN; d <= WINDMILL_DIST_MAX && !windmill; d++) {
      const a = windmillAngle + j;
      const x = Math.round(cx + Math.cos(a) * d) - Math.floor(BUILDING_SIZE / 2);
      const y = Math.round(cy + Math.sin(a) * d) - Math.floor(BUILDING_SIZE / 2);
      windmill = tryBuild(world, 'windmill', x, y, BUILDING_SIZE, BUILDING_SIZE, allowed);
    }
    if (windmill) break;
  }
  if (windmill) {
    clearYard(world, windmill);
    out.push(windmill);
  }

  return out;
}

/**
 * 家の前に柵を1本立てる。
 *
 * 柵は1タイル=1設置物（絵が `obj_fence_h` / `obj_fence_v` の2種しかないため）。
 * ただし**1本まとめて1つの footprint として検査する**（隣同士なので CLEARANCE を内側には効かせない）。
 */
function placeFences(world: IslandWorld, houses: readonly Structure[], cx: number, cy: number): number {
  const allowed = FENCE_TERRAIN;
  let placed = 0;

  for (const h of houses) {
    if (placed >= FENCE_HOUSES) break;
    const hx = h.x + h.w / 2;
    const hy = h.y + h.h / 2;
    // 広場から見て家の外側へ伸ばす（家と広場の間を塞ぐと小道と喧嘩する）
    const vx = hx - cx;
    const vy = hy - cy;
    const len = Math.hypot(vx, vy) || 1;
    // 柵は放射方向に対して直交させる（家の前を横切るように見える）
    const horizontal = Math.abs(vx) < Math.abs(vy);
    const type: PlaceableType = horizontal ? 'fence_h' : 'fence_v';

    let done = false;
    for (const off of [FENCE_OFFSET, FENCE_OFFSET + 1] as const) {
      if (done) break;
      const bx = Math.round(hx + (vx / len) * off);
      const by = Math.round(hy + (vy / len) * off);
      const x0 = horizontal ? bx - Math.floor(FENCE_LENGTH / 2) : bx;
      const y0 = horizontal ? by : by - Math.floor(FENCE_LENGTH / 2);
      const w = horizontal ? FENCE_LENGTH : 1;
      const hh = horizontal ? 1 : FENCE_LENGTH;

      const tiles = footprintTiles(x0, y0, w, hh);
      if (!canBuildAt(world, tiles, allowed)) continue;
      for (const i of tiles) world.setSolid(i % MAP_W, Math.floor(i / MAP_W), true);
      if (reachableFromSpawn(world).size !== walkableTileCount(world)) {
        for (const i of tiles) world.setSolid(i % MAP_W, Math.floor(i / MAP_W), false);
        continue;
      }
      for (const i of tiles) {
        const tx = i % MAP_W;
        const ty = Math.floor(i / MAP_W);
        world.addPlaceable({
          id: world.allocId(),
          type,
          // 1タイルなのでタイル中心。他の設置物と同じ基準にする
          pos: { x: tx + 0.5, y: ty + 0.5 },
          ownerId: ISLAND_OWNER,
          attract: PLACE_ATTRACT[type],
        });
      }
      placed++;
      done = true;
    }
  }
  return placed;
}

/**
 * 小道を `dirt` で塗る（C-1）。
 *
 * 新しい地形（`tile_path`）を足すと B-2 の遷移タイルが16枚必要になるので、既存の `dirt` を使う。
 *
 * 塗るのは grass と forest。広場のまわりが森のseedでは、grass だけにすると
 * **家までの小道が途切れて道に見えなかった**。
 * ⚠️ forest を塗ると木の実の木が減って収容力が変わる（AI_CODING.md §8）ので、
 * この関数は**資源を置いた後**に呼び、資源が乗っているタイルは塗らない。
 * こうすると木は forest タイルの上に残り、木の実の木の本数は1本も変わらない（実測で確認）。
 */
const PATH_TERRAIN: readonly Terrain[] = ['grass', 'forest'];

function paintPathTile(world: IslandWorld, x: number, y: number): void {
  if (!inBounds(x, y)) return;
  if (!PATH_TERRAIN.includes(world.terrainAt(x, y))) return;
  if ((world.resourceAt[tileIndex(x, y)] as number) !== 0) return;
  world.setTerrain(x, y, 'dirt');
}

/** 広場の中心から建物の足元へ、幅 PATH_WIDTH の小道を1本引く */
function carvePath(world: IslandWorld, fromX: number, fromY: number, toX: number, toY: number): void {
  const dist = Math.hypot(toX - fromX, toY - fromY);
  // 1タイルに2サンプル。粗いと斜めの道が点線になる
  const steps = Math.max(1, Math.ceil(dist * 2));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = Math.round(fromX + (toX - fromX) * t);
    const py = Math.round(fromY + (toY - fromY) * t);
    for (let dy = 0; dy < PATH_WIDTH; dy++) {
      for (let dx = 0; dx < PATH_WIDTH; dx++) paintPathTile(world, px + dx, py + dy);
    }
  }
}

/** 広場の中心（噴水の位置）。spawn は placeFountain で南へずれるので別に持ち回す */
interface Village {
  cx: number;
  cy: number;
  buildings: Structure[];
}

/** 建物を置く（家・風車・柵・噴水）。戻り値は小道を引くための建物一覧 */
function placeVillage(world: IslandWorld, rng: Rng): Village {
  const cx = Math.floor(world.spawn.x);
  const cy = Math.floor(world.spawn.y);
  placeFountain(world, cx, cy);
  const buildings = placeBuildings(world, rng, cx, cy);
  placeFences(world, buildings, cx, cy);
  return { cx, cy, buildings };
}

/** 広場から畑へ引く農道の本数。3本以上だと広場の周りが土だらけになる */
const FARM_TRAIL_COUNT = 2;

/**
 * 広場から各建物へ小道を引く。資源を置いた**後**に呼ぶ（畑や木を塗り潰さないため）。
 *
 * 建物への小道だけだと2〜4タイルの短い枝になって「道」に見えないので、
 * 近くの畑（`field`）まで届く農道も引く。行き先があると道らしく見える。
 */
function carveVillagePaths(world: IslandWorld, village: Village): void {
  const cx = village.cx;
  const cy = village.cy;
  for (const b of village.buildings) {
    // 行き先は footprint の下辺中央（玄関の前）
    carvePath(world, cx, cy, Math.floor(b.x + b.w / 2), b.y + b.h);
  }

  // 近い畑から順に FARM_TRAIL_COUNT 本。Map の反復順は挿入順で決定論的なので sort も決定論的
  const fields = [...world.resources.values()]
    .filter((r) => r.type === 'field')
    .map((r) => ({ x: Math.floor(r.pos.x), y: Math.floor(r.pos.y), d: Math.hypot(r.pos.x - cx, r.pos.y - cy) }))
    .sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x)
    .slice(0, FARM_TRAIL_COUNT);
  for (const f of fields) carvePath(world, cx, cy, f.x, f.y);
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
      finishIsland(world, rng);
      return world;
    }
  }

  // 5回試しても足りなかった場合は最後の島をそのまま使う（生成が止まるより良い）
  const world = last as IslandWorld;
  finishIsland(world, world.rng);
  return world;
}

/**
 * 孤島を沈めたあとの仕上げ。順番に意味がある:
 *   1. 集落（歩行不可なので、資源より先に置いて資源が建物の下に来ないようにする）
 *   2. 資源（`reachable` は建物を除いた集合で計算する）
 *   3. 小道（資源の乗ったタイルを避けて塗るので、資源より後）
 */
function finishIsland(world: IslandWorld, rng: Rng): void {
  const village = placeVillage(world, rng);
  placeResources(world, rng, reachableFromSpawn(world));
  carveVillagePaths(world, village);
}
