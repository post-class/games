/**
 * sim/core/terrain.ts — 地形グリッドの定義と判定ヘルパ（T-M3-01。実装手順書 §6.10 / `07§13`）
 *
 * `MapState` は 3 本の並列配列で 1 マスを表す（SoA。添字は `tileIndex` = ty * width + tx）:
 *
 *  - `tiles`     … タイル種別（`Tile`）。見た目と採集・射程補正の根拠。
 *  - `passable`  … 通行ビット（`Pass`）。**地形由来の通行可否と建物による封鎖を 1 本に統合する。**
 *  - `elevation` … 高低（0 = 平地 / 1 = 丘 / 2 = 城壁上）。`combat.highGround` の判定に使う。
 *
 * ■ なぜ「建物による封鎖」も `passable` に入れるのか（M10 への申し送り）
 *   `07§9` の「壁を壊してできた穴は試合中ずっと残る」を素直に実装するには、
 *   通行可否が **「地形」ではなく「今そこに何があるか」** で決まる必要がある。
 *   そこで `Pass.Blocked` ビットを 1 本用意し、
 *     - 壁・建物を建てた       → `blockTiles(map, ..., true)`  でビットを立てる
 *     - 壊れた（跡地になった） → `blockTiles(map, ..., false)` でビットを下ろす
 *   とする。**地形タイルは書き換えない**ので、穴が塞がるのは「そこに再建したとき」だけになり、
 *   仕様（穴が残る）が自動的に満たされる。跡地の見た目は `Tile.Rubble` を別途置く。
 *   M10（建設・破壊）はこの 2 つの関数だけを呼べばよく、経路探索側の変更は不要
 *   （`pathfind.ts` の粗経路キャッシュは `invalidatePathfinder` で落とす）。
 *
 * ■ 決定論
 *   タイル種別 → 通行ビット / 高低 / 移動コストの写像は**定数表**で持つ。
 *   分岐を書かないので端末差が出ない。すべて整数（浮動小数を状態に持たない。§0.3）。
 */

import { cfgNum } from './config';
import type { MapState } from './world';

// ---------------------------------------------------------------- タイル種別

/**
 * タイル種別。値は `MapState.tiles`（Uint8Array）にそのまま入る。
 * **既存の値の番号を変えないこと**（リプレイとゴールデンテストが壊れる）。
 */
export const Tile = {
  /** 平地。既定値（`allocateTerrain` の初期値）。 */
  Grass: 0,
  /** 森。伐採対象が生えている地面。弓の射程 -25%（`combat.forestRangedRange`）。 */
  Forest: 1,
  /** 丘。高所（`elevation` 1）。攻撃 +15%（`combat.highGround`）。 */
  Hill: 2,
  /** 水域（深い）。船のみ。 */
  Water: 3,
  /** 浅瀬。歩いて渡れるが騎兵は -30%（`combat.shallowCavSpeed`）。船も通れる。 */
  Shallow: 4,
  /** 街道（ローマの敷設物・橋の路面）。移動コストが軽い。 */
  Road: 5,
  /** 跡地。建物が壊れた跡（`07§9`）。通行可。 */
  Rubble: 6,
  /** 岩山・崖。**通行不可の陸地**。隘路（`defile`）の壁に使う。 */
  Cliff: 7,
} as const;
export type TileId = (typeof Tile)[keyof typeof Tile];

/** タイル種別の総数（表の長さ検証用）。 */
export const TILE_COUNT = 8;

/** デバッグ表示・テストのメッセージ用。 */
export const TILE_NAMES: readonly string[] = [
  'grass',
  'forest',
  'hill',
  'water',
  'shallow',
  'road',
  'rubble',
  'cliff',
];

// ---------------------------------------------------------------- 通行ビット

/**
 * `MapState.passable` のビット。
 *
 * 下位 3 ビットが「地形がこの移動種を通せるか」、`Blocked` が「今そこが塞がっているか」。
 * 判定は必ず `isPassableFor`（= 移動ビットが立っていて、かつ Blocked が立っていない）で行う。
 */
