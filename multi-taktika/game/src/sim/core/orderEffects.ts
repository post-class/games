/**
 * sim/core/orderEffects.ts — 固有令の `flags` を引く純関数（`01` の固有令の表 / `07§4`〜`§6`）
 *
 * ここは **令のフラグを読む窓口を 1 箇所にまとめる**ためのファイル。
 * combat / morale / economy はこのファイルの関数を呼ぶだけにする。
 * 3 箇所に「フラグ名で分岐する if」が散ると、令を足すたびに 3 箇所直すことになり、
 * 片方だけ直した状態（＝文明の個性が半分だけ出る状態）が生まれる。
 *
 * ---------------------------------------------------------------------------
 * 設計の約束（手順書 §5.6 と同じ思想）
 * ---------------------------------------------------------------------------
 *  - **令の名前（`jindate` など）でも文明の名前でも分岐しない。**
 *    `orders.json` の `flags` の **値の型** で解釈が決まる:
 *      数値       → 倍率・比率（`fx()` で Fx 化して持つ）
 *      真偽値     → 有無だけのフラグ（true のときだけ持つ）
 *      オブジェクト → 資源 ID → 毎秒量（`holdIncome`）
 *    したがって、同じ型のフラグを持つ令を `orders.json` に足すだけで効果が付く。
 *  - フラグの解釈（どのフラグを誰が使うか）はこのファイルの下の表に書く。
 *
 * ---------------------------------------------------------------------------
 * 二重旗（上段 + 下段）の扱い
 * ---------------------------------------------------------------------------
 * 隊列（`formationOfEntity`）は「上段優先で 1 つ」だが、**フラグは上段と下段の両方を見る**。
 * `07§4` の二重旗は「上段 1 枚 + 下段 1 枚を同時に立てられる」仕組みなので、
 * 「突撃（上段）＋火計（下段）」で火計の建物ダメージが乗らないのはおかしい。
 *  - 倍率（`damageTakenMul` / `buildingDamageMul`）は **両段の積**。
 *    `effects.ts` が研究と建物の倍率を「型どおり両方掛ける」のと同じ規則にしてある。
 *  - 比率（`killIncomeRatio`）は **両段の最大**。積にすると 2 枚重ねたときに
 *    「奉納しているのに取り分が減る」ことになり意味が反転するため。
 *  - 有無フラグは **論理和**。
 *
 * 戦域が閉じた後は `Entities.lastOrder`（最後に受けた令）を見る（`07§3`）。
 * 離反中（`Front.defected`）の戦域は令を配れないので、フラグも一切効かない
 * （`effectiveOrderOf` と同じ規則。`front.ts` を参照）。
 *
 * ---------------------------------------------------------------------------
 * `orders.json` の flags の担当表（**フラグを足したらここに 1 行足すこと**）
 * ---------------------------------------------------------------------------
 * | フラグ | 型 | 使う場所 |
 * |---|---|---|
 * | `damageTakenMul`     | number  | このファイル → `systems/combat.ts`（受け側の被ダメージ） |
 * | `buildingDamageMul`  | number  | このファイル → `systems/combat.ts`（対建物の与ダメージ） |
 * | `killIncomeRatio`    | number  | このファイル → `systems/combat.ts`（撃破時の資源還元） |
 * | `moraleBreakImmune`  | boolean | このファイル → `systems/morale.ts`（士気 0 でも退却しない） |
 * | `waterAssault`       | boolean | このファイル → `systems/combat.ts`（水際の強襲） |
 * | `pushThrough`        | boolean | このファイル → `systems/combat.ts`（相性の不利を打ち消す） |
 * | `holdIncome`         | object  | このファイル → `systems/economy.ts`（戦域維持の収入） |
 * | `siegeLead` / `followSiege` / `avoidCombatUnits` / `crossFront` | — | `core/order.ts` → `systems/unitDecision.ts`（M9 の担当） |
 * | `formationKeep` | boolean | **未適用**。損耗しても隊列を保つ（配置の担当なので movement / unitDecision 側） |
 * | `requiresWaterFront` | boolean | **未適用**。水辺の戦域にしか出せない（令を出す側の検査 = command / UI 側） |
 *
 * 決定論: 乱数なし。数値は読み込み時に 1 度だけ `fx()` で量子化する。
 * 反復は `ORDER_DEFS` の index 昇順（`Object.keys` の順ではなく配列の順）。
 */

