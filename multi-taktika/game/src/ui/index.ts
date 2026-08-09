/**
 * ui/index.ts — UI 層の入口（13 画面。M5 では対戦画面の HUD だけ）。
 *
 * DOM + CSS で作り、戦場 Canvas の上に重ねる。
 * **どのパネルを開いても試合は止まらない**（手順書 §8）。
 */

export { Hud, type HudContext } from './hud/Hud';
export { Minimap, MINIMAP_SIZE } from './hud/minimap';
export {
  GRID_KEYS,
  DisabledReason,
  buildCommandGrid,
  type GridButton,
  type DisabledReasonId,
} from './hud/commandGrid';
