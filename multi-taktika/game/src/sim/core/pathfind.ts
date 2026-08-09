/**
 * sim/core/pathfind.ts — 経路探索（T-M3-07。実装手順書 §13.2 M3）
 *
 * 2 段構成:
 *  1. **粗経路**: 8×8 マスの「セクタ」を頂点にした A*。セクタは `grid.ts` の
 *     近傍検索セルと同じ刻み（`GRID_CELL_TILES`）なので、両者の添字計算が一致する。
 *  2. **細経路**: 粗経路が通ったセクタ（＋1 セクタの余裕）に**探索範囲を限定した** A*。
 *     限定に失敗した場合だけ、ノード上限付きで全域 A* に落とす。
 *  3. **局所回避**: 経路上の 1 歩が塞がっていたときの押し出し・迂回は
 *     `systems/movement.ts` が毎 tick 行う（このファイルは経路だけを返す）。
 *
 * ■ 決定論（ここが本題）
 *  - コストはすべて整数（平地 1 マス = `COST_STRAIGHT` = 10）。浮動小数を使わない。
 *  - オープンリストはバイナリヒープだが、比較を **(f, タイル添字) の辞書順**にして
 *    全順序にしている。タイル添字 = ty * width + tx なので、
 *    同コストのタイブレークは自動的に **(y, x) 昇順**になる（§16-2）。
 *  - 近傍の展開順も 8 方向を固定順（dy 昇順 → dx 昇順）で回す。
 *  - 探索用の作業配列は `MapState` ごとに 1 つキャッシュする。**世代印**（`gen`）方式で
 *    毎回のゼロ埋めを避けるが、結果は毎回ゼロ埋めした場合と同一になる。
 *
 * ■ キャッシュと壁の穴
 *  セクタ開通表は `passable` から作る派生データなので、壁の建設・破壊で
 *  `passable` が変わったら `invalidatePathfinder(map)` を呼ぶこと（M10 への申し送り）。
 *  World の状態ではないため、状態ハッシュの対象外。
 */

import { GRID_CELL_TILES } from './grid';
import { idiv, isqrt } from './fx';
import type { MapState } from './world';
import type { MoveMask } from './terrain';
import { cfgNum } from './config';
import {
  COST_DIAGONAL,
  COST_STRAIGHT,
  Move,
  hasTerrain,
  isPassableIndex,
  nearestPassable,
  tileIndex,
  tileMoveCost,
} from './terrain';

/** セクタ 1 辺のマス数。`grid.ts` のセルと同じ 8。 */
export const SECTOR_TILES = GRID_CELL_TILES;

/** 移動ビットの組み合わせ数（`Pass.Land | Pass.Wheeled | Pass.Ship` の 3bit 分）。 */
const MASK_SLOTS = 8;

/** 探索結果の種別。 */
export const PathStatus = {
  /** 目標まで到達する経路が出た。 */
  Found: 0,
  /**
   * 途中まで（ノード上限に当たった / 目標が到達不能で最も近づける所まで）。
   * 呼び出し側は「そこまで進んでから再探索」する。
   */
  Partial: 1,
  /** どこへも進めない（自分の足元が塞がれている等）。 */
  Unreachable: 2,
  /** すでに目標マスにいる。 */
  AlreadyThere: 3,
} as const;
export type PathStatusId = (typeof PathStatus)[keyof typeof PathStatus];

/**
 * 探索の作業領域 + セクタ開通表のキャッシュ。
 * **World の状態ではない**（同じ `MapState` から必ず同じ内容が作れる派生データ）。
 */
export interface Pathfinder {
  readonly map: MapState;
  readonly widthTiles: number;
  readonly heightTiles: number;
  readonly tileCount: number;
  readonly sectorCols: number;
  readonly sectorRows: number;
  readonly sectorCount: number;

