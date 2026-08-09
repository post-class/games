/**
 * input/cursor.ts — カーソル形状（T-M5-08。`06§2`）
 *
 * 「右クリックの意味を覚える必要はありません。**カーソルの形が「何が起きるか」を
 *  先に見せます**（剣＝攻撃、手＝採集、槌＝修理、足＝移動）」
 *
 * アセット（M17 の `public/assets/ui/`）が入るまでは SVG の data URI で描く。
 * PNG に差し替えるときは `CURSOR_CSS` の値を `url(/assets/ui/cursor-sword.png) 8 8, auto`
 * のように置き換えるだけでよい（呼び出し側は `cursorCss()` しか見ていない）。
 */

import { CursorKind, type CursorKindId } from './context';

/** SVG を data URI の CSS カーソルにする。`hx, hy` はホットスポット。 */
function svgCursor(body: string, hx = 8, hy = 8): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    `<g fill="none" stroke="black" stroke-width="3.2" stroke-linecap="round">${body}</g>` +
    `<g fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round">${body}</g>` +
    `</svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${hx} ${hy}, auto`;
}

/** 剣（攻撃）。 */
const SWORD = svgCursor('<path d="M4 20 L18 6"/><path d="M13 4 L20 11"/><path d="M3 18 L6 21"/>', 4, 20);

/** 手（採集）。 */
const HAND = svgCursor(
  '<path d="M8 20 L8 11"/><path d="M11 20 L11 9"/><path d="M14 20 L14 10"/><path d="M17 20 L17 12"/><path d="M7 20 L18 20"/>',
  12,
  20,
);

/** 槌（修理）。 */
const HAMMER = svgCursor('<path d="M5 20 L14 11"/><path d="M11 6 L19 14"/>', 5, 20);

/** 足（移動）。 */
const FOOT = svgCursor('<path d="M9 19 L9 9"/><path d="M9 9 L15 9"/><path d="M15 9 L15 19"/>', 12, 19);

/** 船（乗船）。 */
const BOAT = svgCursor('<path d="M4 15 L20 15 L17 20 L7 20 Z"/><path d="M12 15 L12 5"/>', 12, 18);

/** カーソル形状 → CSS の `cursor` 値。 */
export const CURSOR_CSS: Readonly<Record<CursorKindId, string>> = {
  [CursorKind.Attack]: SWORD,
  [CursorKind.Gather]: HAND,
  [CursorKind.Repair]: HAMMER,
  [CursorKind.Move]: FOOT,
  [CursorKind.Board]: BOAT,
  [CursorKind.None]: 'default',
};

/** カーソル形状 → CSS 値。 */
export function cursorCss(kind: CursorKindId): string {
  return CURSOR_CSS[kind] ?? 'default';
}
