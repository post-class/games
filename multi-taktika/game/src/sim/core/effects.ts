/**
 * sim/core/effects.ts — 効果（`effects` / `econBonus`）適用エンジン（T-M6-04）
 *
 * ここが解釈する効果の出どころは 3 つ。**どれも「型（`type`）」だけで分岐する。**
 * 研究名・文明名・建物名でコードが分岐してはいけない（実装手順書 §5.6）。
 *
 *   1. 研究     … `techs.json` の `effects`（`PlayerState.researched` が立っている研究）
 *   2. 文明     … `civs.json` の `econBonus`
 *   3. 建物     … `buildings.json` の `effects`（建っているだけで効く。**建物種別ごとに 1 回**）
 *      加えて `onDestroyEffects`（井戸・種籾蔵。破壊跡地の効果）を
 *      `DestroyedSite` レジストリ経由で扱う。
 *
 * 効果型の**唯一の登録簿**は `techs.json:_meta.effectTypes`。
 * このファイルは起動時に「登録簿の全型を解釈できるか」を検査して、
 * 未対応の型があれば**その場で例外**にする（黙って無視して「JSON に書いたのに効かない」
 * を作らないため。登録簿の note と対になっている）。
 *
 * ---- 設計方針 ----
 *
 * 毎 tick 全効果を走査すると重いので、プレイヤーごとに集約結果
 * （`PlayerModifiers`）をキャッシュする。ただし **キャッシュは World の状態から
 * 一意に決まる純粋な派生物**であること。これを守るために:
 *
 *   - `computePlayerModifiers(w, p)` は副作用のない純関数。同じ World 状態からは
 *     いつ呼んでも同じ結果になる（反復は必ず index 昇順、乗算の適用順も固定）。
 *   - キャッシュは `WeakMap<World, …>` に置き、**状態ハッシュの対象にしない**
 *     （派生物を hash に入れると「再計算タイミング違い」で偽のデシンクが出る。§4.5）。
 *   - `refreshModifiers(w)` が毎 tick 1 回だけ「効果の出どころの署名」を作り直し、
 *     署名が変わったプレイヤーだけ再計算する。**明示的な invalidate を忘れても
 *     次の tick で必ず自己修復する**（他システムの実装漏れでデシンクしないため）。
 *
 * 小数はすべて Fx（実数 × 256）。倍率の累積は `fxMul` の切り捨てなので
 * **掛ける順序が結果を決める**。順序は「文明 → 研究（tech index 昇順）→
 * 建物（building index 昇順）」に固定している。
 */

import buildingsJson from '@/data/buildings.json' with { type: 'json' };
import techsJson from '@/data/techs.json' with { type: 'json' };

import type { CivId, PlayerId, ResourceId } from '@/shared/types';
import { EntityKind, RESOURCE_COUNT, RESOURCE_IDS } from '@/shared/types';
import type { Fx } from './fx';
import { FX_ONE, distSq, fx, fxMul } from './fx';
import type { BuildingDef, UnitDef } from './defs';
import {
  BUILDING_DEFS,
  TECH_DEFS,
  UNIT_DEFS,
  buildingIndex,
  civDefById,
  unitIndex,
} from './defs';
import { TICK_RATE, cfgNum } from './config';
import type { DestroyedSite, World } from './world';
import { MAX_PRODUCTION_QUEUE, PROGRESS_DONE } from './entity';

// ---------------------------------------------------------------- 語彙

/** `unitStat` / `shipStatMul` の `stat`。順序が表の添字になる。 */
export const UNIT_STAT_IDS = ['atk', 'def', 'pierceDef', 'rangeTiles', 'speed', 'hp'] as const;
export type UnitStat = (typeof UNIT_STAT_IDS)[number];
const UNIT_STAT_COUNT = UNIT_STAT_IDS.length;

/**
 * `gatherRateMul` の `from`（採集元）。`techs.json:_meta.effectTypes` の記述順。
 * 表の添字は **+1**（0 = 種別を絞らないワイルドカード）。
 */
export const GATHER_FROM_IDS = ['farm', 'forest', 'mine', 'hunt', 'fish', 'fruit', 'herd'] as const;
export type GatherFrom = (typeof GATHER_FROM_IDS)[number];

/**
 * この適用エンジンが解釈できる効果型の一覧。
 * `techs.json:_meta.effectTypes` の登録簿と**完全一致**していなければ起動時に落ちる。
 */
export const SUPPORTED_EFFECT_TYPES: readonly string[] = [
  // ---- ユニットの数値 ----
  'unitStat',
  'shipStatMul',
  'rangedResistAdd',
  'lowHpAtkBonus',
  // ---- 令・戦域 ----
  'frontSlot',
  'orderDelayMul',
  'orderDelayDistanceZero',
  'orderSwitchIntervalMul',
  'orderStackSlots',
  // ---- 経済 ----
  'gatherRateMul',
  'depositMul',
  'farmYieldMul',
  'tradeIncomeMul',
  'cartSpeedMul',
  'startResourceAdd',
  // ---- 生産・研究・建設 ----
  'produceSpeedMul',
  'queueLengthAdd',
  'researchCostMul',
  'researchTimeMul',
  'unitCostMul',
  'eliteCostMul',
  'buildCostMul',
  'buildSpeedMul',
  'healSpeedMul',
  'buildingSightAdd',
  'unlockUnits',
  'buildingLimitOverride',
  // ---- 座標依存（集約せず問い合わせ時に評価する）----
  'gatherRateAura',
  'trainRateAura',
  'moveSpeedOnTile',
  // ---- 破壊跡地（DestroyedSite レジストリ経由）----
  'forbidRebuildHere',
  'forbidRebuildNearby',
];

const SUPPORTED = new Set<string>(SUPPORTED_EFFECT_TYPES);

/**
 * 座標依存 or 破壊跡地由来のため `PlayerModifiers` に畳み込まない型。
 * `applyEffect` はこれらを黙って読み飛ばす（別 API で評価する）。
 */
const POSITIONAL_TYPES = new Set<string>([
  'gatherRateAura',
  'trainRateAura',
  'moveSpeedOnTile',
  'forbidRebuildHere',
  'forbidRebuildNearby',
]);

/** 登録簿（`techs.json:_meta.effectTypes`）の型 ID 一覧。 */
export function registeredEffectTypes(): readonly string[] {
  const meta = (techsJson as unknown as Record<string, Record<string, unknown>>)['_meta'] ?? {};
  const reg = meta['effectTypes'];
  if (typeof reg !== 'object' || reg === null) return [];
  return Object.keys(reg as Record<string, unknown>);
}

/**
 * 登録簿と実装の網羅性を検査する。**モジュール読込時に 1 回走る。**
 * 新しい効果型を JSON に足して実装を忘れると、ここで起動時に落ちる。
 */