  /** 移動ビットごとのセクタ開通表（遅延構築。1 = そのセクタに通れるマスがある）。 */
  readonly sectorOpen: (Uint8Array | null)[];
  /** セクタ内の通行可能マス数（隘路判定に使う）。 */
  readonly sectorOpenTiles: (Int32Array | null)[];

  // ---- 細経路 A* の作業領域（世代印方式）----
  readonly gScore: Int32Array;
  readonly cameFrom: Int32Array;
  /** そのタイルを触った世代（`gen` と一致していれば有効）。 */
  readonly seenGen: Int32Array;
  /** そのタイルを確定（closed）した世代。 */
  readonly closedGen: Int32Array;
  readonly heapNode: Int32Array;
  readonly heapF: Int32Array;
  heapSize: number;
  gen: number;

  // ---- 粗経路 A* の作業領域（セクタ数は小さいので毎回ゼロ埋めする）----
  readonly sGScore: Int32Array;
  readonly sCameFrom: Int32Array;
  readonly sSeen: Uint8Array;
  readonly sClosed: Uint8Array;
  readonly sHeapNode: Int32Array;
  readonly sHeapF: Int32Array;
  sHeapSize: number;
  /** 粗経路の結果（セクタ添字の列）。 */
  readonly sectorPath: Int32Array;
  sectorPathLen: number;
  /** 細経路 A* で展開を許すセクタ（1 = 許可）。 */
  readonly allowSector: Uint8Array;
  /** 直近の探索で展開したノード数（性能テストとデバッグ用）。 */
  expanded: number;
  /**
   * 直近の細経路探索で「最も目標に近づけたノード」。
   * `Found` のときは目標そのもの。`Partial` のときは部分経路の終点になる。
   */
  bestNode: number;
}

/** 8 近傍のオフセット。**この順序を変えない**（dy 昇順 → dx 昇順）。 */
const NX: readonly number[] = [-1, 0, 1, -1, 1, -1, 0, 1];
const NY: readonly number[] = [-1, -1, -1, 0, 0, 1, 1, 1];
/** 斜めか（`NX`/`NY` と同じ並び）。 */
const NDIAG: readonly boolean[] = [true, false, true, false, false, true, false, true];

const cache = new WeakMap<MapState, Pathfinder>();

/**
 * `MapState` に対応する Pathfinder を返す（初回は確保、以降は使い回し）。
 * 地形が未確保なら例外にする（黙って空の経路を返すと原因が追いにくい）。
 */
export function getPathfinder(map: MapState): Pathfinder {
  const hit = cache.get(map);
  if (hit !== undefined && hit.tileCount === map.tiles.length) return hit;
  if (!hasTerrain(map)) {
    throw new Error('getPathfinder: 地形が未確保（mapgen の allocateTerrain より先に呼ばれた）');
  }
  const pf = createPathfinder(map);
  cache.set(map, pf);
  return pf;
}

/**
 * セクタ開通表を捨てる。壁・建物の設置/ 破壊で `passable` を変えたら呼ぶ（M10）。
 * 作業領域はそのまま使い回す。
 */
export function invalidatePathfinder(map: MapState): void {
  const pf = cache.get(map);
  if (pf === undefined) return;
  for (let m = 0; m < MASK_SLOTS; m++) {
    pf.sectorOpen[m] = null;
    pf.sectorOpenTiles[m] = null;
  }
}