import type { PlayerId, ResourceId } from '@/shared/types';
import { RESOURCE_COUNT, RESOURCE_IDS } from '@/shared/types';
import { cfgBool, cfgFx } from './config';
import { ORDER_DEFS, orderIndex } from './defs';
import type { Entities } from './entity';
import type { Fx } from './fx';
import { FX_ONE, fx, fxMul } from './fx';
import { getFront, type Front, type World } from './world';

// ---------------------------------------------------------------- フラグ名

/** 受け側の被ダメージ倍率（陣立て）。 */
export const FLAG_DAMAGE_TAKEN_MUL = 'damageTakenMul';
/** 対建物の与ダメージ倍率（火計）。 */
export const FLAG_BUILDING_DAMAGE_MUL = 'buildingDamageMul';
/** 撃破したユニットのコストのうち資源として戻る比率（奉納）。 */
export const FLAG_KILL_INCOME_RATIO = 'killIncomeRatio';
/** 士気 0 でも退却しない（方陣）。 */
export const FLAG_MORALE_BREAK_IMMUNE = 'moraleBreakImmune';
/** 水際からの強襲（上陸）。 */
export const FLAG_WATER_ASSAULT = 'waterAssault';
/** 相性の不利を打ち消す突破力（圧壊）。 */
export const FLAG_PUSH_THROUGH = 'pushThrough';
/** 戦域を維持している間の毎秒収入（交易）。 */
export const FLAG_HOLD_INCOME = 'holdIncome';

// ---------------------------------------------------------------- 解析済みフラグ

/**
 * 1 つの令のフラグを型ごとに振り分けた形。
 * `orders.json` を読み込んだ 1 回だけ作り、以降は index で引く。
 */
interface ParsedFlags {
  /** 数値フラグ（Fx）。倍率・比率の両方が入る。 */
  readonly nums: ReadonlyMap<string, Fx>;
  /** true の真偽値フラグの名前。 */
  readonly bools: ReadonlySet<string>;
  /** オブジェクトフラグ。資源 index → 毎秒量（Fx）。 */
  readonly perSec: ReadonlyMap<string, Int32Array>;
}

const EMPTY: ParsedFlags = {
  nums: new Map<string, Fx>(),
  bools: new Set<string>(),
  perSec: new Map<string, Int32Array>(),
};

const PARSED: readonly ParsedFlags[] = ORDER_DEFS.map((d) => parseFlags(d.flags));

/**
 * `flags` を **値の型だけ**で振り分ける。フラグ名で分岐しない。
 * 未知の名前でも型が合っていれば取り込む（`orders.json` にフラグを足すだけで動く）。
 */
function parseFlags(flags: Readonly<Record<string, unknown>>): ParsedFlags {
  const nums = new Map<string, Fx>();
  const bools = new Set<string>();
  const perSec = new Map<string, Int32Array>();
  // Object.entries の順に依存しない処理（独立した代入のみ）なのでそのまま回してよい。
  for (const [k, v] of Object.entries(flags)) {
    if (typeof v === 'number') {
      nums.set(k, fx(v));
    } else if (typeof v === 'boolean') {
      if (v) bools.add(k);
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const arr = toPerResource(v as Record<string, unknown>);
      if (arr !== null) perSec.set(k, arr);
    }
  }
  return { nums, bools, perSec };
}

/** `{ "gold": 1.5 }` → 資源 index 順の Fx 配列。資源 ID が 1 つも無ければ null。 */
function toPerResource(obj: Record<string, unknown>): Int32Array | null {
  const out = new Int32Array(RESOURCE_COUNT);
  let any = false;
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    const key = RESOURCE_IDS[r] as ResourceId;
    const v = obj[key];
    if (typeof v !== 'number') continue;
    out[r] = fx(v);
    any = true;
  }
  return any ? out : null;
}

function parsedOf(orderIdx: number): ParsedFlags {
  return PARSED[orderIdx] ?? EMPTY;
}