function assertEffectTypeCoverage(): void {
  const registered = registeredEffectTypes();
  const missing = registered.filter((t) => !SUPPORTED.has(t));
  const extra = SUPPORTED_EFFECT_TYPES.filter((t) => !registered.includes(t));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      'effects: 効果型の登録簿と適用エンジンが食い違っています。' +
        (missing.length > 0 ? ` 未実装: ${missing.join(', ')}.` : '') +
        (extra.length > 0 ? ` 登録簿に無い: ${extra.join(', ')}.` : '') +
        ' techs.json:_meta.effectTypes と SUPPORTED_EFFECT_TYPES を一致させること。'
    );
  }
}
assertEffectTypeCoverage();

// ---------------------------------------------------------------- 集約結果

const U = UNIT_DEFS.length;
const B = BUILDING_DEFS.length;
/** 建物添字は **+1**（0 = 建物を絞らないワイルドカード）。 */
const B1 = B + 1;
const GATHER_ROWS = RESOURCE_COUNT + 1;
const GATHER_COLS = GATHER_FROM_IDS.length + 1;

/**
 * プレイヤー 1 人ぶんの修飾子の集約結果。
 *
 * **World の状態から一意に決まる派生物**であり、World の一部ではない。
 * 状態ハッシュに入れてはいけない。
 */
export interface PlayerModifiers {
  readonly playerId: PlayerId;
  /** 生成元の署名（`refreshModifiers` が変化検出に使う）。 */
  signature: number;

  /** `[stat * U + unitTypeId]` の加算（Fx）。 */
  readonly unitAdd: Int32Array;
  /** `[stat * U + unitTypeId]` の乗算（Fx、既定 FX_ONE）。 */
  readonly unitMul: Int32Array;
  /** 船（line=ship）のみに掛かる乗算（Fx）。`[stat]`。 */
  readonly shipMul: Int32Array;
  /** 遠隔（貫通）耐性の加算（Fx）。`[unitTypeId]`。 */
  readonly rangedResist: Int32Array;
  /** 瀕死時の攻撃倍率の上限（Fx。0 = 効果なし）。`[unitTypeId]`。 */
  readonly lowHpMaxAtkMul: Int32Array;
  /** 上記に到達する欠損体力比（Fx）。`[unitTypeId]`。 */
  readonly lowHpAtRatio: Int32Array;

  frontSlotAdd: number;
  orderDelayMul: Fx;
  orderDelayDistanceZero: boolean;
  orderSwitchIntervalMul: Fx;
  /** 1 戦域に重ねられる令の枚数（既定 1）。 */
  orderStackSlots: number;

  /** `[(resIdx+1) * GATHER_COLS + (fromIdx+1)]`。添字 0 はワイルドカード。 */
  readonly gatherMul: Int32Array;
  /** `[resIdx]` 埋蔵量の倍率（Fx）。 */
  readonly depositMul: Int32Array;
  farmYieldMul: Fx;
  /** 全建物の視界加算（Fx）。 */
  buildingSightAdd: Fx;

  researchCostMul: Fx;
  /** `[buildingTypeId]`。その建物で研究するときだけ掛かる倍率（Fx）。 */
  readonly researchCostMulAt: Int32Array;
  researchTimeMul: Fx;
  readonly researchTimeMulAt: Int32Array;

  /** `[unitTypeId * B1 + (buildingTypeId+1)]`（Fx）。列 0 はワイルドカード。 */
  readonly produceSpeedMul: Int32Array;
  /** `[buildingTypeId+1]` 生産キュー長の加算。添字 0 はワイルドカード。 */
  readonly queueLengthAdd: Int32Array;

  healSpeedMul: Fx;
  eliteCostMul: Fx;
  tradeIncomeMul: Fx;
  cartSpeedMul: Fx;
  buildSpeedMul: Fx;
  buildCostMul: Fx;
  /** `[buildingTypeId]` その建物だけの建設コスト倍率（Fx）。 */
  readonly buildCostMulAt: Int32Array;
  /** `[unitTypeId]` 生産コスト倍率（Fx）。 */
  readonly unitCostMul: Int32Array;
  /** `[resIdx]` 開始資源の加算（Fx）。 */
  readonly startResourceAdd: Int32Array;

  /**
   * 座標依存のオーラを持つ建物を実際に所有しているか。
   * 持っていないときに毎 tick の全建物走査を省くための目印（結果は変わらない）。
   */
  hasGatherRateAura: boolean;
  hasTrainRateAura: boolean;

  /** `[unitTypeId]` 1 = 建物によって解禁済み。 */
  readonly unlockedUnits: Uint8Array;
  /** `[buildingTypeId]` 建設上限の上書き（-1 = 上書きなし）。 */
  readonly buildingLimit: Int32Array;
}

function createModifiers(playerId: PlayerId): PlayerModifiers {
  return {
    playerId,
    signature: 0,
    unitAdd: new Int32Array(UNIT_STAT_COUNT * U),
    unitMul: new Int32Array(UNIT_STAT_COUNT * U).fill(FX_ONE),
    shipMul: new Int32Array(UNIT_STAT_COUNT).fill(FX_ONE),
    rangedResist: new Int32Array(U),
    lowHpMaxAtkMul: new Int32Array(U),
    lowHpAtRatio: new Int32Array(U),
    frontSlotAdd: 0,
    orderDelayMul: FX_ONE,
    orderDelayDistanceZero: false,
    orderSwitchIntervalMul: FX_ONE,
    orderStackSlots: 1,
    gatherMul: new Int32Array(GATHER_ROWS * GATHER_COLS).fill(FX_ONE),
    depositMul: new Int32Array(RESOURCE_COUNT).fill(FX_ONE),
    farmYieldMul: FX_ONE,
    buildingSightAdd: 0,
    researchCostMul: FX_ONE,
    researchCostMulAt: new Int32Array(B).fill(FX_ONE),
    researchTimeMul: FX_ONE,
    researchTimeMulAt: new Int32Array(B).fill(FX_ONE),
    produceSpeedMul: new Int32Array(U * B1).fill(FX_ONE),
    queueLengthAdd: new Int32Array(B1),
    healSpeedMul: FX_ONE,
    eliteCostMul: FX_ONE,
    tradeIncomeMul: FX_ONE,
    cartSpeedMul: FX_ONE,
    buildSpeedMul: FX_ONE,
    buildCostMul: FX_ONE,
    buildCostMulAt: new Int32Array(B).fill(FX_ONE),
    unitCostMul: new Int32Array(U).fill(FX_ONE),
    startResourceAdd: new Int32Array(RESOURCE_COUNT),
    hasGatherRateAura: false,
    hasTrainRateAura: false,
    unlockedUnits: new Uint8Array(U),
    buildingLimit: new Int32Array(B).fill(-1),
  };
}

// ---------------------------------------------------------------- 効果の読み取り

type Effect = Record<string, unknown>;

