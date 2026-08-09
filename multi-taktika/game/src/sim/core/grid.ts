/**
 * sim/core/grid.ts — 8×8 マス均一グリッドによる近傍検索（実装手順書 §4.4 末尾）
 *
 * 毎 tick `rebuildGrid` で作り直す。作り方は計数ソートなので、
 *  - セル内の要素は **index 昇順**
 *  - 走査はセル (row, col) 昇順 → セル内 index 昇順
 * が保証される。
 *
 * さらに `queryCircle` は最後に結果を index 昇順へ整列して返す。
 * 総当たり（index 昇順で全走査）と **順序まで一致**させるため（T-M2-05）。
 * これにより「グリッドを使うかどうか」で結果順が変わらない = デシンクしない。
 *
 * 距離判定は平方距離で行い `fxSqrt` を使わない（§4.2）。
 */

import type { Entities } from './entity';
import type { Fx } from './fx';
import { FX_ONE, idiv } from './fx';

/** 1 セルの辺の長さ（マス）。 */
export const GRID_CELL_TILES = 8;

/** 1 セルの辺の長さ（Fx）。 */
export const GRID_CELL_SIZE: Fx = GRID_CELL_TILES * FX_ONE;

export interface Grid {
  readonly cellTiles: number;
  readonly cellSize: Fx;
  readonly cols: number;
  readonly rows: number;
  readonly cellCount: number;
  /** 各セルの items 開始位置（長さ cellCount + 1、累積和）。 */
  readonly cellStart: Int32Array;
  /** 詰め込み用カーソル（rebuild 中の作業領域）。 */
  readonly cursor: Int32Array;
  /** セル順に並んだエンティティ index。 */
  readonly items: Int32Array;
  /** items の有効長。 */
  itemCount: number;
  /** 最後に rebuild した tick（デバッグ・二重更新検出用）。-1 = 未構築。 */
  builtTick: number;
}

/** マップの広さ（マス）とエンティティ容量からグリッドを確保する。 */
export function createGrid(widthTiles: number, heightTiles: number, capacity: number): Grid {
  const cols = Math.max(1, Math.ceil(widthTiles / GRID_CELL_TILES));
  const rows = Math.max(1, Math.ceil(heightTiles / GRID_CELL_TILES));
  const cellCount = cols * rows;
  return {
    cellTiles: GRID_CELL_TILES,
    cellSize: GRID_CELL_SIZE,
    cols,
    rows,
    cellCount,
    cellStart: new Int32Array(cellCount + 1),
    cursor: new Int32Array(cellCount),
    items: new Int32Array(capacity),
    itemCount: 0,
    builtTick: -1,
  };
}

/** Fx 座標 → 列番号（範囲外はクランプ）。 */
export function cellCol(g: Grid, x: Fx): number {
  const c = idiv(x, g.cellSize);
  if (c < 0) return 0;
  if (c >= g.cols) return g.cols - 1;
  return c;
}

/** Fx 座標 → 行番号（範囲外はクランプ）。 */
export function cellRow(g: Grid, y: Fx): number {
  const r = idiv(y, g.cellSize);
  if (r < 0) return 0;
  if (r >= g.rows) return g.rows - 1;
  return r;
}

/** Fx 座標 → セル番号。 */
export function cellIndexAt(g: Grid, x: Fx, y: Fx): number {
  return cellRow(g, y) * g.cols + cellCol(g, x);
}

/**
 * グリッドを作り直す（計数ソート、O(生存数 + セル数)）。
 * 生存している全エンティティを対象にする（ユニット・建物・資源・投射物すべて）。
 */
export function rebuildGrid(g: Grid, e: Entities, tick: number): void {
  const { cellStart, cursor, items } = g;
  cellStart.fill(0);

  // 1) 各セルの個数を数える（cellStart[cell + 1] に置く）
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    const cell = cellIndexAt(g, e.x[i]!, e.y[i]!);
    cellStart[cell + 1] = cellStart[cell + 1]! + 1;
  }

  // 2) 累積和 → 開始位置
  for (let c = 0; c < g.cellCount; c++) {
    cellStart[c + 1] = cellStart[c + 1]! + cellStart[c]!;
    cursor[c] = cellStart[c]!;
  }

  // 3) index 昇順に詰める → セル内も index 昇順になる
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    const cell = cellIndexAt(g, e.x[i]!, e.y[i]!);
    items[cursor[cell]!] = i;
    cursor[cell] = cursor[cell]! + 1;
  }

  g.itemCount = cellStart[g.cellCount]!;
  g.builtTick = tick;
}

/**
 * 中心 (cx, cy) 半径 r（Fx）の円内にいるエンティティ index を `out` に入れ、件数を返す。
 * `out` は呼び出し側で再利用する配列（World.scratch）。**index 昇順**で返る。
 *
 * 判定は `dx*dx + dy*dy <= r*r`（平方距離）。
 */
export function queryCircle(
  g: Grid,
  e: Entities,
  cx: Fx,
  cy: Fx,
  r: Fx,
  out: number[]
): number {
  out.length = 0;
  if (r < 0) return 0;
  const rr = r * r;

  const c0 = cellCol(g, cx - r);
  const c1 = cellCol(g, cx + r);
  const r0 = cellRow(g, cy - r);
  const r1 = cellRow(g, cy + r);

  for (let row = r0; row <= r1; row++) {
    const base = row * g.cols;
    for (let col = c0; col <= c1; col++) {
      const cell = base + col;
      const end = g.cellStart[cell + 1]!;
      for (let k = g.cellStart[cell]!; k < end; k++) {
        const i = g.items[k]!;
        if (e.alive[i] !== 1) continue;
        const dx = e.x[i]! - cx;
        const dy = e.y[i]! - cy;
        if (dx * dx + dy * dy <= rr) out.push(i);
      }
    }
  }

  // セル走査順は index 昇順ではないので、総当たりと一致させるために整列する。
  // index は一意なので比較は全順序（タイブレーク不要）。
  out.sort(ascending);
  return out.length;
}

/** 数値昇順の比較関数（`Array.prototype.sort` の既定は文字列順なので必須）。 */
function ascending(a: number, b: number): number {
  return a - b;
}

/**
 * 総当たりによる近傍検索。グリッドの検証（T-M2-05）と、
 * グリッド未構築時のフォールバック用。結果は index 昇順。
 */
export function queryCircleBruteForce(
  e: Entities,
  cx: Fx,
  cy: Fx,
  r: Fx,
  out: number[]
): number {
  out.length = 0;
  if (r < 0) return 0;
  const rr = r * r;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    const dx = e.x[i]! - cx;
    const dy = e.y[i]! - cy;
    if (dx * dx + dy * dy <= rr) out.push(i);
  }
  return out.length;
}