// ---------------------------------------------------------------- 効いている令の組

/**
 * 「今このユニット / この戦域に効いている令」を 2 つまで packed number で表す。
 *
 *   下位 8 bit = 上段の令 index + 1（0 = なし）
 *   上位 8 bit = 下段の令 index + 1（0 = なし）
 *
 * オブジェクトを返すと 1 撃ごとに確保が走る（combat は 1 tick に千回以上呼ぶ）ので、
 * 数値 1 個に詰めている。取り出しは `upperOf` / `lowerOf`。
 */
export type OrderPair = number;

/** 令が 1 枚も効いていない組。 */
export const NO_ORDERS: OrderPair = 0;

function packPair(upper: number, lower: number): OrderPair {
  return (upper + 1) | ((lower + 1) << 8);
}

function upperOf(pair: OrderPair): number {
  return (pair & 0xff) - 1;
}

function lowerOf(pair: OrderPair): number {
  return ((pair >> 8) & 0xff) - 1;
}

/**
 * 戦域（と、戦域が無ければ最後に受けた令）から効いている令の組を作る。
 *
 * @param owner 攻撃側 / 受け側の playerId（戦域はプレイヤーごとに 6 枠あるので必要）
 * @param frontId 1..6（0 = 戦域外）
 * @param lastOrder `Entities.lastOrder`（令 index + 1、0 = なし）。戦域が無いときだけ使う
 */
export function orderPairFor(
  w: World,
  owner: PlayerId,
  frontId: number,
  lastOrder: number
): OrderPair {
  let upper = -1;
  let lower = -1;
  if (frontId > 0) {
    const f = getFront(w, owner, frontId);
    // 離反中の戦域は令を配れない（`front.ts` の effectiveOrderOf と同じ規則）。
    if (f !== undefined && f.active && !f.defected) {
      if (f.order !== null) upper = orderIndex(f.order);
      if (f.orderLower !== null) lower = orderIndex(f.orderLower);
    }
  }
  if (upper < 0 && lower < 0 && lastOrder > 0) {
    const idx = lastOrder - 1;
    const d = ORDER_DEFS[idx];
    if (d !== undefined) {
      if (d.tier === 'lower') lower = idx;
      else upper = idx;
    }
  }
  if (upper < 0 && lower < 0) return NO_ORDERS;
  return packPair(upper, lower);
}

/** エンティティ index から効いている令の組を作る。 */
export function orderPairOfEntity(w: World, i: number): OrderPair {
  const e: Entities = w.entities;
  return orderPairFor(w, e.owner[i]! as PlayerId, e.frontId[i]!, e.lastOrder[i]!);
}

/** 戦域そのものに効いている令の組（economy が使う）。 */
export function orderPairOfFront(f: Front): OrderPair {
  if (!f.active || f.defected) return NO_ORDERS;
  const upper = f.order !== null ? orderIndex(f.order) : -1;
  const lower = f.orderLower !== null ? orderIndex(f.orderLower) : -1;
  if (upper < 0 && lower < 0) return NO_ORDERS;
  return packPair(upper, lower);
}

// ---------------------------------------------------------------- 型ごとの引き方

/** 倍率フラグ。**両段の積**（無い段は 1.0）。 */
function mulFlag(pair: OrderPair, key: string): Fx {
  if (pair === NO_ORDERS) return FX_ONE;
  let m = FX_ONE;
  const u = upperOf(pair);
  if (u >= 0) {
    const v = parsedOf(u).nums.get(key);
    if (v !== undefined) m = fxMul(m, v);
  }
  const l = lowerOf(pair);
  if (l >= 0) {
    const v = parsedOf(l).nums.get(key);
    if (v !== undefined) m = fxMul(m, v);
  }
  return m;
}

/** 比率フラグ。**両段の最大**（無ければ 0）。 */
function ratioFlag(pair: OrderPair, key: string): Fx {
  if (pair === NO_ORDERS) return 0;
  let best = 0;
  const u = upperOf(pair);
  if (u >= 0) {
    const v = parsedOf(u).nums.get(key);
    if (v !== undefined && v > best) best = v;
  }
  const l = lowerOf(pair);
  if (l >= 0) {
    const v = parsedOf(l).nums.get(key);
    if (v !== undefined && v > best) best = v;
  }
  return best;
}