function numOf(e: Effect, key: string, fallback: number): number {
  const v = e[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 倍率を Fx で読む（既定 1.0）。 */
function mulOf(e: Effect): Fx {
  return fx(numOf(e, 'mul', 1));
}

/** 単数キー / 複数キーの両方を受ける（`line` と `lines` など）。 */
function oneOrMany(single: unknown, many: unknown): readonly string[] {
  if (Array.isArray(many)) return many.filter((x): x is string => typeof x === 'string');
  if (typeof many === 'string') return [many];
  if (Array.isArray(single)) return single.filter((x): x is string => typeof x === 'string');
  if (typeof single === 'string') return [single];
  return [];
}

/**
 * ユニット選択子（`lines` / `roles` / `units`）に合致するか。
 * **複数指定は AND ではなく OR の和集合**（登録簿の記述どおり）。
 * どれも指定が無ければ全ユニットに掛かる。
 */
function matchesUnit(e: Effect, def: UnitDef): boolean {
  const lines = oneOrMany(e['line'], e['lines']);
  const roles = oneOrMany(e['role'], e['roles']);
  const units = oneOrMany(e['unit'], e['units']);
  if (lines.length === 0 && roles.length === 0 && units.length === 0) return true;
  if (lines.includes(def.line)) return true;
  // **エリートは「自分の系統」も兼ねる。**
  //
  // `units.json` はエリート兵（武士・レギオン・ベルセルク・連弩兵…）の `line` を
  // `elite` にしている。系統が 1 列しか無いので、そう書くと
  // **エリートが近接でも遠隔でもなくなる**。すると `03§9` の
  // 「打刃 ― 近接兵の攻撃 +1」「革鎧 ― 歩兵の防御 +1」がエリートに効かず、
  // 城で作った切り札が、研究を積んだ通常兵より弱いという逆転が起きる。
  // 資料はエリートを除外していない（除外するとも書いていない）ので、
  // **役割（`role`）から本来の系統を補って判定する**。
  //
  // 一律に `elite` を `melee` 扱いにはできない ―― エリートは
  // 近接（武士）・遠隔（連弩兵）・騎兵（親衛弓騎兵）・獣（親衛象）に跨っているので、
  // 「打刃が連弩兵の攻撃を上げる」ような取り違えになる。
  if (def.line === 'elite' && lines.includes(eliteImpliedLine(def.role))) return true;
  if (roles.includes(def.role)) return true;
  return units.includes(def.id);
}

/**
 * エリート兵の `role` から本来の系統を求める（表に無い役割は 'none' ＝ どの系統にも属さない）。
 * `role` は `config.json` の `counterMatrix` のキー（相性の輪の役割）。
 */
function eliteImpliedLine(role: string): string {
  switch (role) {
    case 'spear':
    case 'sword':
      return 'melee';
    case 'ranged':
    case 'gunpowder':
      return 'ranged';
    case 'cavalry':
    case 'camel':
      return 'cavalry';
    case 'beast':
      return 'beast';
    case 'siege':
      return 'siege';
    case 'ship':
      return 'ship';
    default:
      return 'none';
  }
}

/** `at`（生産建物・研究建物）の列添字（ワイルドカードは [0]）。 */
function atColumns(e: Effect, fallbackBuilding: number): readonly number[] {
  const ats = oneOrMany(e['at'], e['at']);
  if (ats.length === 0) return fallbackBuilding >= 0 ? [fallbackBuilding + 1] : [0];
  return ats.map((id) => buildingIndex(id) + 1);
}

function statIndex(e: Effect): number {
  const s = e['stat'];
  const i = UNIT_STAT_IDS.indexOf(s as UnitStat);
  if (i < 0) throw new Error(`effects: 未知の stat "${String(s)}"（UNIT_STAT_IDS に無い）`);
  return i;
}

function mulInto(a: Int32Array, i: number, m: Fx): void {
  a[i] = fxMul(a[i]!, m);
}

/**
 * 効果 1 件を集約結果に畳み込む。
 *
 * @param atBuilding 建物由来の効果なら **その建物の typeId**（`at` 省略時の既定対象）。
 *                   研究・文明由来は -1（= 建物を絞らない）。
 */
function applyEffect(m: PlayerModifiers, e: Effect, atBuilding: number): void {
  const type = e['type'];
  if (typeof type !== 'string') return;
  if (POSITIONAL_TYPES.has(type)) {
    // 座標依存・跡地由来は別 API で評価する。ここでは「持っているか」だけ覚える
    // （持っていない tick で全建物を走査しないための最適化。結果は変わらない）。
    if (type === 'gatherRateAura') m.hasGatherRateAura = true;
    else if (type === 'trainRateAura') m.hasTrainRateAura = true;
    return;
  }
  switch (type) {
    case 'unitStat': {
      const s = statIndex(e);
      const add = fx(numOf(e, 'add', 0));
      const hasMul = typeof e['mul'] === 'number';
      const mul = mulOf(e);
      for (let u = 0; u < U; u++) {
        if (!matchesUnit(e, UNIT_DEFS[u]!)) continue;
        if (add !== 0) m.unitAdd[s * U + u] = m.unitAdd[s * U + u]! + add;
        if (hasMul) mulInto(m.unitMul, s * U + u, mul);
      }
      break;
    }
    case 'shipStatMul':
      mulInto(m.shipMul, statIndex(e), mulOf(e));
      break;
    case 'rangedResistAdd': {
      const add = fx(numOf(e, 'add', 0));
      for (let u = 0; u < U; u++) {
        if (matchesUnit(e, UNIT_DEFS[u]!)) m.rangedResist[u] = m.rangedResist[u]! + add;
      }
      break;
    }
    case 'lowHpAtkBonus': {
      const maxMul = fx(numOf(e, 'maxAtkMul', 1));
      const at = fx(numOf(e, 'atMissingHpRatio', 1));
      for (let u = 0; u < U; u++) {
        if (!matchesUnit(e, UNIT_DEFS[u]!)) continue;
        // 複数重なったら「最も強いもの」を採る（重ね掛けの規則は資料に無い）。
        if (maxMul > m.lowHpMaxAtkMul[u]!) {
          m.lowHpMaxAtkMul[u] = maxMul;
          m.lowHpAtRatio[u] = at;
        }
      }
      break;
    }
    case 'frontSlot':
      m.frontSlotAdd += numOf(e, 'add', 0);
      break;
    case 'orderDelayMul':
      m.orderDelayMul = fxMul(m.orderDelayMul, mulOf(e));
      break;
    case 'orderDelayDistanceZero':
      m.orderDelayDistanceZero = true;
      break;
    case 'orderSwitchIntervalMul':
      m.orderSwitchIntervalMul = fxMul(m.orderSwitchIntervalMul, mulOf(e));
      break;
    case 'orderStackSlots': {
      const slots = numOf(e, 'slots', 1);
      if (slots > m.orderStackSlots) m.orderStackSlots = slots;
      break;
    }
    case 'gatherRateMul': {
      const mul = mulOf(e);
      const resources = oneOrMany(e['resource'], e['resources']);
      const froms = oneOrMany(e['from'], e['from']);
      const rows = resources.length === 0 ? [0] : resources.map((r) => resourceCol(r) + 1);
      const cols = froms.length === 0 ? [0] : froms.map((f) => gatherFromCol(f) + 1);
      for (const r of rows) for (const c of cols) mulInto(m.gatherMul, r * GATHER_COLS + c, mul);
      break;
    }
    case 'depositMul': {
      const mul = mulOf(e);
      const resources = oneOrMany(e['resource'], e['resources']);
      if (resources.length === 0) {
        for (let r = 0; r < RESOURCE_COUNT; r++) mulInto(m.depositMul, r, mul);
      } else {
        for (const r of resources) mulInto(m.depositMul, resourceCol(r), mul);
      }
      break;
    }
    case 'farmYieldMul':
      m.farmYieldMul = fxMul(m.farmYieldMul, mulOf(e));
      break;
    case 'tradeIncomeMul':
      m.tradeIncomeMul = fxMul(m.tradeIncomeMul, mulOf(e));
      break;
    case 'cartSpeedMul':
      m.cartSpeedMul = fxMul(m.cartSpeedMul, mulOf(e));
      break;
    case 'startResourceAdd':
      for (let r = 0; r < RESOURCE_COUNT; r++) {
        const key = RESOURCE_IDS[r]!;
        const v = e[key];
        if (typeof v === 'number') m.startResourceAdd[r] = m.startResourceAdd[r]! + fx(v);
      }
      break;
    case 'produceSpeedMul': {
      const mul = mulOf(e);
      const cols = atColumns(e, -1);
      for (let u = 0; u < U; u++) {
        if (!matchesUnit(e, UNIT_DEFS[u]!)) continue;
        for (const c of cols) mulInto(m.produceSpeedMul, u * B1 + c, mul);
      }
      break;
    }
    case 'queueLengthAdd': {
      const add = numOf(e, 'add', 0);
      for (const c of atColumns(e, -1)) m.queueLengthAdd[c] = m.queueLengthAdd[c]! + add;
      break;
    }
    case 'researchCostMul':
      // 建物由来（翰林院）は「その建物で研究するとき」だけに掛ける。
      if (atBuilding >= 0) mulInto(m.researchCostMulAt, atBuilding, mulOf(e));
      else m.researchCostMul = fxMul(m.researchCostMul, mulOf(e));
      break;
    case 'researchTimeMul':
      if (atBuilding >= 0) mulInto(m.researchTimeMulAt, atBuilding, mulOf(e));
      else m.researchTimeMul = fxMul(m.researchTimeMul, mulOf(e));
      break;
    case 'unitCostMul': {
      const mul = mulOf(e);
      for (let u = 0; u < U; u++) {
        if (matchesUnit(e, UNIT_DEFS[u]!)) mulInto(m.unitCostMul, u, mul);
      }
      break;
    }
    case 'eliteCostMul':
      m.eliteCostMul = fxMul(m.eliteCostMul, mulOf(e));
      break;
    case 'buildCostMul': {
      const mul = mulOf(e);
      const targets = oneOrMany(e['building'], e['buildings']);
      if (targets.length === 0) m.buildCostMul = fxMul(m.buildCostMul, mul);
      else for (const b of targets) mulInto(m.buildCostMulAt, buildingIndex(b), mul);
      break;
    }
    case 'buildSpeedMul':
      m.buildSpeedMul = fxMul(m.buildSpeedMul, mulOf(e));
      break;
    case 'healSpeedMul':
      m.healSpeedMul = fxMul(m.healSpeedMul, mulOf(e));
      break;
    case 'buildingSightAdd':
      m.buildingSightAdd += fx(numOf(e, 'add', 0));
      break;
    case 'unlockUnits':
      for (const id of oneOrMany(e['unit'], e['units'])) m.unlockedUnits[unitIndex(id)] = 1;
      break;
    case 'buildingLimitOverride': {
      const targets = oneOrMany(e['building'], e['buildings']);
      const max = numOf(e, 'max', -1);
      for (const b of targets) m.buildingLimit[buildingIndex(b)] = max;
      break;
    }
    default:
      throw new Error(
        `effects: 効果型 "${type}" は登録簿にあるが applyEffect が処理していません（実装漏れ）`
      );
  }
}

function resourceCol(id: string): number {
  const i = RESOURCE_IDS.indexOf(id as ResourceId);
  if (i < 0) throw new Error(`effects: 未知の resource "${id}"`);
  return i;
}

function gatherFromCol(id: string): number {
  const i = GATHER_FROM_IDS.indexOf(id as GatherFrom);
  if (i < 0) throw new Error(`effects: 未知の採集元 "${id}"（GATHER_FROM_IDS に無い）`);
  return i;
}

// ---------------------------------------------------------------- 集約（純関数）

/**
 * プレイヤー 1 人の修飾子を World の状態から作る。**純関数**。
 *
 * 適用順（結果を決める）:
 *   1. 文明の `econBonus`（`civs.json` の記述順）
 *   2. 研究（**tech index 昇順**。`researched` が立っているもの）
 *   3. 完成済みの自軍建物（**building index 昇順・同種は 1 回だけ**）
 *
 * 建物を「同種 1 回だけ」にするのは、翰林院を 2 つ建てて研究コストが
 * 0.64 倍になるような二重計上を避けるため（「存在するだけで効く」効果なので個数は無関係）。
 */
export function computePlayerModifiers(w: World, p: PlayerId): PlayerModifiers {
  const m = createModifiers(p);
  const pl = w.players[p];
  if (pl === undefined) return m;

  // 1. 文明
  const civ = civDefById(pl.civ);
  for (let i = 0; i < civ.econBonus.length; i++) {
    applyEffect(m, civ.econBonus[i]!, -1);
  }

  // 2. 研究（tech index 昇順）
  for (let t = 0; t < TECH_DEFS.length; t++) {
    if (pl.researched[t] !== 1) continue;
    const def = TECH_DEFS[t]!;
    for (let i = 0; i < def.effects.length; i++) applyEffect(m, def.effects[i]!, -1);
  }

  // 3. 建物（種別ごとに 1 回。building index 昇順で走るよう先に集める）
  const owned = new Uint8Array(B);
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    if (!isBuildingComplete(w, i)) continue;
    owned[e.typeId[i]!] = 1;
  }
  for (let b = 0; b < B; b++) {
    if (owned[b] !== 1) continue;
    const def = BUILDING_DEFS[b]!;
    for (let i = 0; i < def.effects.length; i++) applyEffect(m, def.effects[i]!, b);
  }

  m.signature = playerSignature(w, p);
  return m;
}

// 進捗の番兵値は `core/entity.ts`（フィールドの持ち主）にある。
// 以前ここで定義していたが、population.ts など entity 側だけを見るモジュールからも
// 必要になったため移した。互換のためここから再エクスポートしている。
export { PROGRESS_DONE } from './entity';


/**
 * 建設が完了しているか。
 *
 * **規約**: `buildProgress === PROGRESS_DONE` が「完成」。試合開始時に配置する建物
 * （mapgen / シナリオ）も必ずこれを入れること（`spawnBuilding` を使えば自動）。
 */
export function isBuildingComplete(w: World, index: number): boolean {
  return w.entities.buildProgress[index]! >= PROGRESS_DONE;
}

// ---------------------------------------------------------------- キャッシュ

interface ModCache {
  /** playerId 昇順。null = 再計算が必要。 */
  readonly mods: (PlayerModifiers | null)[];
  /** 最後に署名検査を行った tick（-1 = 未実施）。 */
  lastCheckTick: number;
}

/**
 * World ごとのキャッシュ。**状態ハッシュの対象外**（派生物）。
 * `WeakMap` はキー引きにしか使わないので反復順の問題は起きない（§0.3）。
 */
const cacheStore = new WeakMap<World, ModCache>();

function cacheOf(w: World): ModCache {
  let c = cacheStore.get(w);
  if (c === undefined) {
    c = { mods: new Array<PlayerModifiers | null>(w.playerCount).fill(null), lastCheckTick: -1 };
    cacheStore.set(w, c);
  }
  return c;
}

/**
 * 効果の出どころの署名。研究・時代・完成済み自軍建物（種別と座標）から作る。
 * 署名が同じなら `computePlayerModifiers` の結果も同じ。
 */
function playerSignature(w: World, p: PlayerId): number {
  const pl = w.players[p];
  if (pl === undefined) return 0;
  let h = 0x811c9dc5;
  h = mix(h, pl.age);
  h = mix(h, civDefById(pl.civ).index);
  for (let i = 0; i < pl.researched.length; i++) h = mix(h, pl.researched[i]!);
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    h = mix(h, e.typeId[i]!);
    h = mix(h, e.buildProgress[i]! >= PROGRESS_DONE ? 1 : 0);
    // オーラは座標依存なので位置も署名に含める。
    h = mix(h, e.x[i]!);
    h = mix(h, e.y[i]!);
  }
  return h;
}