export const Pass = {
  /** 徒歩（歩兵・村人・騎兵・獣）。 */
  Land: 1 << 0,
  /** 車輪付き（攻城兵器）。森・浅瀬・跡地の瓦礫は通れない。 */
  Wheeled: 1 << 1,
  /** 船。水域と浅瀬のみ。 */
  Ship: 1 << 2,
  /**
   * 建物・壁で塞がれている。**地形ではなく現況**。
   * 立てるとき / 壊れるときに `blockTiles` で更新する（M10）。
   */
  Blocked: 1 << 3,
  /**
   * 門のマス（M10 で使う予約ビット）。`Blocked` と併用し、
   * 「味方は通れるが敵は通れない」を所有者判定と組み合わせて表現する。
   */
  Gate: 1 << 4,
} as const;
export type PassBit = (typeof Pass)[keyof typeof Pass];

/** 移動種別。`isPassableFor` / `findPath` に渡す。 */
export const Move = {
  /** 徒歩ユニット。 */
  Land: Pass.Land,
  /** 攻城兵器。 */
  Wheeled: Pass.Wheeled,
  /** 船。 */
  Ship: Pass.Ship,
  /** 水陸両用（到達性検査で「上陸戦なら届く」を表すための論理和）。 */
  Amphibious: Pass.Land | Pass.Ship,
} as const;
export type MoveMask = number;

/** 地形由来の通行ビット（`Tile` の添字）。 */
const TERRAIN_PASS: readonly number[] = [
  /* Grass   */ Pass.Land | Pass.Wheeled,
  /* Forest  */ Pass.Land,
  /* Hill    */ Pass.Land | Pass.Wheeled,
  /* Water   */ Pass.Ship,
  /* Shallow */ Pass.Land | Pass.Ship,
  /* Road    */ Pass.Land | Pass.Wheeled,
  /* Rubble  */ Pass.Land,
  /* Cliff   */ 0,
];

/** 地形由来の高低（0 = 平地 / 1 = 丘）。城壁上（2）は建物側が立てる。 */
const TERRAIN_ELEVATION: readonly number[] = [
  /* Grass   */ 0,
  /* Forest  */ 0,
  /* Hill    */ 1,
  /* Water   */ 0,
  /* Shallow */ 0,
  /* Road    */ 0,
  /* Rubble  */ 0,
  /* Cliff   */ 1,
];

/** 平地 1 マスの移動コスト。整数コストの基準（A* はこの倍数で動く）。 */
export const COST_STRAIGHT = 10;

/**
 * 斜め移動のコスト。`round(COST_STRAIGHT * sqrt(2))` = 14。
 * 定数として持つのは、tick 中に平方根を呼ばないため（§4.2）。
 */
export const COST_DIAGONAL = 14;

/**
 * タイルごとの移動コスト（`COST_STRAIGHT` = 平地 10 を基準にした整数）。
 *
 * 値は `config.json` の `mapgen.tileCost.<タイル名>` にある（手順書 §0.5
 * 「数値リテラルをコードに書かない」）。キーが無ければ `cfgNum` が
 * 起動時に例外を投げるので、タイルを増やしたら JSON への追加を忘れられない。
 */
const TILE_COST: Int32Array = buildTileCost();

function buildTileCost(): Int32Array {
  const out = new Int32Array(TILE_COUNT);
  for (let t = 0; t < TILE_COUNT; t++) {
    out[t] = cfgNum(`mapgen.tileCost.${TILE_NAMES[t]!}`);
  }
  return out;
}

/** タイルの移動コスト（整数。`COST_STRAIGHT` が基準）。通行不可なら 0。 */
export function tileMoveCost(tile: number): number {
  return TILE_COST[tile] ?? COST_STRAIGHT;
}

// ---------------------------------------------------------------- config ブリッジ


// ---------------------------------------------------------------- 確保・添字

