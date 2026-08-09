/**
 * システム 11/14: production — 生産キュー・研究・時代進化（実装手順書 §4.6, §5.1, §6）
 *
 * 担当マイルストーン: **M6**（T-M6-01 / 03 / 05 / 06 / 07）。
 *
 * 責務:
 *  - 各生産建物のキューを進め、完成したユニットを集合地点へ向かわせる（T-M6-01 / 06）。
 *  - 研究の進行と完了（`PlayerState.researched` を立てて修飾子を作り直す）。
 *  - 時代進化の進行と完了（`age` を +1 し、戦域スロットを再計算する。T-M6-03）。
 *    スロット数 = 時代の `slots` + 建物の `frontSlotBonus` の合計 + 効果 `frontSlot` の加算。
 *    上限は `config.slotBonus.hardMax`（6）。
 *  - 文明の禁止・置換・兵種ツリー（T-M6-05）とエリートの生産元（T-M6-07）の判定。
 *
 * 効果（研究・文明・建物）はすべて `core/effects.ts` 経由で読む。
 * **このファイルに研究名・文明名・建物名の分岐は無い**（実装手順書 §5.6）。
 *
 * 進捗の持ち方は `systems/construction.ts` の冒頭コメントを参照
 * （仕事量を Fx で積み上げ、必要量は `fx(必要 tick 数)` で表す）。
 *
 * 決定論: 反復は必ず index 昇順。生産・研究に乱数を使わない。
 *
 * **申し送り**: `pop` / `popCap` の集計は M4（population）の担当。ここでは
 * 「上限に当たったらキューを止める」ための現在値の参照と、生産したぶんの
 * `pop` 加算だけを行う。
 */

import buildingsJson from '@/data/buildings.json' with { type: 'json' };

import type { EntityId, PlayerId, ResourceId } from '@/shared/types';
import { EntityKind, RESOURCE_COUNT, RESOURCE_IDS } from '@/shared/types';
import type { Fx } from '../core/fx';
import { fx, fxFromInt, fxMul } from '../core/fx';
import type { BuildingDef, TechDef, UnitDef } from '../core/defs';
import {
  buildingDef,
  canCivResearch,
  civDefById,
  civUnitsAtAge,
  techDef,
  techDefById,
  techIndex,
  unitDef,
  unitDefById,
} from '../core/defs';
import {
  MAX_PRODUCTION_QUEUE,
  RESEARCH_AGE_ADVANCE,
  UnitState,
  idOfIndex,
  resolveIndex,
  spawnEntity,
} from '../core/entity';
import type { World } from '../core/world';
import { MAX_FRONTS } from '../core/world';
import { cfgAges, cfgInt } from '../core/config';
import {
  PROGRESS_DONE,
  applyUnitStat,
  auraTrainMul,
  frontSlotBonus,
  getPlayerModifiers,
  isBuildingComplete,
  isUnitUnlocked,
  markModifiersDirty,
  produceSpeedMul,
  queueLength,
  refreshModifiers,
  researchCostMul,
  researchTimeMul,
  startResourceAdd,
  unitCostMul,
  unitRequiresUnlock,
} from '../core/effects';
import { canAfford } from './construction';

/** 戦域スロットの合計上限（`config.json:slotBonus.hardMax`）。 */
const SLOT_HARD_MAX = Math.min(cfgInt('slotBonus.hardMax'), MAX_FRONTS);

/** 1 tick ぶんの仕事量（1.0 倍速 = FX_ONE）。 */
const WORK_PER_TICK: Fx = fx(1);

/**
 * 時代進化（解読）を行える建物の ID 集合。
 * `buildings.json` の `canAdvanceAge` から作る（`defs.ts` がこのフラグを公開していないため
 * JSON を直接読む。**建物名でコードを分岐させない**ための措置）。
 */
const CAN_ADVANCE_AGE: ReadonlySet<string> = (() => {
  const src = buildingsJson as unknown as Record<string, Record<string, unknown>>;
  const out = new Set<string>();
  for (const id of Object.keys(src)) {
    if (id.startsWith('_')) continue;
    if (src[id]?.['canAdvanceAge'] === true) out.add(id);
  }
  return out;
})();

// ---------------------------------------------------------------- 生産可否

/**
 * その建物がそのユニットの生産元か。
 * 文明置換（`replaces`）を解決するので、エリートは **城／大天幕からのみ**になる
 * （`units.json` の `producedAt` が castle / great_tent だから。T-M6-07）。
 */
export function isProductionSource(bdef: BuildingDef, udef: UnitDef): boolean {
  return udef.producedAt === bdef.id || udef.producedAt === bdef.replaces;
}