function createPathfinder(map: MapState): Pathfinder {
  const w = map.widthTiles;
  const h = map.heightTiles;
  const tileCount = w * h;
  const sectorCols = Math.max(1, Math.ceil(w / SECTOR_TILES));
  const sectorRows = Math.max(1, Math.ceil(h / SECTOR_TILES));
  const sectorCount = sectorCols * sectorRows;
  return {
    map,
    widthTiles: w,
    heightTiles: h,
    tileCount,
    sectorCols,
    sectorRows,
    sectorCount,
    sectorOpen: new Array<Uint8Array | null>(MASK_SLOTS).fill(null),
    sectorOpenTiles: new Array<Int32Array | null>(MASK_SLOTS).fill(null),
    gScore: new Int32Array(tileCount),
    cameFrom: new Int32Array(tileCount),
    seenGen: new Int32Array(tileCount),
    closedGen: new Int32Array(tileCount),
    heapNode: new Int32Array(tileCount + 1),
    heapF: new Int32Array(tileCount + 1),
    heapSize: 0,
    gen: 0,
    sGScore: new Int32Array(sectorCount),
    sCameFrom: new Int32Array(sectorCount),
    sSeen: new Uint8Array(sectorCount),
    sClosed: new Uint8Array(sectorCount),
    sHeapNode: new Int32Array(sectorCount + 1),
    sHeapF: new Int32Array(sectorCount + 1),
    sHeapSize: 0,
    sectorPath: new Int32Array(sectorCount),
    sectorPathLen: 0,
    allowSector: new Uint8Array(sectorCount),
    expanded: 0,
    bestNode: -1,
  };
}

/** 経路探索の作業領域の合計バイト数（メモリ計上用）。 */
export function pathfinderByteLength(pf: Pathfinder): number {
  let n =
    pf.gScore.byteLength +
    pf.cameFrom.byteLength +
    pf.seenGen.byteLength +
    pf.closedGen.byteLength +
    pf.heapNode.byteLength +
    pf.heapF.byteLength +
    pf.sGScore.byteLength +
    pf.sCameFrom.byteLength +
    pf.sSeen.byteLength +
    pf.sClosed.byteLength +
    pf.sHeapNode.byteLength +
    pf.sHeapF.byteLength +
    pf.sectorPath.byteLength +
    pf.allowSector.byteLength;
  for (let m = 0; m < MASK_SLOTS; m++) {
    n += pf.sectorOpen[m]?.byteLength ?? 0;
    n += pf.sectorOpenTiles[m]?.byteLength ?? 0;
  }
  return n;
}

// ---------------------------------------------------------------- セクタ

/** 移動ビット → キャッシュのスロット（Land|Wheeled|Ship の 3bit）。 */
function maskSlot(mask: MoveMask): number {
  return mask & (MASK_SLOTS - 1);
}

/** タイル添字 → セクタ添字。 */
export function sectorOfTile(pf: Pathfinder, index: number): number {
  const tx = index % pf.widthTiles;
  const ty = (index - tx) / pf.widthTiles;
  return sectorOfXY(pf, tx, ty);
}

/** マス座標 → セクタ添字。 */
export function sectorOfXY(pf: Pathfinder, tx: number, ty: number): number {
  const sc = idiv(tx, SECTOR_TILES);
  const sr = idiv(ty, SECTOR_TILES);
  return sr * pf.sectorCols + sc;
}

/**
 * セクタ開通表を得る（未構築なら作る）。
 * 1 = そのセクタに `mask` で通れるマスが 1 つ以上ある。
 */
export function getSectorOpen(pf: Pathfinder, mask: MoveMask): Uint8Array {
  const slot = maskSlot(mask);
  const hit = pf.sectorOpen[slot];
  if (hit !== null && hit !== undefined) return hit;
  const open = new Uint8Array(pf.sectorCount);
  const tiles = new Int32Array(pf.sectorCount);
  const map = pf.map;
  for (let ty = 0; ty < pf.heightTiles; ty++) {
    const sr = idiv(ty, SECTOR_TILES) * pf.sectorCols;
    const row = ty * pf.widthTiles;
    for (let tx = 0; tx < pf.widthTiles; tx++) {
      if (!isPassableIndex(map, row + tx, mask)) continue;
      const s = sr + idiv(tx, SECTOR_TILES);
      open[s] = 1;
      tiles[s] = tiles[s]! + 1;
    }
  }
  pf.sectorOpen[slot] = open;
  pf.sectorOpenTiles[slot] = tiles;
  return open;
}