function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 0x01000193) >>> 0;
}

/**
 * 集約結果を得る（無ければ計算する）。
 * 毎 tick 何度呼んでもよい。**中身を書き換えてはいけない。**
 */
export function getPlayerModifiers(w: World, p: PlayerId): PlayerModifiers {
  const c = cacheOf(w);
  const hit = c.mods[p];
  if (hit !== null && hit !== undefined) return hit;
  const m = computePlayerModifiers(w, p);
  c.mods[p] = m;
  return m;
}

/**
 * 再計算を予約する。研究完了 / 時代進化 / 建物の完成・破壊・移動のときに呼ぶ。
 * 呼び忘れても `refreshModifiers` が次の tick で自己修復する。
 */
export function markModifiersDirty(w: World, p?: PlayerId): void {
  const c = cacheOf(w);
  if (p === undefined) {
    for (let i = 0; i < c.mods.length; i++) c.mods[i] = null;
  } else if (p >= 0 && p < c.mods.length) {
    c.mods[p] = null;
  }
}

/**
 * 署名を作り直し、変わったプレイヤーのキャッシュを捨てる。
 * **毎 tick 1 回だけ**走る（1 tick 内で複数回呼んでも 1 回しか検査しない）。
 *
 * これがあるおかげで、他システムが `markModifiersDirty` を呼び忘れても
 * 遅れは最大 1 tick に収まり、キャッシュは常に World の純粋な派生物になる。
 */
