/**
 * shared/types.ts — sim と ui / render / input / ai / net / replay の共通語彙。
 *
 * ここには**型と ID 定数だけ**を置く。ロジックとバランス数値は置かない
 * （バランス数値は `src/data/*.json`、実装手順書 §0.5）。
 *
 * ID の綴りは `src/data/README.md` の規約と 1 対 1 で一致させること。
 * 綴りを変えると JSON もテストも壊れる。
 */

// ---------------------------------------------------------------------------
// プレイヤー / エンティティ
// ---------------------------------------------------------------------------

/** プレイヤー番号。0..7（最大 8 人）。255 = 中立（`Entities.owner` で使用）。 */
export type PlayerId = number;

/** 中立所有者を表す `owner` の値。 */
export const NEUTRAL_OWNER = 255;

/**
 * エンティティ識別子。
 * 上位 16bit = generation、下位 16bit = index（実装手順書 §4.4）。
 * 生成・分解は `sim/core/entity.ts` の `makeEntityId` / `entityIndex` /
 * `entityGeneration` を使うこと。数値を直接いじらない。
 */
export type EntityId = number;

/** 無効な EntityId。 */
export const INVALID_ENTITY: EntityId = -1;

/**
 * エンティティ種別（`Entities.kind` の値。実装手順書 §4.4）。
 *
 * `enum` を使わないのは `isolatedModules` + `verbatimModuleSyntax` 下で
 * const enum が使えず、通常の enum は値と型の二重生成で扱いが分かれるため。
 * 値は `EntityKind.Unit`、型は `EntityKindId` を使う
 * （同名の const と type を並べると eslint の `no-redeclare` が誤検知するので名前を分けている）。
 */
export const EntityKind = {
  /** free list に入っている / 未使用スロット */
  None: 0,
  Unit: 1,
  Building: 2,
  /** 森・鉱脈・農地などの採集対象 */
  Resource: 3,
  Projectile: 4,
  /** 井戸・種籾蔵など建物の付属物（独立して破壊可能。`03§3`） */
  Attachment: 5,
} as const;
export type EntityKindId = (typeof EntityKind)[keyof typeof EntityKind];

// ---------------------------------------------------------------------------
// 時代 / 文明 / 資源
// ---------------------------------------------------------------------------

/** 時代 ID（4 時代・この順。`src/data/README.md`）。 */
export type Age = 'reimei' | 'seido' | 'tekki' | 'teikoku';

/** 時代 ID の昇順配列。`PlayerState.age` はこの配列の添字。 */
export const AGE_IDS: readonly Age[] = ['reimei', 'seido', 'tekki', 'teikoku'];

/** 文明 ID（8 文明・固定）。 */
export type CivId =
  | 'yamato'
  | 'roma'
  | 'tou'
  | 'viking'
  | 'mali'
  | 'azteca'
  | 'persia'
  | 'mongol';

/** 文明 ID の固定順配列。 */
export const CIV_IDS: readonly CivId[] = [
  'yamato',
  'roma',
  'tou',
  'viking',
  'mali',
  'azteca',
  'persia',
  'mongol',
];

/** 資源 ID（4 種）。 */
export type ResourceId = 'food' | 'wood' | 'stone' | 'gold';

/** 資源 ID の固定順配列。`PlayerState.resources` はこの順の添字。 */
export const RESOURCE_IDS: readonly ResourceId[] = ['food', 'wood', 'stone', 'gold'];

/** `RESOURCE_IDS` の添字（資源配列の長さ）。 */
export const RESOURCE_COUNT = RESOURCE_IDS.length;

/** 資源 ID → 添字。`Map` の反復順に依存しないよう、参照専用で使う。 */
export function resourceIndex(id: ResourceId): number {
  return RESOURCE_IDS.indexOf(id);
}

/** 時代 ID → 添字（0..3）。 */
export function ageIndex(id: Age): number {
  return AGE_IDS.indexOf(id);
}

// ---------------------------------------------------------------------------
// 令（オーダー）
// ---------------------------------------------------------------------------

/** 令 ID（基本 6 + 固有 8 = 14。`src/data/README.md` / `07§4`）。 */
export type OrderId =
  // 基本 6
  | 'charge'
  | 'siege'
  | 'hold'
  | 'raid'
  | 'build'
  | 'retreat'
  // 固有 8
  | 'jindate'
  | 'hojin'
  | 'kakei'
  | 'jouriku'
  | 'koeki'
  | 'hounou'
  | 'assai'
  | 'yugeki';

/** 令 ID の固定順配列（基本 6 → 固有 8）。 */
export const ORDER_IDS: readonly OrderId[] = [
  'charge',
  'siege',
  'hold',
  'raid',
  'build',
  'retreat',
  'jindate',
  'hojin',
  'kakei',
  'jouriku',
  'koeki',
  'hounou',
  'assai',
  'yugeki',
];

/**
 * 二重旗の段（`07§4`）。上段 1 枚 + 下段 1 枚まで。
 * 基本令の分類は固定: 上段 = charge / hold / retreat / build、下段 = siege / raid。
 */
export type Tier = 'upper' | 'lower';

/** 令 ID → 添字（`Entities.lastOrder` などに入れる 0 起点の番号）。 */
export function orderIndex(id: OrderId): number {
  return ORDER_IDS.indexOf(id);
}

// ---------------------------------------------------------------------------
// マスターデータのキー（文字列 ID）
// ---------------------------------------------------------------------------

/**
 * `units.json` のキー（全 94 件）。
 * 件数が多く、かつ M1 のデータ確定まで動くため文字列別名にしている。
 * 存在検証はローダ（T-M1-02）が起動時に行う。
 */
export type UnitTypeId = string;

/** `buildings.json` のキー（共通 25 + 付属物 2 + 固有 8）。 */
export type BuildingTypeId = string;

/** `techs.json` のキー（34 件）。 */
export type TechId = string;

/** 兵種の役割 ID（相性判定のキー。`03§7`）。 */
export type RoleId =
  | 'spear'
  | 'sword'
  | 'ranged'
  | 'cavalry'
  | 'camel'
  | 'beast'
  | 'siege'
  | 'gunpowder'
  | 'ship'
  | 'villager'
  | 'support'
  | 'building';

/** 兵種系統 ID（時代進化で段が入れ替わる）。 */
export type LineId = 'melee' | 'ranged' | 'cavalry' | 'beast' | 'siege' | 'ship' | 'elite';

/** マップ型 ID（8 種）。 */
export type MapTypeId =
  | 'inland_sea'
  | 'plain'
  | 'river'
  | 'archipelago'
  | 'defile'
  | 'steppe'
  | 'jungle'
  | 'monolith_isle';

/** マップ型 ID の固定順配列。 */
export const MAP_TYPE_IDS: readonly MapTypeId[] = [
  'inland_sea',
  'plain',
  'river',
  'archipelago',
  'defile',
  'steppe',
  'jungle',
  'monolith_isle',
];