/** セクタ内の通行可能マス数（隘路判定用）。 */
export function getSectorOpenTiles(pf: Pathfinder, mask: MoveMask): Int32Array {
  getSectorOpen(pf, mask);
  return pf.sectorOpenTiles[maskSlot(mask)]!;
}

// ---------------------------------------------------------------- ヒープ

/** (f, node) の辞書順で a が先か。node が一意なので全順序になる。 */
function heapLess(fa: number, na: number, fb: number, nb: number): boolean {
  return fa < fb || (fa === fb && na < nb);
}

function heapPush(f: Int32Array, n: Int32Array, size: number, node: number, fv: number): number {
  let i = size;
  f[i] = fv;
  n[i] = node;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heapLess(f[i]!, n[i]!, f[parent]!, n[parent]!)) {
      const tf = f[parent]!;
      const tn = n[parent]!;
      f[parent] = f[i]!;
      n[parent] = n[i]!;
      f[i] = tf;
      n[i] = tn;
      i = parent;
    } else break;
  }
  return size + 1;
}

/** 最小要素を `n[size - 1]` の位置へ退避して返す（呼び出し側が size を減らす）。 */
function heapPop(f: Int32Array, n: Int32Array, size: number): number {
  const top = n[0]!;
  const last = size - 1;
  f[0] = f[last]!;
  n[0] = n[last]!;
  let i = 0;
  for (;;) {
    const l = i * 2 + 1;
    const r = l + 1;
    let best = i;
    if (l < last && heapLess(f[l]!, n[l]!, f[best]!, n[best]!)) best = l;
    if (r < last && heapLess(f[r]!, n[r]!, f[best]!, n[best]!)) best = r;
    if (best === i) break;
    const tf = f[best]!;
    const tn = n[best]!;
    f[best] = f[i]!;
    n[best] = n[i]!;
    f[i] = tf;
    n[i] = tn;
    i = best;
  }
  return top;
}

/** オクタイル距離のヒューリスティック（整数。実距離を上回らない）。 */
function octile(dx: number, dy: number): number {
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  const lo = ax < ay ? ax : ay;
  const hi = ax < ay ? ay : ax;
  return COST_DIAGONAL * lo + COST_STRAIGHT * (hi - lo);
}

// ---------------------------------------------------------------- 粗経路

/**
 * セクタ単位の粗経路を `pf.sectorPath` に入れる。見つかれば true。
 * 到達不能なら false（このとき `sectorPathLen` は 0）。
 */
export function findSectorPath(
  pf: Pathfinder,
  mask: MoveMask,
  fromSector: number,
  toSector: number,
  bannedSector: number,
): boolean {
  const open = getSectorOpen(pf, mask);
  pf.sectorPathLen = 0;
  if (open[fromSector] !== 1 || open[toSector] !== 1) return false;
  if (fromSector === bannedSector || toSector === bannedSector) return false;
  if (fromSector === toSector) {
    pf.sectorPath[0] = fromSector;
    pf.sectorPathLen = 1;
    return true;
  }

  pf.sSeen.fill(0);
  pf.sClosed.fill(0);
  pf.sHeapSize = 0;
  const cols = pf.sectorCols;
  const rows = pf.sectorRows;
  const gx = toSector % cols;
  const gy = (toSector - gx) / cols;

  pf.sGScore[fromSector] = 0;
  pf.sCameFrom[fromSector] = -1;
  pf.sSeen[fromSector] = 1;
  const fx0 = (fromSector % cols) - gx;
  const fy0 = idiv(fromSector - (fromSector % cols), cols) - gy;
  pf.sHeapSize = heapPush(pf.sHeapF, pf.sHeapNode, pf.sHeapSize, fromSector, octile(fx0, fy0));

  while (pf.sHeapSize > 0) {
    const cur = heapPop(pf.sHeapF, pf.sHeapNode, pf.sHeapSize);
    pf.sHeapSize -= 1;
    if (pf.sClosed[cur] === 1) continue;
    pf.sClosed[cur] = 1;
    if (cur === toSector) return unwindSectors(pf, fromSector, toSector);
    const cx = cur % cols;
    const cy = (cur - cx) / cols;
    const g = pf.sGScore[cur]!;
    for (let k = 0; k < 8; k++) {
      const nx = cx + NX[k]!;
      const ny = cy + NY[k]!;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ns = ny * cols + nx;
      if (open[ns] !== 1 || ns === bannedSector || pf.sClosed[ns] === 1) continue;
      // 斜めは角抜けを禁止（両隣のセクタが開いていること）
      if (NDIAG[k]! && (open[cy * cols + nx] !== 1 || open[ny * cols + cx] !== 1)) continue;
      const ng = g + (NDIAG[k]! ? COST_DIAGONAL : COST_STRAIGHT);
      if (pf.sSeen[ns] === 1 && ng >= pf.sGScore[ns]!) continue;
      pf.sSeen[ns] = 1;
      pf.sGScore[ns] = ng;
      pf.sCameFrom[ns] = cur;
      pf.sHeapSize = heapPush(
        pf.sHeapF,
        pf.sHeapNode,
        pf.sHeapSize,
        ns,
        ng + octile(nx - gx, ny - gy),
      );
    }
  }
  return false;
}