export function refreshModifiers(w: World): void {
  const c = cacheOf(w);
  if (c.lastCheckTick === w.tick) return;
  c.lastCheckTick = w.tick;
  for (let p = 0; p < w.playerCount; p++) {
    const cur = c.mods[p];
    if (cur === null || cur === undefined) continue;
    if (cur.signature !== playerSignature(w, p)) c.mods[p] = null;
  }
}

// ---------------------------------------------------------------- 問い合わせ API

/** ユニットの数値の加算（Fx）。 */
export function unitStatAdd(m: PlayerModifiers, def: UnitDef, stat: UnitStat): Fx {
  return m.unitAdd[UNIT_STAT_IDS.indexOf(stat) * U + def.index]!;
}

/** ユニットの数値の乗算（Fx）。船（line=ship）には `shipStatMul` も掛かる。 */
export function unitStatMul(m: PlayerModifiers, def: UnitDef, stat: UnitStat): Fx {
  const s = UNIT_STAT_IDS.indexOf(stat);
  const base = m.unitMul[s * U + def.index]!;
  return def.line === 'ship' ? fxMul(base, m.shipMul[s]!) : base;
}

/** 素の値に加算 → 乗算の順で適用した値（Fx）。登録簿の「add → mul の順」に従う。 */
export function applyUnitStat(m: PlayerModifiers, def: UnitDef, stat: UnitStat, base: Fx): Fx {
  return fxMul(base + unitStatAdd(m, def, stat), unitStatMul(m, def, stat));
}

/** 船だけに掛かる倍率（`unitStatMul` に含まれる。内訳を見たいとき用）。 */
export function shipStatMul(m: PlayerModifiers, stat: UnitStat): Fx {
  return m.shipMul[UNIT_STAT_IDS.indexOf(stat)]!;
}

/** 遠隔（貫通）耐性の加算（Fx）。 */
export function rangedResistAdd(m: PlayerModifiers, def: UnitDef): Fx {
  return m.rangedResist[def.index]!;
}

/**
 * 体力が減るほど攻撃が上がる倍率（Fx）。
 * 欠損体力比 0 で 1.0、`atMissingHpRatio` で `maxAtkMul` まで線形。
 * @param missingHpRatio 欠損体力比（Fx、0..FX_ONE）
 */
export function lowHpAtkBonus(m: PlayerModifiers, def: UnitDef, missingHpRatio: Fx): Fx {
  const maxMul = m.lowHpMaxAtkMul[def.index]!;
  if (maxMul === 0) return FX_ONE;
  const at = m.lowHpAtRatio[def.index]!;
  if (at <= 0) return maxMul;
  const r = missingHpRatio < 0 ? 0 : missingHpRatio > at ? at : missingHpRatio;
  // 1.0 + (maxMul - 1.0) * r / at
  return FX_ONE + Math.trunc(((maxMul - FX_ONE) * r) / at);
}

/** 戦域スロットの加算（研究「旗竿」など）。 */
export function frontSlotBonus(m: PlayerModifiers): number {
  return m.frontSlotAdd;
}

/** 令の遅延倍率（Fx）。 */
export function orderDelayMul(m: PlayerModifiers): Fx {
  return m.orderDelayMul;
}

/** 令の遅延式から距離の項を消すか（モンゴル駅伝）。 */
export function orderDelayDistanceZero(m: PlayerModifiers): boolean {
  return m.orderDelayDistanceZero;
}

/** 令の切り替え間隔の倍率（Fx）。 */
export function orderSwitchIntervalMul(m: PlayerModifiers): Fx {
  return m.orderSwitchIntervalMul;
}

/** 1 戦域に重ねられる令の枚数（既定 1、二重旗で 2）。 */
export function orderStackSlots(m: PlayerModifiers): number {
  return m.orderStackSlots;
}