/** 有無フラグ。**両段の論理和**。 */
function boolFlag(pair: OrderPair, key: string): boolean {
  if (pair === NO_ORDERS) return false;
  const u = upperOf(pair);
  if (u >= 0 && parsedOf(u).bools.has(key)) return true;
  const l = lowerOf(pair);
  if (l >= 0 && parsedOf(l).bools.has(key)) return true;
  return false;
}

// ---------------------------------------------------------------- 公開アクセサ

/** 陣立て: 受け側の被ダメージ倍率（既定 1.0）。 */
export function damageTakenMulOf(pair: OrderPair): Fx {
  return mulFlag(pair, FLAG_DAMAGE_TAKEN_MUL);
}

/** 火計: 攻撃側が建物を叩くときの与ダメージ倍率（既定 1.0）。 */
export function buildingDamageMulOf(pair: OrderPair): Fx {
  return mulFlag(pair, FLAG_BUILDING_DAMAGE_MUL);
}

/** 奉納: 撃破したユニットのコストのうち資源として戻る比率（既定 0 = 戻らない）。 */
export function killIncomeRatioOf(pair: OrderPair): Fx {
  return ratioFlag(pair, FLAG_KILL_INCOME_RATIO);
}

/** 方陣: 士気 0 でも退却しないか。 */
export function hasMoraleBreakImmune(pair: OrderPair): boolean {
  return boolFlag(pair, FLAG_MORALE_BREAK_IMMUNE);
}

/** 上陸: 水際からの強襲を行うか。 */
export function hasWaterAssault(pair: OrderPair): boolean {
  return boolFlag(pair, FLAG_WATER_ASSAULT);
}

/** 圧壊: 相性の不利を打ち消す突破力を持つか。 */
export function hasPushThrough(pair: OrderPair): boolean {
  return boolFlag(pair, FLAG_PUSH_THROUGH);
}

/**
 * 交易: 戦域を維持している間の **毎秒** 収入（Fx）を `out` に書く。
 * 収入を持つ令が 1 つも無ければ false（`out` は触らない）。
 * 両段が持っていれば資源ごとに加算する（倍率ではなく量なので和が自然）。
 *
 * 呼び出し側がバッファを渡す形にしてあるのは、毎 tick × 戦域数の確保を避けるため。
 */
export function holdIncomePerSec(pair: OrderPair, out: Int32Array): boolean {
  if (pair === NO_ORDERS) return false;
  let any = false;
  const u = upperOf(pair);
  const l = lowerOf(pair);
  const a = u >= 0 ? parsedOf(u).perSec.get(FLAG_HOLD_INCOME) : undefined;
  const b = l >= 0 ? parsedOf(l).perSec.get(FLAG_HOLD_INCOME) : undefined;
  if (a === undefined && b === undefined) return false;
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    const v = (a?.[r] ?? 0) + (b?.[r] ?? 0);
    out[r] = v;
    if (v !== 0) any = true;
  }
  return any;
}

// ---------------------------------------------------------------- 令に紐づく config

/**
 * 上陸の強襲ダメージ倍率（`orderEffects.waterAssaultDamageMul`）。
 *
 * 倍率を `orders.json` 側ではなく `config.json` 側に置いた理由:
 * `waterAssault` は真偽値のフラグ（= 「その挙動をするか」）で、
 * 挙動の強さは令ごとに変える必要がないため。同じフラグを別の令に付けても同じ強さで効く。
 */
export function waterAssaultDamageMul(): Fx {
  return cfgFx('orderEffects.waterAssaultDamageMul');
}

/** 上陸が「低所 → 高所」の地形不利（0.9）を打ち消すか。 */
export function waterAssaultIgnoresLowGround(): boolean {
  return cfgBool('orderEffects.waterAssaultIgnoresLowGround');
}

/** 奉納が建物の撃破も資源に変えるか（既定 false = ユニットのみ）。 */
export function killIncomeIncludesBuildings(): boolean {
  return cfgBool('orderEffects.killIncomeIncludesBuildings');
}