/** その文明の兵種ツリーに載っているユニットか（段が入れ替わる系統に属するか）。 */
function isTreeUnit(civ: string, id: string): boolean {
  const tree = civDefById(civ).unitTree;
  for (const line of Object.keys(tree)) {
    const arr = tree[line];
    if (arr === undefined) continue;
    for (const v of arr) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        if (v.includes(id)) return true;
      } else if (v === id) return true;
    }
  }
  return false;
}

/**
 * そのプレイヤーが今そのユニットを生産できるか（文明・時代・兵種ツリー・解禁）。
 * 兵種ツリーに載る系統は **現在の世の段だけ**が生産対象（時代進化で入れ替わる）。
 */
export function isUnitAvailable(w: World, p: PlayerId, udef: UnitDef): boolean {
  const pl = w.players[p];
  if (pl === undefined) return false;
  if (udef.civ !== null && udef.civ !== pl.civ) return false;
  if (udef.age > pl.age) return false;
  if (unitRequiresUnlock(udef) && !isUnitUnlocked(getPlayerModifiers(w, p), udef)) return false;
  if (isTreeUnit(pl.civ, udef.id)) return civUnitsAtAge(pl.civ, pl.age).includes(udef.id);
  return true;
}

/** ユニット 1 体の実効生産コスト（Fx、資源 index 順）。 */
export function unitCostFx(w: World, p: PlayerId, udef: UnitDef): Int32Array {
  const mul = unitCostMul(getPlayerModifiers(w, p), udef);
  const out = new Int32Array(RESOURCE_COUNT);
  for (let r = 0; r < RESOURCE_COUNT; r++) out[r] = fxMul(udef.cost[r]!, mul);
  return out;
}

/** 研究 1 件の実効コスト（Fx、資源 index 順）。 */
export function techCostFx(
  w: World,
  p: PlayerId,
  tdef: TechDef,
  atBuildingId?: string
): Int32Array {
  const mul = researchCostMul(getPlayerModifiers(w, p), atBuildingId);
  const out = new Int32Array(RESOURCE_COUNT);
  for (let r = 0; r < RESOURCE_COUNT; r++) out[r] = fxMul(tdef.cost[r]!, mul);
  return out;
}

/**
 * 時代進化のコスト（Fx、資源 index 順）。`ageIdx` = **進化先**の時代。
 * `03§2` の 食500 / 食800+金200 / 食1000+金800 がそのまま出る
 * （研究コスト倍率は掛けない。時代進化は techs.json の研究ではない）。
 */
export function ageAdvanceCostFx(ageIdx: number): Int32Array {
  const out = new Int32Array(RESOURCE_COUNT);
  const a = cfgAges()[ageIdx];
  if (a === undefined) return out;
  for (const [k, v] of Object.entries(a.cost)) {
    const r = RESOURCE_IDS.indexOf(k as ResourceId);
    if (r < 0) throw new Error(`config.json: ages[${ageIdx}].cost に未知の資源 "${k}"`);
    out[r] = fx(v);
  }
  return out;
}

// ---------------------------------------------------------------- コマンドの入口

/**
 * 生産キューに積む（`produce` コマンドの本体。T-M6-01）。
 * 資源は積んだ時点で即引き落とす。人口上限は進行の停止で表現する（キューには積める）。
 *
 * **申し送り**: `sim/command.ts` は担当外のため、`case 'produce'` から
 * この関数を呼ぶ配線は command.ts 側で行うこと。
 *
 * @returns 実際に積めた件数（0 = 却下）
 */
export function queueUnitProduction(
  w: World,
  p: PlayerId,
  building: EntityId,
  unitId: string,
  count: number
): number {
  const e = w.entities;
  const pl = w.players[p];
  if (pl === undefined) return 0;
  const b = resolveIndex(e, building);
  if (b < 0 || e.kind[b] !== EntityKind.Building || e.owner[b] !== p) return 0;
  if (!isBuildingComplete(w, b)) return 0;

  const bdef = buildingDef(e.typeId[b]!);
  const udef = unitDefById(unitId);
  if (!isProductionSource(bdef, udef)) return 0;
  if (!isUnitAvailable(w, p, udef)) return 0;

  const limit = queueLength(getPlayerModifiers(w, p), bdef.id);
  let queued = 0;
  for (let k = 0; k < count; k++) {
    if (e.queueCount[b]! >= limit) break;
    const cost = unitCostFx(w, p, udef);
    if (!canAfford(pl.resources, cost)) break;
    for (let r = 0; r < RESOURCE_COUNT; r++) pl.resources[r] = pl.resources[r]! - cost[r]!;
    e.queueUnit[b * MAX_PRODUCTION_QUEUE + e.queueCount[b]!] = udef.index + 1;
    e.queueCount[b] = e.queueCount[b]! + 1;
    queued++;
  }
  return queued;
}