function unwindSectors(pf: Pathfinder, fromSector: number, toSector: number): boolean {
  let n = 0;
  let s = toSector;
  const tmp = pf.sectorPath;
  for (;;) {
    tmp[n] = s;
    n += 1;
    if (s === fromSector) break;
    const prev = pf.sCameFrom[s]!;
    if (prev < 0 || n >= tmp.length) return false;
    s = prev;
  }
  // 逆順を反転して from → to にする
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const t = tmp[i]!;
    tmp[i] = tmp[j]!;
    tmp[j] = t;
  }
  pf.sectorPathLen = n;
  return true;
}

/**
 * `from` から `to` へセクタ単位で到達できるか（`banned` セクタは通れない扱い）。
 * mapgen の隘路検査（T-M3-05）が使う。
 */
export function sectorsConnected(
  pf: Pathfinder,
  mask: MoveMask,
  fromSector: number,
  toSector: number,
  bannedSector: number,
): boolean {
  return findSectorPath(pf, mask, fromSector, toSector, bannedSector);
}

// ---------------------------------------------------------------- 細経路

/** 探索で展開するノード数の上限（既定値。`pathfind.maxNodes` があればそちら）。 */
const MAX_NODES = cfgNum('pathfind.maxNodes');

/** 目標が塞がっていたときに振り替え先を探す半径（マス）。 */
const GOAL_SEARCH_RADIUS = cfgNum('pathfind.goalSearchRadiusTiles');

/** 粗経路のセクタを何セクタ分ふくらませて細経路の探索範囲にするか。 */
const CORRIDOR_DILATE = cfgNum('pathfind.corridorDilateSectors');

/**
 * 細経路を一度に引く長さ（セクタ数）。
 *
 * **なぜ区切るか**: 400 マップの端から端まで（約 50 セクタ）を 1 回の A* で引くと
 * 1 本あたり 4,000 ノード以上を展開し、1 体 1ms 近くかかる。
 * 保持できる経路点は 12 個までなので、遠くまで引いても無駄になる。
 * そこで手前 `HORIZON_SECTORS` セクタ分だけ引いて `Partial` を返し、
 * 歩き切ったところで呼び出し側が引き直す（粗経路は毎回引くが、セクタ数は 1/64 なので安い）。
 */
const HORIZON_SECTORS = cfgNum('pathfind.horizonSectors');