/**
 * `MapState` の 3 配列を確保して平地で埋める（T-M3-01）。
 * `createWorld` は長さ 0 の配列を置くだけなので、mapgen が最初にこれを呼ぶ。
 *
 * メモリは 1 マス 3 バイト。400×400 で 480,000 B（完了条件の 10MB に対して十分小さい）。
 */
export function allocateTerrain(map: MapState): void {
  const n = map.widthTiles * map.heightTiles;
  if (map.tiles.length !== n) map.tiles = new Uint8Array(n);
  if (map.passable.length !== n) map.passable = new Uint8Array(n);
  if (map.elevation.length !== n) map.elevation = new Uint8Array(n);
  map.tiles.fill(Tile.Grass);
  map.passable.fill(TERRAIN_PASS[Tile.Grass]!);
  map.elevation.fill(TERRAIN_ELEVATION[Tile.Grass]!);
}

/** 地形が確保済みか（未生成の World でも落ちないようにするためのガード）。 */
export function hasTerrain(map: MapState): boolean {
  return map.tiles.length === map.widthTiles * map.heightTiles && map.tiles.length > 0;
}

/** 地形 3 配列の合計バイト数（メモリ完了条件の検証用）。 */
export function terrainByteLength(map: MapState): number {
  return map.tiles.byteLength + map.passable.byteLength + map.elevation.byteLength;
}

/** マップ内か。 */
export function inBounds(map: MapState, tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < map.widthTiles && ty < map.heightTiles;
}

/** マス座標 → 配列添字。**範囲検査をしない**ので、呼ぶ前に `inBounds` を確認する。 */
export function tileIndex(map: MapState, tx: number, ty: number): number {
  return ty * map.widthTiles + tx;
}

/** 配列添字 → tx。 */
export function tileX(map: MapState, index: number): number {
  return index % map.widthTiles;
}

/** 配列添字 → ty。 */
export function tileY(map: MapState, index: number): number {
  return (index - (index % map.widthTiles)) / map.widthTiles;
}

// ---------------------------------------------------------------- 参照

/** タイル種別。範囲外は `Tile.Cliff`（= 通行不可）として扱う。 */
export function tileAt(map: MapState, tx: number, ty: number): number {
  if (!inBounds(map, tx, ty)) return Tile.Cliff;
  return map.tiles[tileIndex(map, tx, ty)]!;
}

/** 高低。範囲外は 0。 */
export function elevationAt(map: MapState, tx: number, ty: number): number {
  if (!inBounds(map, tx, ty)) return 0;
  return map.elevation[tileIndex(map, tx, ty)]!;
}

/** 移動種 `mask` で通行できるか（範囲外・封鎖済みは false）。 */
export function isPassableFor(map: MapState, tx: number, ty: number, mask: MoveMask): boolean {
  if (!inBounds(map, tx, ty)) return false;
  const p = map.passable[tileIndex(map, tx, ty)]!;
  if ((p & Pass.Blocked) !== 0) return false;
  return (p & mask) !== 0;
}

/** 徒歩で通行できるか（既定の問い合わせ）。 */
export function isPassable(map: MapState, tx: number, ty: number): boolean {
  return isPassableFor(map, tx, ty, Move.Land);
}

/** 添字版（ホットパス用。範囲検査は呼び出し側の責任）。 */
export function isPassableIndex(map: MapState, index: number, mask: MoveMask): boolean {
  const p = map.passable[index]!;
  if ((p & Pass.Blocked) !== 0) return false;
  return (p & mask) !== 0;
}

/** 森か。 */
export function isForest(map: MapState, tx: number, ty: number): boolean {
  return tileAt(map, tx, ty) === Tile.Forest;
}

/** 水域（深い）か。 */
export function isWater(map: MapState, tx: number, ty: number): boolean {
  return tileAt(map, tx, ty) === Tile.Water;
}

/** 浅瀬か。 */
export function isShallow(map: MapState, tx: number, ty: number): boolean {
  return tileAt(map, tx, ty) === Tile.Shallow;
}

