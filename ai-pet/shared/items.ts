import type { Needs } from './types.js';

export type ItemKind = 'food' | 'toy' | 'care' | 'furniture';

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  /** 使用時のニーズ変化。 */
  effect: Partial<Needs>;
  price: number;
  /** 家具の描画サイズ（グリッド単位）。 */
  size?: [number, number];
}

export const ITEMS: ItemDef[] = [
  // --- ごはん ---
  { id: 'food_pellet', name: 'ふつうのごはん', kind: 'food', effect: { hunger: 25 }, price: 10 },
  { id: 'food_berry', name: 'あまいベリー', kind: 'food', effect: { hunger: 18, mood: 6 }, price: 25 },
  { id: 'food_fish', name: 'やきざかな', kind: 'food', effect: { hunger: 35, mood: 4 }, price: 40 },
  { id: 'food_cake', name: 'ごほうびケーキ', kind: 'food', effect: { hunger: 20, mood: 14 }, price: 80 },
  // --- おもちゃ ---
  { id: 'toy_ball', name: 'ボール', kind: 'toy', effect: { fun: 22, energy: -8 }, price: 20 },
  { id: 'toy_ribbon', name: 'ひらひらリボン', kind: 'toy', effect: { fun: 18, mood: 6 }, price: 35 },
  { id: 'toy_puzzle', name: 'ちえのパズル', kind: 'toy', effect: { fun: 26, energy: -12 }, price: 60 },
  // --- おてあて ---
  { id: 'care_brush', name: 'ブラシ', kind: 'care', effect: { clean: 30, mood: 5 }, price: 20 },
  { id: 'care_towel', name: 'ふかふかタオル', kind: 'care', effect: { clean: 22, energy: 8 }, price: 30 },
  // --- かぐ ---
  { id: 'furn_rug', name: 'まるいラグ', kind: 'furniture', effect: {}, price: 50, size: [3, 2] },
  { id: 'furn_bed', name: 'ペットベッド', kind: 'furniture', effect: { energy: 4 }, price: 90, size: [2, 2] },
  { id: 'furn_plant', name: 'かんようしょくぶつ', kind: 'furniture', effect: { mood: 2 }, price: 60, size: [1, 2] },
  { id: 'furn_lamp', name: 'まるいランプ', kind: 'furniture', effect: {}, price: 70, size: [1, 2] },
  { id: 'furn_shelf', name: 'ちいさなたな', kind: 'furniture', effect: {}, price: 80, size: [2, 2] },
  { id: 'furn_window', name: 'まるまど', kind: 'furniture', effect: { mood: 3 }, price: 100, size: [2, 2] },
];

const ITEM_BY_ID = new Map(ITEMS.map((item) => [item.id, item]));

export function findItem(id: string): ItemDef | undefined {
  return ITEM_BY_ID.get(id);
}

export function itemsOfKind(kind: ItemKind): ItemDef[] {
  return ITEMS.filter((item) => item.kind === kind);
}

/** 新規ユーザに配る初期アイテム。 */
export const STARTER_INVENTORY: Array<[itemId: string, count: number]> = [
  ['food_pellet', 5],
  ['food_berry', 2],
  ['toy_ball', 1],
  ['care_brush', 1],
  ['furn_rug', 1],
];

export const STARTER_COINS = 120;