/**
 * 経路を探す。`out` に**目標へ向かう順**でタイル添字（方向が変わる点だけ）を入れる。
 * 出発マスは含めない。戻り値は `PathStatus`。
 *
 * 見つからないときの扱い（T-M3-07 の「経路が見つからない場合」）:
 *  - 目標マスが塞がっている  → 半径 `GOAL_SEARCH_RADIUS` で最寄りの通行可能マスへ振り替える。
 *  - それでも到達できない    → **最も目標に近づけた地点までの部分経路**を返し `Partial`。
 *    movement 側は部分経路を歩き切ったところで再探索し、2 回連続で進めなければ
 *    目標を諦めて待機状態に戻す（無限に再探索して負荷を食わないため）。
 *  - 出発マス自体が塞がっている → `Unreachable`（押し出しに任せる）。
 */
export function findPath(
  pf: Pathfinder,
  mask: MoveMask,
  startTx: number,
  startTy: number,
  goalTx: number,
  goalTy: number,
  out: number[],
): PathStatusId {
  out.length = 0;
  const map = pf.map;
  const w = pf.widthTiles;
  const h = pf.heightTiles;
  if (startTx < 0 || startTy < 0 || startTx >= w || startTy >= h) return PathStatus.Unreachable;

  const start = startTy * w + startTx;
  if (!isPassableIndex(map, start, mask)) return PathStatus.Unreachable;

  let goal = -1;
  if (goalTx >= 0 && goalTy >= 0 && goalTx < w && goalTy < h) {
    goal = tileIndex(map, goalTx, goalTy);
    if (!isPassableIndex(map, goal, mask)) {
      goal = nearestPassable(map, goalTx, goalTy, mask, GOAL_SEARCH_RADIUS);
    }
  } else {
    goal = nearestPassable(
      map,
      goalTx < 0 ? 0 : goalTx >= w ? w - 1 : goalTx,
      goalTy < 0 ? 0 : goalTy >= h ? h - 1 : goalTy,
      mask,
      GOAL_SEARCH_RADIUS,
    );
  }
  if (goal < 0) return PathStatus.Unreachable;
  if (goal === start) return PathStatus.AlreadyThere;

  // 1 段目: 粗経路。通ったセクタを「展開を許す範囲」にする。
  const startSector = sectorOfTile(pf, start);
  const goalSector = sectorOfTile(pf, goal);
  const coarse = findSectorPath(pf, mask, startSector, goalSector, -1);
  if (coarse) {
    // 遠すぎる目標は手前のセクタで区切る（1 回の探索を有界にする）
    let fineGoal = goal;
    let truncated = false;
    if (pf.sectorPathLen > HORIZON_SECTORS + 1) {
      const near = pickTileInSector(pf, mask, pf.sectorPath[HORIZON_SECTORS]!);
      if (near >= 0 && near !== start) {
        fineGoal = near;
        truncated = true;
      }
    }
    buildCorridor(pf, truncated ? HORIZON_SECTORS + 1 : pf.sectorPathLen);
    const st = fineAStar(pf, mask, start, fineGoal, true);
    if (st === PathStatus.Found) {
      emitPath(pf, start, fineGoal, out);
      // 区切った場合は「まだ先がある」ので Partial を返す（呼び出し側が引き直す）
      return truncated ? PathStatus.Partial : PathStatus.Found;
    }
  }

  // 2 段目: 範囲限定で失敗したら全域探索（ノード上限つき）。
  const st = fineAStar(pf, mask, start, goal, false);
  if (st === PathStatus.Unreachable) return PathStatus.Unreachable;
  emitPath(pf, start, pf.bestNode, out);
  return st === PathStatus.Found ? PathStatus.Found : PathStatus.Partial;
}

/** セクタの中心にいちばん近い通行可能マス（無ければ -1）。 */
function pickTileInSector(pf: Pathfinder, mask: MoveMask, sector: number): number {
  const cols = pf.sectorCols;
  const sx = sector % cols;
  const sy = (sector - sx) / cols;
  const cx = sx * SECTOR_TILES + (SECTOR_TILES >> 1);
  const cy = sy * SECTOR_TILES + (SECTOR_TILES >> 1);
  return nearestPassable(pf.map, cx, cy, mask, SECTOR_TILES);
}