/** 丘（高所）か。 */
export function isHill(map: MapState, tx: number, ty: number): boolean {
  return tileAt(map, tx, ty) === Tile.Hill;
}

/** 水気のあるマス（深水 or 浅瀬）。港・上陸判定用。 */
export function isWet(map: MapState, tx: number, ty: number): boolean {
  const t = tileAt(map, tx, ty);
  return t === Tile.Water || t === Tile.Shallow;
}

// ---------------------------------------------------------------- 書き込み

/**
 * タイル種別を書き換える。通行ビットと高低も表から作り直す。
 * `Pass.Blocked` / `Pass.Gate`（現況ビット）は**保持する**
 * ―― 壁の穴を地形の塗り替えで塞いでしまわないため。
 */
export function setTile(map: MapState, tx: number, ty: number, tile: number): void {
  if (!inBounds(map, tx, ty)) return;
  const i = tileIndex(map, tx, ty);
  const keep = map.passable[i]! & (Pass.Blocked | Pass.Gate);
  map.tiles[i] = tile;
  map.passable[i] = TERRAIN_PASS[tile]! | keep;
  map.elevation[i] = TERRAIN_ELEVATION[tile]!;
}

/** 高低を直接書く（城壁上 = 2 を建物側から立てるため。M10）。 */
export function setElevation(map: MapState, tx: number, ty: number, level: number): void {
  if (!inBounds(map, tx, ty)) return;
  map.elevation[tileIndex(map, tx, ty)] = level;
}

/**
 * 矩形を封鎖 / 解放する（建物・壁の設置と破壊。M10）。
 *
 * `on = false` で解放したとき、**地形は元のまま**なので通行が復活する。
 * これが `07§9`「壁の穴は試合中ずっと残る」の実装。跡地の見た目が必要なら
 * 呼び出し側で `setTile(..., Tile.Rubble)` を併用する。
 */
export function blockTiles(
  map: MapState,
  tx: number,
  ty: number,
  w: number,
  h: number,
  on: boolean,
): void {
  for (let y = ty; y < ty + h; y++) {
    for (let x = tx; x < tx + w; x++) {
      if (!inBounds(map, x, y)) continue;
      const i = tileIndex(map, x, y);
      if (on) map.passable[i] = map.passable[i]! | Pass.Blocked;
      else map.passable[i] = map.passable[i]! & ~Pass.Blocked;
    }
  }
}

/** 門のマスを立てる / 下ろす（M10 予約）。 */
export function markGate(map: MapState, tx: number, ty: number, on: boolean): void {
  if (!inBounds(map, tx, ty)) return;
  const i = tileIndex(map, tx, ty);
  if (on) map.passable[i] = map.passable[i]! | Pass.Gate;
  else map.passable[i] = map.passable[i]! & ~Pass.Gate;
}

/**
 * (tx, ty) から近い順に `mask` で通行できるマスを探す（同心の正方リング走査）。
 * 見つからなければ -1。
 *
 * 走査順は「リング半径昇順 → (y, x) 昇順」で全順序に固定してある（§16-2）。
 * 目標が水没・封鎖されていたときの振り替え先を決めるのに使う。
 */
export function nearestPassable(
  map: MapState,
  tx: number,
  ty: number,
  mask: MoveMask,
  maxRadius: number,
): number {
  if (isPassableFor(map, tx, ty, mask)) return tileIndex(map, tx, ty);
  for (let r = 1; r <= maxRadius; r++) {
    for (let y = ty - r; y <= ty + r; y++) {
      const edge = y === ty - r || y === ty + r;
      for (let x = tx - r; x <= tx + r; x++) {
        // リングの内側は前の r で見ているので飛ばす
        if (!edge && x !== tx - r && x !== tx + r) continue;
        if (isPassableFor(map, x, y, mask)) return tileIndex(map, x, y);
      }
    }
  }
  return -1;
}