/**
 * 採集速度の倍率（Fx）。
 * ワイルドカード（資源を絞らない / 採集元を絞らない）と個別指定の積。
 */
export function gatherRateMul(
  m: PlayerModifiers,
  resource: ResourceId | null,
  from: GatherFrom | null
): Fx {
  const r = resource === null ? 0 : resourceCol(resource) + 1;
  const c = from === null ? 0 : gatherFromCol(from) + 1;
  let v = m.gatherMul[0]!;
  if (c !== 0) v = fxMul(v, m.gatherMul[c]!);
  if (r !== 0) {
    v = fxMul(v, m.gatherMul[r * GATHER_COLS]!);
    if (c !== 0) v = fxMul(v, m.gatherMul[r * GATHER_COLS + c]!);
  }
  return v;
}

/** 埋蔵量の倍率（Fx。坑道）。 */
export function depositMul(m: PlayerModifiers, resource: ResourceId): Fx {
  return m.depositMul[resourceCol(resource)]!;
}

/** 農地 1 面の産出量の倍率（Fx）。 */
export function farmYieldMul(m: PlayerModifiers): Fx {
  return m.farmYieldMul;
}

/** 全建物の視界加算（Fx。測量）。 */
export function buildingSightAdd(m: PlayerModifiers): Fx {
  return m.buildingSightAdd;
}

/** 研究コストの倍率（Fx）。`atBuildingId` を渡すとその建物固有の倍率も掛かる。 */
export function researchCostMul(m: PlayerModifiers, atBuildingId?: string): Fx {
  const g = m.researchCostMul;
  if (atBuildingId === undefined) return g;
  return fxMul(g, m.researchCostMulAt[buildingIndex(atBuildingId)]!);
}

/** 研究時間の倍率（Fx。翰林院 0.8）。 */
export function researchTimeMul(m: PlayerModifiers, atBuildingId?: string): Fx {
  const g = m.researchTimeMul;
  if (atBuildingId === undefined) return g;
  return fxMul(g, m.researchTimeMulAt[buildingIndex(atBuildingId)]!);
}

/** 生産速度の倍率（Fx）。`atBuildingId` 省略時は建物を絞らない分だけ。 */
export function produceSpeedMul(m: PlayerModifiers, def: UnitDef, atBuildingId?: string): Fx {
  const wild = m.produceSpeedMul[def.index * B1]!;
  if (atBuildingId === undefined) return wild;
  return fxMul(wild, m.produceSpeedMul[def.index * B1 + buildingIndex(atBuildingId) + 1]!);
}

/** 生産キューの基準長。`config.json` に無いので導出する（下の定数を参照）。 */
export function queueLength(m: PlayerModifiers, atBuildingId?: string): number {
  let n = QUEUE_LENGTH_BASE + m.queueLengthAdd[0]!;
  if (atBuildingId !== undefined) n += m.queueLengthAdd[buildingIndex(atBuildingId) + 1]!;
  return n > MAX_PRODUCTION_QUEUE ? MAX_PRODUCTION_QUEUE : n;
}

/** 治療速度の倍率（Fx。薬草）。 */
export function healSpeedMul(m: PlayerModifiers): Fx {
  return m.healSpeedMul;
}

/** エリートの生産コスト倍率（Fx。`unitCostMul` に含まれる内訳）。 */
export function eliteCostMul(m: PlayerModifiers): Fx {
  return m.eliteCostMul;
}

/** 交易収入の倍率（Fx）。 */
export function tradeIncomeMul(m: PlayerModifiers): Fx {
  return m.tradeIncomeMul;
}

/** 交易荷車の速度倍率（Fx）。 */
export function cartSpeedMul(m: PlayerModifiers): Fx {
  return m.cartSpeedMul;
}

/** 村人の建設速度の倍率（Fx。アステカ 1.3）。 */
export function buildSpeedMul(m: PlayerModifiers): Fx {
  return m.buildSpeedMul;
}

/** 建設コストの倍率（Fx）。建物を指定するとその建物固有の倍率も掛かる。 */
export function buildCostMul(m: PlayerModifiers, buildingId?: string): Fx {
  const g = m.buildCostMul;
  if (buildingId === undefined) return g;
  return fxMul(g, m.buildCostMulAt[buildingIndex(buildingId)]!);
}

/** ユニットの生産コスト倍率（Fx）。エリートには `eliteCostMul` も掛かる。 */
export function unitCostMul(m: PlayerModifiers, def: UnitDef): Fx {
  const base = m.unitCostMul[def.index]!;
  return def.line === 'elite' ? fxMul(base, m.eliteCostMul) : base;
}

/** 開始資源の加算（Fx。ペルシア）。 */
export function startResourceAdd(m: PlayerModifiers, resource: ResourceId): Fx {
  return m.startResourceAdd[resourceCol(resource)]!;
}

/** 建物によって解禁されたユニットか（船小屋 → 長船）。 */
export function isUnitUnlocked(m: PlayerModifiers, def: UnitDef): boolean {
  return m.unlockedUnits[def.index] === 1;
}

/**
 * その建物が「解禁を必要とするユニット」を持つか（`unlockUnits` の登録対象）。
 * データから作った集合なので、コードにユニット名を書かずに判定できる。
 */
export function unitRequiresUnlock(def: UnitDef): boolean {
  return UNITS_REQUIRING_UNLOCK[def.index] === 1;
}

/** 建設上限（`maxCount` の上書き。-1 = 上書きなし）。 */
export function buildingLimitOverride(m: PlayerModifiers, def: BuildingDef): number {
  return m.buildingLimit[def.index]!;
}

/** その建物の実効建設上限（0 = 無制限）。 */
export function buildingLimit(m: PlayerModifiers, def: BuildingDef): number {
  const o = buildingLimitOverride(m, def);
  return o >= 0 ? o : def.maxCount;
}

/** `unlockUnits` に載っているユニット（= 解禁が必要）。 */
const UNITS_REQUIRING_UNLOCK: Uint8Array = (() => {
  const out = new Uint8Array(U);
  for (let b = 0; b < B; b++) {
    for (const e of BUILDING_DEFS[b]!.effects) {
      if (e['type'] !== 'unlockUnits') continue;
      for (const id of oneOrMany(e['unit'], e['units'])) out[unitIndex(id)] = 1;
    }
  }
  return out;
})();

/**
 * 生産キューの基準長（5）。
 *
 * `config.json` に基準値のキーが無いため、確保上限（`MAX_PRODUCTION_QUEUE` = 10）から
 * データ上最大の `queueLengthAdd`（ローマ「軍団編成」の +5）を引いて導出する。
 * 数値リテラルをコードに書かない規約（§0.5）を守るための措置。
 * `config.json` に `production.queueLengthBase` が入ったらそちらを優先する。
 */