/** 粗経路のセクタ列（先頭 `len` 個）±`CORRIDOR_DILATE` を `allowSector` に立てる。 */
function buildCorridor(pf: Pathfinder, len: number): void {
  pf.allowSector.fill(0);
  const cols = pf.sectorCols;
  const rows = pf.sectorRows;
  const n = len < pf.sectorPathLen ? len : pf.sectorPathLen;
  for (let i = 0; i < n; i++) {
    const s = pf.sectorPath[i]!;
    const sx = s % cols;
    const sy = (s - sx) / cols;
    for (let dy = -CORRIDOR_DILATE; dy <= CORRIDOR_DILATE; dy++) {
      const y = sy + dy;
      if (y < 0 || y >= rows) continue;
      for (let dx = -CORRIDOR_DILATE; dx <= CORRIDOR_DILATE; dx++) {
        const x = sx + dx;
        if (x < 0 || x >= cols) continue;
        pf.allowSector[y * cols + x] = 1;
      }
    }
  }
}

/**
 * 細経路 A*。`restrict` が true なら `allowSector` の内側だけを展開する。
 * 経路は `cameFrom` に残る。到達できなかった場合、最も目標に近づけたノードを
 * `pf.bestNode` に入れて `Partial` を返す。
 */
function fineAStar(
  pf: Pathfinder,
  mask: MoveMask,
  start: number,
  goal: number,
  restrict: boolean,
): PathStatusId {
  const map = pf.map;
  const w = pf.widthTiles;
  const h = pf.heightTiles;
  const gx = goal % w;
  const gy = (goal - gx) / w;
  pf.gen += 1;
  const gen = pf.gen;
  pf.heapSize = 0;
  pf.expanded = 0;

  pf.gScore[start] = 0;
  pf.cameFrom[start] = -1;
  pf.seenGen[start] = gen;
  const sx0 = start % w;
  const sy0 = (start - sx0) / w;
  let bestNode = start;
  let bestH = octile(sx0 - gx, sy0 - gy);
  pf.heapSize = heapPush(pf.heapF, pf.heapNode, pf.heapSize, start, bestH);

  while (pf.heapSize > 0) {
    const cur = heapPop(pf.heapF, pf.heapNode, pf.heapSize);
    pf.heapSize -= 1;
    if (pf.closedGen[cur] === gen) continue;
    pf.closedGen[cur] = gen;
    pf.expanded += 1;
    if (cur === goal) {
      pf.bestNode = goal;
      return PathStatus.Found;
    }
    if (pf.expanded >= MAX_NODES) break;

    const cx = cur % w;
    const cy = (cur - cx) / w;
    const g = pf.gScore[cur]!;
    for (let k = 0; k < 8; k++) {
      const nx = cx + NX[k]!;
      const ny = cy + NY[k]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (pf.closedGen[ni] === gen) continue;
      if (!isPassableIndex(map, ni, mask)) continue;
      if (restrict && pf.allowSector[sectorOfXY(pf, nx, ny)] !== 1) continue;
      if (NDIAG[k]!) {
        // 角抜け禁止: 斜めに動くには両隣も通れる必要がある
        if (!isPassableIndex(map, cy * w + nx, mask)) continue;
        if (!isPassableIndex(map, ny * w + cx, mask)) continue;
      }
      const base = tileMoveCost(map.tiles[ni]!);
      const step = NDIAG[k]! ? idiv(base * COST_DIAGONAL, COST_STRAIGHT) : base;
      const ng = g + step;
      if (pf.seenGen[ni] === gen && ng >= pf.gScore[ni]!) continue;
      pf.seenGen[ni] = gen;
      pf.gScore[ni] = ng;
      pf.cameFrom[ni] = cur;
      const hh = octile(nx - gx, ny - gy);
      // より目標に近いノードを覚える。同じ近さなら添字の小さい方（= (y,x) 昇順）。
      if (hh < bestH || (hh === bestH && ni < bestNode)) {
        bestH = hh;
        bestNode = ni;
      }
      pf.heapSize = heapPush(pf.heapF, pf.heapNode, pf.heapSize, ni, ng + hh);
    }
  }

  pf.bestNode = bestNode;
  if (bestNode === start) return PathStatus.Unreachable;
  return PathStatus.Partial;
}