/**
 * キューを取り消して**全額返却**する（右クリック。T-M6-01）。
 * 先頭（生産中）を取り消したときは進捗も捨てる。
 */
export function cancelQueueItem(w: World, p: PlayerId, building: EntityId, index: number): boolean {
  const e = w.entities;
  const pl = w.players[p];
  if (pl === undefined) return false;
  const b = resolveIndex(e, building);
  if (b < 0 || e.owner[b] !== p) return false;
  const n = e.queueCount[b]!;
  if (!Number.isInteger(index) || index < 0 || index >= n) return false;

  const q = b * MAX_PRODUCTION_QUEUE;
  const typeId = e.queueUnit[q + index]! - 1;
  if (typeId >= 0) {
    const cost = unitCostFx(w, p, unitDef(typeId));
    for (let r = 0; r < RESOURCE_COUNT; r++) pl.resources[r] = pl.resources[r]! + cost[r]!;
  }
  for (let k = index; k < n - 1; k++) e.queueUnit[q + k] = e.queueUnit[q + k + 1]!;
  e.queueUnit[q + n - 1] = 0;
  e.queueCount[b] = n - 1;
  if (index === 0) e.prodProgress[b] = 0;
  return true;
}

/** その建物でその研究に着手できるか（文明制限・時代・前提研究・資源）。 */
export function canStartResearch(
  w: World,
  p: PlayerId,
  buildingIdx: number,
  techId: string
): boolean {
  const e = w.entities;
  const pl = w.players[p];
  if (pl === undefined) return false;
  if (e.owner[buildingIdx] !== p) return false;
  if (!isBuildingComplete(w, buildingIdx)) return false;
  if (e.researchTech[buildingIdx] !== 0) return false;

  const bdef = buildingDef(e.typeId[buildingIdx]!);
  const tdef = techDefById(techId);
  // 研究できる建物は techs.json の `at`（文明置換は `replaces` で解決する）。
  if (tdef.at !== bdef.id && tdef.at !== bdef.replaces) return false;
  if (!canCivResearch(pl.civ, techId)) return false;
  if (tdef.age > pl.age) return false;
  if (pl.researched[tdef.index] === 1) return false;
  for (const req of tdef.requires) {
    if (pl.researched[techIndex(req)] !== 1) return false;
  }
  return canAfford(pl.resources, techCostFx(w, p, tdef, bdef.id));
}

/** 研究に着手する（`research` コマンドの本体）。 */
export function startResearch(w: World, p: PlayerId, building: EntityId, techId: string): boolean {
  const e = w.entities;
  const pl = w.players[p];
  if (pl === undefined) return false;
  const b = resolveIndex(e, building);
  if (b < 0) return false;
  if (!canStartResearch(w, p, b, techId)) return false;

  const bdef = buildingDef(e.typeId[b]!);
  const tdef = techDefById(techId);
  const cost = techCostFx(w, p, tdef, bdef.id);
  for (let r = 0; r < RESOURCE_COUNT; r++) pl.resources[r] = pl.resources[r]! - cost[r]!;
  e.researchTech[b] = tdef.index + 1;
  e.researchProgress[b] = 0;
  return true;
}

/** 完成済みで所有している「今の世の建物」の種類数（時代進化の建物条件）。 */
export function countCurrentAgeBuildingKinds(w: World, p: PlayerId): number {
  const pl = w.players[p];
  if (pl === undefined) return 0;
  const e = w.entities;
  let kinds = 0;
  const seen = new Uint8Array(1 + maxBuildingIndex());
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    if (!isBuildingComplete(w, i)) continue;
    const def = buildingDef(e.typeId[i]!);
    if (def.age !== pl.age) continue;
    if (seen[def.index] === 1) continue;
    seen[def.index] = 1;
    kinds++;
  }
  return kinds;
}

/** 時代進化に着手できるか（資源 + 前の世の建物 2 種）。 */
export function canAdvanceAge(w: World, p: PlayerId, buildingIdx: number): boolean {
  const e = w.entities;
  const pl = w.players[p];
  if (pl === undefined) return false;
  if (e.owner[buildingIdx] !== p) return false;
  if (!isBuildingComplete(w, buildingIdx)) return false;
  if (e.researchTech[buildingIdx] !== 0) return false;
  if (!CAN_ADVANCE_AGE.has(buildingDef(e.typeId[buildingIdx]!).id)) return false;

  const a = cfgAges()[pl.age + 1];
  if (a === undefined) return false;
  if (countCurrentAgeBuildingKinds(w, p) < a.requireBuildingsOfPrevAge) return false;
  return canAfford(pl.resources, ageAdvanceCostFx(pl.age + 1));
}