export const QUEUE_LENGTH_BASE: number = (() => {
  try {
    return cfgNum('production.queueLengthBase');
  } catch {
    let maxAdd = 0;
    for (const t of TECH_DEFS) {
      for (const e of t.effects) {
        if (e['type'] === 'queueLengthAdd') maxAdd = Math.max(maxAdd, numOf(e, 'add', 0));
      }
    }
    return MAX_PRODUCTION_QUEUE - maxAdd;
  }
})();

// ---------------------------------------------------------------- 座標依存（オーラ）

/**
 * 周囲の村人の採集速度に掛かるオーラの倍率（Fx）。
 * 出どころは自軍の建物（地下水路 +15%）と、破壊された付属物の跡地（井戸 0.8）。
 *
 * @param resource 採集中の資源（`scope` で絞られている場合の判定用。不明なら null）
 */
export function auraGatherMul(
  w: World,
  p: PlayerId,
  x: Fx,
  y: Fx,
  resource: ResourceId | null = null
): Fx {
  let v = FX_ONE;
  const e = w.entities;
  if (!getPlayerModifiers(w, p).hasGatherRateAura) return destroyedSiteGatherMul(w, p, x, y, resource);
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    if (!isBuildingComplete(w, i)) continue;
    const def = BUILDING_DEFS[e.typeId[i]!]!;
    for (const eff of def.effects) {
      if (eff['type'] !== 'gatherRateAura') continue;
      if (!auraScopeMatchesResource(eff, resource)) continue;
      if (!withinAura(eff, e.x[i]!, e.y[i]!, x, y)) continue;
      v = fxMul(v, mulOf(eff));
    }
  }
  return fxMul(v, destroyedSiteGatherMul(w, p, x, y, resource));
}

/**
 * 周囲の建物の生産速度に掛かるオーラの倍率（Fx。神殿基壇 +20%）。
 * @param military 生産対象が兵か（`scope: "military"` の判定）
 */
export function auraTrainMul(w: World, p: PlayerId, x: Fx, y: Fx, military: boolean): Fx {
  let v = FX_ONE;
  const e = w.entities;
  if (!getPlayerModifiers(w, p).hasTrainRateAura) return v;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    if (!isBuildingComplete(w, i)) continue;
    const def = BUILDING_DEFS[e.typeId[i]!]!;
    for (const eff of def.effects) {
      if (eff['type'] !== 'trainRateAura') continue;
      if (eff['scope'] === 'military' && !military) continue;
      if (!withinAura(eff, e.x[i]!, e.y[i]!, x, y)) continue;
      v = fxMul(v, mulOf(eff));
    }
  }
  return v;
}

/**
 * その座標の敷設物による移動速度倍率（Fx。街道 +30%）。
 * `scope: "ownerAndAlly"` は同チームにも効く。
 */
export function tileMoveSpeedMul(w: World, mover: PlayerId, x: Fx, y: Fx): Fx {
  let v = FX_ONE;
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (!isBuildingComplete(w, i)) continue;
    const def = BUILDING_DEFS[e.typeId[i]!]!;
    for (const eff of def.effects) {
      if (eff['type'] !== 'moveSpeedOnTile') continue;
      const owner = e.owner[i]!;
      const allowAlly = eff['scope'] === 'ownerAndAlly';
      if (owner !== mover && !(allowAlly && sameTeam(w, owner, mover))) continue;
      // 敷設物は 1 マス。同じマスに乗っているかで判定する。
      if (tileOf(e.x[i]!) !== tileOf(x) || tileOf(e.y[i]!) !== tileOf(y)) continue;
      v = fxMul(v, mulOf(eff));
    }
  }
  return v;
}

function sameTeam(w: World, a: PlayerId, b: PlayerId): boolean {
  if (a === b) return true;
  if (a < 0 || b < 0 || a >= w.playerCount || b >= w.playerCount) return false;
  return w.teams[a] === w.teams[b];
}

function tileOf(v: Fx): number {
  return Math.trunc(v / FX_ONE);
}

function withinAura(eff: Effect, sx: Fx, sy: Fx, x: Fx, y: Fx): boolean {
  const r = fx(numOf(eff, 'radiusTiles', 0));
  if (r <= 0) return false;
  return distSq(sx, sy, x, y) <= r * r;
}

/** `scope` が村人の採集に掛かるか（資源で絞る scope が来ても解釈できるようにする）。 */
function auraScopeMatchesResource(eff: Effect, resource: ResourceId | null): boolean {
  const scope = eff['scope'];
  if (typeof scope !== 'string') return true;
  if (scope === 'ownerVillagers') return true;
  // scope に資源 ID を書いた場合は資源で絞る。
  if (RESOURCE_IDS.includes(scope as ResourceId)) return resource === null || resource === scope;
  return true;
}

// ---------------------------------------------------------------- 破壊跡地

/**
 * 跡地レジストリ。**実体は `World.destroyedSites`**（状態ハッシュの対象。`sim/hash.ts`）。
 *
 * 以前は `WeakMap<World, DestroyedSite[]>` に置いていたが、
 * 跡地タイマーは「同じ場所に建て直せない」という**実際の状態**なので World に移した。
 * World 外に置くとリプレイで復元できず、デシンクもハッシュで検出できない。
 */
export type { DestroyedSite } from './world';

function sitesOf(w: World): DestroyedSite[] {
  return w.destroyedSites;
}

/** 跡地の一覧（`tick` 昇順 → 同 tick 内は (y, x) 昇順。読み取り専用）。 */
export function destroyedSites(w: World): readonly DestroyedSite[] {
  return w.destroyedSites;
}

/**
 * 2 つの跡地の全順序（負 = a が先）。
 * `World.destroyedSites` のコメントに書いた並び順の定義そのもの。
 */
function compareSites(a: DestroyedSite, b: DestroyedSite): number {
  if (a.tick !== b.tick) return a.tick - b.tick;
  if (a.tileY !== b.tileY) return a.tileY - b.tileY;
  if (a.tileX !== b.tileX) return a.tileX - b.tileX;
  if (a.typeId !== b.typeId) return a.typeId - b.typeId;
  return a.owner - b.owner;
}

/**
 * 跡地を登録する（建物が壊れたときに呼ぶ。入口は `construction.onBuildingDestroyed`）。
 *
 * **挿入位置を全順序で決める**ので、同一 tick に複数棟が壊れたときの呼び出し順
 * （攻撃の解決順・index 順）に結果が依存しない（§16-2）。
 * 末尾から線形に戻るだけなので、tick 昇順に呼ばれる通常ケースは O(1)。
 */
export function registerDestroyedSite(
  w: World,
  typeId: number,
  x: Fx,
  y: Fx,
  owner: PlayerId
): DestroyedSite {
  const def = BUILDING_DEFS[typeId]!;
  const site: DestroyedSite = {
    typeId,
    tileX: tileOf(x),
    tileY: tileOf(y),
    tick: w.tick,
    wasWall: def.isWall || def.isGate,
    owner,
  };
  const sites = w.destroyedSites;
  let at = sites.length;
  while (at > 0 && compareSites(sites[at - 1]!, site) > 0) at--;
  if (at === sites.length) sites.push(site);
  else sites.splice(at, 0, site);
  return site;
}

