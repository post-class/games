/**
 * render/palette.ts — 色の共通ルール（`05§15`）
 *
 * **陣営色（8 文明ぶん）と戦域色（6 スロット）は別系統**（`05§15` / 手順書 §7.3）。
 * 戦域色はミニマップの輪・部隊の足元・スロットの旗・リプレイのレーンで一貫させるので、
 * この 1 ファイルだけが色の出所になる。ここ以外に色リテラルを書かないこと。
 *
 * 色覚に依存しないよう、戦域は**色 + 形 + 番号**の 3 重で示す（`06§12`）。
 * 形は `FRONT_SHAPES` の文字を使う（HUD の旗と戦場の輪ラベルで共通）。
 */

import { Tile } from '@/sim/core/terrain';

// --------------------------------------------------------------- 陣営色

/** 陣営色（playerId 0..7）。戦域色とは別系統。 */
export const PLAYER_COLORS: readonly string[] = [
  '#4a7fb5', // 0 青
  '#c0562f', // 1 朱
  '#7cb342', // 2 緑
  '#e0b34a', // 3 金
  '#9a6fc0', // 4 紫
  '#3fa9a0', // 5 青緑
  '#d07ba8', // 6 桃
  '#8d8d8d', // 7 灰
];

/** 中立（資源・野生）の色。 */
export const NEUTRAL_COLOR = '#8a7a5c';

/** playerId → 陣営色。範囲外・中立は `NEUTRAL_COLOR`。 */
export function playerColor(owner: number): string {
  return PLAYER_COLORS[owner] ?? NEUTRAL_COLOR;
}

// --------------------------------------------------------------- 戦域色

/**
 * 戦域スロット 1..6 の色（`05§15`。**陣営色とは別系統**）。
 * 添字 0 = スロット 1。
 */
export const FRONT_COLORS: readonly string[] = [
  '#ff5d4e', // 1 赤
  '#4ea8ff', // 2 青
  '#ffd24e', // 3 黄
  '#6ee06e', // 4 緑
  '#c56eff', // 5 紫
  '#ff9c3d', // 6 橙
];

/** 戦域スロットの形（色覚に依存しないための併記。`06§12`）。添字 0 = スロット 1。 */
export const FRONT_SHAPES: readonly string[] = ['●', '▲', '■', '◆', '★', '✚'];

/** スロット番号（1..6）→ 色。範囲外は白。 */
export function frontColor(slot: number): string {
  return FRONT_COLORS[slot - 1] ?? '#ffffff';
}

/** スロット番号（1..6）→ 形の文字。 */
export function frontShape(slot: number): string {
  return FRONT_SHAPES[slot - 1] ?? '?';
}

// --------------------------------------------------------------- 地形色

/**
 * タイル種別 → 塗り色（`Tile` の添字順）。
 * アセット（M17）が入るまでの暫定。差し替え手順は `placeholder.ts` を参照。
 */
export const TILE_COLORS: readonly string[] = [
  '#4b6b32', // Grass
  '#2f4d24', // Forest
  '#6b6a3a', // Hill
  '#1d3350', // Water
  '#39607a', // Shallow
  '#7a6a4a', // Road
  '#4a423a', // Rubble
  '#3b3b3b', // Cliff
];

/** タイル種別 → 色。未知は平地色。 */
export function tileColor(tile: number): string {
  return TILE_COLORS[tile] ?? TILE_COLORS[Tile.Grass]!;
}

// --------------------------------------------------------------- 資源色

/** 資源色（`RESOURCE_IDS` の順: 食料・木材・石材・金）。HUD と資源ノードで共通。 */
export const RESOURCE_COLORS: readonly string[] = [
  '#8fbf5a', // food
  '#a9764a', // wood
  '#9aa0a6', // stone
  '#e0b34a', // gold
];

/** 資源記号（同順）。 */
export const RESOURCE_GLYPHS: readonly string[] = ['食', '木', '石', '金'];

/** 資源 index → 色。 */
export function resourceColor(r: number): string {
  return RESOURCE_COLORS[r] ?? NEUTRAL_COLOR;
}

/** 資源 index → 記号。 */
export function resourceGlyph(r: number): string {
  return RESOURCE_GLYPHS[r] ?? '?';
}

// --------------------------------------------------------------- HUD / 霧

/** 体力バー（緑 → 黄 → 赤。`05§15`）。 */
export function healthColor(ratio: number): string {
  if (ratio > 0.6) return '#7cb342';
  if (ratio > 0.3) return '#e0b34a';
  return '#c0562f';
}

/** 「今これができる／これが選ばれている」金の縁（`05§15`）。 */
export const GOLD = '#e0b34a';

/** 未探索（真っ暗）。 */
export const FOG_UNEXPLORED = '#000000';

/** 既知（暗がり）に重ねる黒の不透明度。 */
export const FOG_KNOWN_ALPHA = 0.55;