/**
 * 時代進化（解読）を始める（`advanceAge` コマンドの本体。T-M6-03）。
 * **解読中も内政と戦闘は止まらない**（進捗を進めるだけで他を止めない）。
 */
export function startAgeAdvance(w: World, p: PlayerId, building: EntityId): boolean {
  const e = w.entities;
  const pl = w.players[p];
  if (pl === undefined) return false;
  const b = resolveIndex(e, building);
  if (b < 0 || !canAdvanceAge(w, p, b)) return false;

  const cost = ageAdvanceCostFx(pl.age + 1);
  for (let r = 0; r < RESOURCE_COUNT; r++) pl.resources[r] = pl.resources[r]! - cost[r]!;
  e.researchTech[b] = RESEARCH_AGE_ADVANCE;
  e.researchProgress[b] = 0;
  return true;
}

/** 集合地点を設定する（`setRally` コマンドの本体。T-M6-06）。 */
export function setRallyPoint(w: World, p: PlayerId, building: EntityId, x: Fx, y: Fx): boolean {
  const e = w.entities;
  const b = resolveIndex(e, building);
  if (b < 0 || e.kind[b] !== EntityKind.Building || e.owner[b] !== p) return false;
  e.rallyX[b] = x;
  e.rallyY[b] = y;
  return true;
}

/**
 * 開始資源に文明ボーナス（`startResourceAdd`）を足す。
 * 試合開始時に 1 回だけ呼ぶ（M3 の初期配置 / シナリオから）。
 */
export function applyStartResourceBonus(w: World, p: PlayerId): void {
  const pl = w.players[p];
  if (pl === undefined) return;
  const m = getPlayerModifiers(w, p);
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    pl.resources[r] = pl.resources[r]! + startResourceAdd(m, RESOURCE_IDS[r]!);
  }
}

// ---------------------------------------------------------------- 戦域スロット

/**
 * 戦域スロット数を作り直す（T-M6-03 / T-M8-01）。
 *
 * スロット = 時代の `slots` + 完成済み建物の `frontSlotBonus` の合計 + 効果 `frontSlot`。
 * 上限は `config.slotBonus.hardMax`（6）。
 * 城もモンゴルの大天幕も `frontSlotBonus: 1` を持つデータなので、
 * ここに建物名は出てこない。研究「旗竿」も効果型 `frontSlot` として入る。
 */
export function recomputeFrontSlots(w: World, p: PlayerId): void {
  const pl = w.players[p];
  if (pl === undefined) return;
  const age = cfgAges()[pl.age];
  let slots = age === undefined ? 1 : age.slots;

  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    if (!isBuildingComplete(w, i)) continue;
    slots += buildingDef(e.typeId[i]!).frontSlotBonus;
  }
  slots += frontSlotBonus(getPlayerModifiers(w, p));

  if (slots > SLOT_HARD_MAX) slots = SLOT_HARD_MAX;
  if (slots < 1) slots = 1;
  pl.frontSlots = slots;
}

// ---------------------------------------------------------------- システム本体

/** 1 tick ぶんの生産・研究・時代進化を進める。 */
export function production(w: World): void {
  refreshModifiers(w);
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i]! >= w.playerCount) continue;
    if (!isBuildingComplete(w, i)) continue;
    advanceQueue(w, i);
    advanceResearch(w, i);
  }
}

/** 生産キューの先頭を進める。 */
function advanceQueue(w: World, i: number): void {
  const e = w.entities;
  if (e.queueCount[i]! <= 0) {
    e.prodProgress[i] = 0;
    return;
  }
  const p = e.owner[i]!;
  const pl = w.players[p];
  if (pl === undefined) return;
  const typeId = e.queueUnit[i * MAX_PRODUCTION_QUEUE]! - 1;
  if (typeId < 0) return;
  const udef = unitDef(typeId);

  // 人口上限に当たったら進行を止める（キューは消えない）。
  if (pl.pop + udef.pop > pl.popCap) return;

  const bdef = buildingDef(e.typeId[i]!);
  const m = getPlayerModifiers(w, p);
  const military = udef.role !== 'villager';
  const speed = fxMul(
    produceSpeedMul(m, udef, bdef.id),
    auraTrainMul(w, p, e.x[i]!, e.y[i]!, military)
  );
  if (speed <= 0) return;

  const required = fxFromInt(udef.buildTicks);
  const work = e.prodProgress[i]! + speed;
  if (required > 0 && work < required) {
    e.prodProgress[i] = work;
    return;
  }
  // 完成。余った仕事量は次の 1 体へ繰り越す（端数で実効速度が落ちないように）。
  spawnProducedUnit(w, i, udef);
  shiftQueue(e.queueUnit, e.queueCount, i);
  e.prodProgress[i] = e.queueCount[i]! > 0 ? work - required : 0;
}