/** 一般跡地の残存 tick 数（`config.construction.rubbleSec`）。 */
const RUBBLE_TICKS = Math.round(cfgNum('construction.rubbleSec') * TICK_RATE);

/** 期限切れの跡地を捨てる（`construction` システムが毎 tick 呼ぶ）。 */
export function pruneDestroyedSites(w: World): void {
  const sites = sitesOf(w);
  let write = 0;
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]!;
    if (siteStillMatters(w, s)) {
      sites[write] = s;
      write++;
    }
  }
  sites.length = write;
}

function siteStillMatters(w: World, s: DestroyedSite): boolean {
  if (s.wasWall) return true; // 壁の穴は試合中ずっと残る
  if (w.tick - s.tick < RUBBLE_TICKS) return true;
  for (const eff of destroyEffectsOf(s.typeId)) {
    const t = eff['type'];
    if (t !== 'forbidRebuildHere' && t !== 'forbidRebuildNearby' && t !== 'gatherRateAura') continue;
    const d = numOf(eff, 'durationSec', -1);
    if (d < 0) return true;
    if (w.tick - s.tick < Math.round(d * TICK_RATE)) return true;
  }
  return false;
}

/** `buildings.json` の `onDestroyEffects`（`defs.ts` が公開していないので直接読む）。 */
function destroyEffectsOf(typeId: number): readonly Effect[] {
  const id = BUILDING_DEFS[typeId]!.id;
  const src = (buildingsJson as unknown as Record<string, Record<string, unknown>>)[id];
  const v = src?.['onDestroyEffects'];
  return Array.isArray(v) ? (v as Effect[]) : [];
}

/** 効果が今も有効か（`durationSec` -1 は永久）。 */
function destroyEffectActive(w: World, s: DestroyedSite, eff: Effect): boolean {
  const d = numOf(eff, 'durationSec', -1);
  if (d < 0) return true;
  return w.tick - s.tick < Math.round(d * TICK_RATE);
}

/**
 * その場所にその建物を建てられないか（跡地タイマー / `forbidRebuild*`）。
 * @param x,y 建てようとしている位置（Fx）
 */
export function isRebuildBlocked(w: World, buildingId: string, x: Fx, y: Fx): boolean {
  const tx = tileOf(x);
  const ty = tileOf(y);
  const target = buildingIndex(buildingId);
  const sites = sitesOf(w);
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]!;
    const sameTile = s.tileX === tx && s.tileY === ty;
    // 一般跡地（数十秒）。壁は穴が残るだけで建て直せる（時間が 1.5 倍になる）。
    if (sameTile && !s.wasWall && w.tick - s.tick < RUBBLE_TICKS) return true;
    for (const eff of destroyEffectsOf(s.typeId)) {
      const t = eff['type'];
      if (t === 'forbidRebuildHere') {
        if (sameTile && destroyEffectActive(w, s, eff)) return true;
      } else if (t === 'forbidRebuildNearby') {
        const b = eff['building'];
        if (typeof b === 'string' && buildingIndex(b) !== target) continue;
        if (!destroyEffectActive(w, s, eff)) continue;
        const r = fx(numOf(eff, 'radiusTiles', 0));
        if (distSq(fx(s.tileX), fx(s.tileY), fx(tx), fx(ty)) <= r * r) return true;
      }
    }
  }
  return false;
}

/** その場所が壊れた壁の穴か（建て直しの時間が伸びる。`07§9`）。 */
export function isWallHole(w: World, x: Fx, y: Fx): boolean {
  const tx = tileOf(x);
  const ty = tileOf(y);
  const sites = sitesOf(w);
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]!;
    if (s.wasWall && s.tileX === tx && s.tileY === ty) return true;
  }
  return false;
}

/** 跡地由来の採集オーラ（井戸を壊された跡地 0.8）。 */
function destroyedSiteGatherMul(
  w: World,
  p: PlayerId,
  x: Fx,
  y: Fx,
  resource: ResourceId | null
): Fx {
  let v = FX_ONE;
  const sites = sitesOf(w);
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]!;
    if (s.owner !== p) continue;
    for (const eff of destroyEffectsOf(s.typeId)) {
      if (eff['type'] !== 'gatherRateAura') continue;
      if (!destroyEffectActive(w, s, eff)) continue;
      if (!auraScopeMatchesResource(eff, resource)) continue;
      if (!withinAura(eff, fx(s.tileX), fx(s.tileY), x, y)) continue;
      v = fxMul(v, mulOf(eff));
    }
  }
  return v;
}

// ---------------------------------------------------------------- テスト・デバッグ用

/**
 * 集約結果の指紋。**テストとデバッグ専用**（World の状態ハッシュとは無関係）。
 * 「研究前と研究後で修飾子が変わったか」を 1 つの値で比べるために使う。
 */
export function hashModifiers(m: PlayerModifiers): number {
  let h = 0x811c9dc5;
  const arrays: readonly (Int32Array | Uint8Array)[] = [
    m.unitAdd,
    m.unitMul,
    m.shipMul,
    m.rangedResist,
    m.lowHpMaxAtkMul,
    m.lowHpAtRatio,
    m.gatherMul,
    m.depositMul,
    m.researchCostMulAt,
    m.researchTimeMulAt,
    m.produceSpeedMul,
    m.queueLengthAdd,
    m.buildCostMulAt,
    m.unitCostMul,
    m.startResourceAdd,
    m.unlockedUnits,
    m.buildingLimit,
  ];
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) h = mix(h, a[i]!);
  }
  const scalars: readonly number[] = [
    m.frontSlotAdd,
    m.orderDelayMul,
    m.orderDelayDistanceZero ? 1 : 0,
    m.orderSwitchIntervalMul,
    m.orderStackSlots,
    m.farmYieldMul,
    m.buildingSightAdd,
    m.researchCostMul,
    m.researchTimeMul,
    m.healSpeedMul,
    m.eliteCostMul,
    m.tradeIncomeMul,
    m.cartSpeedMul,
    m.buildSpeedMul,
    m.buildCostMul,
  ];
  for (const s of scalars) h = mix(h, s);
  return h;
}

/** その文明で研究できるかを問わず、効果として使われている型の一覧（検証用）。 */
export function effectTypesInData(): readonly string[] {
  const seen: string[] = [];
  const push = (t: unknown): void => {
    if (typeof t === 'string' && !seen.includes(t)) seen.push(t);
  };
  for (const t of TECH_DEFS) for (const e of t.effects) push(e['type']);
  for (const b of BUILDING_DEFS) {
    for (const e of b.effects) push(e['type']);
    for (const e of destroyEffectsOf(b.index)) push(e['type']);
  }
  for (const c of ['yamato', 'roma', 'tou', 'viking', 'mali', 'azteca', 'persia', 'mongol']) {
    for (const e of civDefById(c as CivId).econBonus) push(e['type']);
  }
  return seen;
}