/**
 * `cameFrom` を辿って `out` に入れる。**方向が変わる点だけ**を残す
 * （直線の途中を全部持つと毎 tick の追従が無駄に重くなる）。
 */
function emitPath(pf: Pathfinder, start: number, end: number, out: number[]): void {
  out.length = 0;
  if (end === start) return;
  const w = pf.widthTiles;
  // まず末尾から並べる
  const rev: number[] = [];
  let cur = end;
  let guard = 0;
  while (cur !== start && cur >= 0 && guard <= pf.tileCount) {
    rev.push(cur);
    cur = pf.cameFrom[cur]!;
    guard += 1;
  }
  if (cur !== start) return; // 経路が壊れている（起きたら実装バグ）
  // 反転しつつ方向変化点だけ残す
  let prev = start;
  let lastDx = 0;
  let lastDy = 0;
  for (let i = rev.length - 1; i >= 0; i--) {
    const node = rev[i]!;
    const px = prev % w;
    const py = (prev - px) / w;
    const nx = node % w;
    const ny = (node - nx) / w;
    const dx = nx - px;
    const dy = ny - py;
    if (dx !== lastDx || dy !== lastDy) {
      // 曲がり角なので新しい点として残す
      out.push(node);
      lastDx = dx;
      lastDy = dy;
    } else {
      // 同じ方向に進むだけ → 直前の点を今の点で置き換える（直線を圧縮）
      out[out.length - 1] = node;
    }
    prev = node;
  }
}

/**
 * `startTile` から `mask` で到達できるマスを塗る（幅優先。T-M3-05 の通行検査用）。
 * `out` は長さ `tileCount` の Uint8Array（1 = 到達可能）。塗ったマス数を返す。
 *
 * 走査順はキュー順（= タイル添字の昇順に近い決定的な順）で、結果は順序に依存しない。
 */
export function computeReachable(
  map: MapState,
  startTile: number,
  mask: MoveMask,
  out: Uint8Array,
  queue: Int32Array,
): number {
  out.fill(0);
  const w = map.widthTiles;
  const h = map.heightTiles;
  if (startTile < 0 || startTile >= w * h) return 0;
  if (!isPassableIndex(map, startTile, mask)) return 0;
  let head = 0;
  let tail = 0;
  out[startTile] = 1;
  queue[tail] = startTile;
  tail += 1;
  let count = 1;
  while (head < tail) {
    const cur = queue[head]!;
    head += 1;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (let k = 0; k < 8; k++) {
      const nx = cx + NX[k]!;
      const ny = cy + NY[k]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (out[ni] === 1) continue;
      if (!isPassableIndex(map, ni, mask)) continue;
      if (NDIAG[k]!) {
        if (!isPassableIndex(map, cy * w + nx, mask)) continue;
        if (!isPassableIndex(map, ny * w + cx, mask)) continue;
      }
      out[ni] = 1;
      queue[tail] = ni;
      tail += 1;
      count += 1;
    }
  }
  return count;
}

/**
 * 2 点のマス距離（整数マス、切り捨て）。令の遅延や到達判定の表示用。
 * `isqrt` を使うのはここだけ（比較は平方距離で行う。§4.2）。
 */
export function tileDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return isqrt(dx * dx + dy * dy);
}

/** 既定の移動種（徒歩）。呼び出し側の可読性のため再輸出する。 */
export const DEFAULT_MOVE_MASK: MoveMask = Move.Land;