/** キューを 1 つ前へ詰める。 */
function shiftQueue(queue: Int16Array, counts: Uint8Array, i: number): void {
  const q = i * MAX_PRODUCTION_QUEUE;
  const n = counts[i]!;
  for (let k = 0; k < n - 1; k++) queue[q + k] = queue[q + k + 1]!;
  queue[q + n - 1] = 0;
  counts[i] = n - 1;
}

/**
 * 完成したユニットを出す。集合地点が設定されていればそこへ向かわせる（T-M6-06）。
 * 移動そのものは M3 の `movement` が `destX/destY` を見て行う。
 */
function spawnProducedUnit(w: World, bIdx: number, udef: UnitDef): void {
  const e = w.entities;
  const p = e.owner[bIdx]!;
  const pl = w.players[p];
  const bx = e.x[bIdx]!;
  const by = e.y[bIdx]!;
  const hpMax =
    pl === undefined ? udef.hp : applyUnitStat(getPlayerModifiers(w, p), udef, 'hp', udef.hp);

  const id = spawnEntity(e, {
    kind: EntityKind.Unit,
    owner: p,
    typeId: udef.index,
    x: bx,
    y: by,
    hpMax,
  });
  const u = resolveIndex(e, id);
  const rx = e.rallyX[bIdx]!;
  const ry = e.rallyY[bIdx]!;
  const hasRally = rx !== 0 || ry !== 0;
  e.destX[u] = hasRally ? rx : bx;
  e.destY[u] = hasRally ? ry : by;
  e.state[u] = hasRally ? UnitState.Moving : UnitState.Idle;
  e.stateTick[u] = w.tick;
  e.homeId[u] = idOfIndex(e, bIdx);
  if (pl !== undefined) pl.pop += udef.pop;
}

/** 研究・時代進化の進行。 */
function advanceResearch(w: World, i: number): void {
  const e = w.entities;
  const rt = e.researchTech[i]!;
  if (rt === 0) return;
  const p = e.owner[i]!;
  const pl = w.players[p];
  if (pl === undefined) return;
  const bdef = buildingDef(e.typeId[i]!);
  const timeMul = researchTimeMul(getPlayerModifiers(w, p), bdef.id);

  const baseTicks =
    rt === RESEARCH_AGE_ADVANCE ? ageResearchTicks(pl.age + 1) : techDef(rt - 1).researchTicks;
  const required = fxMul(fxFromInt(baseTicks), timeMul);
  const work = e.researchProgress[i]! + WORK_PER_TICK;
  if (required > 0 && work < required) {
    e.researchProgress[i] = work;
    return;
  }
  e.researchProgress[i] = 0;
  e.researchTech[i] = 0;

  if (rt === RESEARCH_AGE_ADVANCE) {
    if (pl.age + 1 < cfgAges().length) pl.age += 1;
  } else {
    pl.researched[rt - 1] = 1;
  }
  markModifiersDirty(w, p);
  recomputeFrontSlots(w, p);
}

/** 進化先の時代の解読 tick 数。 */
function ageResearchTicks(ageIdx: number): number {
  const a = cfgAges()[ageIdx];
  return a === undefined ? 0 : a.researchTicks;
}

/** 建物 index の最大値（`countCurrentAgeBuildingKinds` の作業配列用）。 */
let maxBuildingIndexCache = -1;
function maxBuildingIndex(): number {
  if (maxBuildingIndexCache < 0) {
    const src = buildingsJson as unknown as Record<string, unknown>;
    maxBuildingIndexCache = Object.keys(src).filter((k) => !k.startsWith('_')).length;
  }
  return maxBuildingIndexCache;
}

/** 生産キューの現在の上限（UI 用）。 */
export function productionQueueLimit(w: World, p: PlayerId, buildingId: string): number {
  return Math.min(queueLength(getPlayerModifiers(w, p), buildingId), MAX_PRODUCTION_QUEUE);
}

export { PROGRESS_DONE };
