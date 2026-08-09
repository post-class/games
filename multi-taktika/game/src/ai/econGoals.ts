/**
 * ai/econGoals.ts — 内政の AI（T-M13-02。実装手順書 §10）
 *
 * 担当:
 *  1. 村人を出し続ける（人口枠がある限り）
 *  2. 家を建て増す（**人口上限に当たる前に**）
 *  3. 資源の偏りを見て手を打つ（伐採所・採掘場・農地・市場での交換）
 *  4. 研究と時代進化（`allowAdvanceAge`）
 *
 * ズルをしない前提（`07§11`）: 読めるのは `AiView` だけ。
 * 自分の資源・人口・時代は見えるが、**敵の資源・時代は渡ってこない**。
 *
 * 数値は `config.json` からのみ引く（§0.5）。このファイルに balance 数値は書かない。
 *
 * **申し送り（`AiView` の穴）**:
 *  - `AiView` に**資源ノード（中立エンティティ）が入っていない**ため、
 *    AI は `gather` コマンドの対象を名指しできない。したがって
 *    「新しい村人を最寄りの森に就かせる」ができず、生産された村人は
 *    **建設係**として使っている（家・伐採所・農地を建てる → 建物経由で内政を伸ばす）。
 *    恒久対策は `AiView` に `seenResourceNodes`（視界内の中立資源ノード）を足すこと。
 *  - 同じ理由で「村人配分の組み替え」も直接はできないので、
 *    偏りへの対処は **建物（伐採所・採掘場・農地）と市場の交換**で表している。
 */

import type { EntityId } from '@/shared/types';
import { EntityKind, RESOURCE_IDS } from '@/shared/types';
import type { Command } from '@/sim/command';
import { cfgInt } from '@/sim/core/config';
import {
  buildingDef,
  buildingDefById,
  canCivBuild,
  canCivResearch,
  resolveBuildingForCiv,
  techDefById,
  unitDefById,
} from '@/sim/core/defs';
import type { Fx } from '@/sim/core/fx';
import { FX_HALF, FX_ONE, fxToInt, idiv } from '@/sim/core/fx';
import { Move, hasTerrain, isPassableFor } from '@/sim/core/terrain';
import { AGE_IDS } from '@/shared/types';

import type { AiContext } from './AiPlayer';
import { VILLAGER_BUILDER, VILLAGER_GATHERER, memGet, memSet } from './AiPlayer';
import type { OwnEntity } from './view';

// ---------------------------------------------------------------- データ由来の定数

/** 家 1 棟が増やす人口（`population.housePop`）。この余裕を切ったら建て増す。 */
const HOUSE_POP = cfgInt('population.housePop');

/** 人口上限の上限値（`population.defaultCap`）。ここまで来たら家は要らない。 */
const POP_CAP_MAX = cfgInt('population.defaultCap');

/** 「自軍の建物の内側」と見なす距離（`morale.insideOwnWallsRadiusTiles`）。町を広げる範囲に使う。 */
const TOWN_RADIUS_TILES = cfgInt('morale.insideOwnWallsRadiusTiles');

/** 市場での交換の刻み（`economy.carryCapacity` = 村人 1 往復ぶん）。 */
const TRADE_UNIT = cfgInt('economy.carryCapacity');

/** 「金が余っている」と見なす単位数（`economy.marketPriceUnitStep` = 相場が動く刻み）。 */
const GOLD_SURPLUS_UNITS = cfgInt('economy.marketPriceUnitStep');

/** 町の中心の建物 ID（文明置換は `resolveBuildingForCiv` が解く）。 */
const TOWN_CENTER_ID = 'town_center';

/** 村人のユニット ID。 */
const VILLAGER_ID = 'villager';

/**
 * 内政の建物を建てる優先順（**ID の並びであって数値ではない**）。
 * 家が最優先なのは「人口で詰まると何も出せなくなる」ため。
 * 伐採所・採掘場・農地・市場は時代進化の条件（前の世の建物 2 種）も兼ねる。
 */
const ECON_BUILD_ORDER: readonly string[] = [
  'house',
  'lumber_camp',
  'mining_camp',
  'farm',
  'market',
];

const FOOD = RESOURCE_IDS.indexOf('food');
const WOOD = RESOURCE_IDS.indexOf('wood');
const STONE = RESOURCE_IDS.indexOf('stone');
const GOLD = RESOURCE_IDS.indexOf('gold');

// ---------------------------------------------------------------- 公開: 内政の判断

/** この判断 tick に出す内政の `Command`。 */
export function planEconomy(ctx: AiContext): Command[] {
  const cmds: Command[] = [];
  classifyVillagers(ctx);

  // 1) 村人を出し続ける（人口枠がある限り。`07§2`「0〜5 分は村人だけを増やす時間」）。
  pushVillagerProduction(ctx, cmds);

  // 2) 建物（家 → 資源施設 → 市場）。1 回の判断で 1 棟だけ着工する
  //    （同じ tick に何棟も着工すると資源を使い切って村人が止まる）。
  const build = planEconBuilding(ctx);
  if (build !== null) cmds.push(build);

  // 3) 研究（自軍の建物が持つ研究のうち、まだ取っていない最初のもの）。
  const research = planResearch(ctx);
  if (research !== null) cmds.push(research);

  // 4) 時代進化（段階 3 以上。`ai.json` の allowAdvanceAge）。
  const advance = planAgeAdvance(ctx);
  if (advance !== null) cmds.push(advance);

  // 5) 資源の偏り: 金が余っていて足りない資源があるなら市場で交換する（`07§8`）。
  const trade = planMarketTrade(ctx);
  if (trade !== null) cmds.push(trade);

  return cmds;
}

// ---------------------------------------------------------------- 村人

/**
 * 村人を「採集係」「建設係」に分類する。
 *
 * `AiView` には「手空きか」が入っていないので、**初めて見た tick** で決める:
 *  - 最初の判断（tick 0 近く）で既に居る村人 → `setup` が資源に就かせている = 採集係
 *  - 後から現れた村人 → 生産されたばかりで手空き = 建設係
 * index が再利用されて別人になったら `EntityId` が変わるので再分類する。
 */
function classifyVillagers(ctx: AiContext): void {
  const m = ctx.memory;
  const villagerType = unitDefById(VILLAGER_ID).index;
  const firstLook = m.villagerKnownId.length === 0;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Unit || oe.typeId !== villagerType) continue;
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    if (memGet(m.villagerKnownId, oe.index) === id) continue;
    memSet(m.villagerKnownId, oe.index, id);
    memSet(m.villagerRole, oe.index, firstLook ? VILLAGER_GATHERER : VILLAGER_BUILDER);
    memSet(m.villagerBusyUntil, oe.index, 0);
  }
}

/** 村人を 1 体ずつ町の中心に積む（人口枠と手持ち資源が足りているときだけ）。 */
function pushVillagerProduction(ctx: AiContext, out: Command[]): void {
  const own = ctx.view.own;
  if (own.pop >= own.popCap) return; // 上限に当たっている（`07§8`「生産ボタンが止まります」）
  const udef = unitDefById(VILLAGER_ID);
  if (!canAfford(own.resources, udef.cost)) return;
  const tc = findTownCenter(ctx);
  if (tc === null) return;
  out.push({
    t: 'produce',
    p: ctx.playerId,
    building: ctx.idOf(tc.index),
    unit: udef.id,
    count: 1,
  });
}

// ---------------------------------------------------------------- 建物

/** 家が要るか（**人口上限に当たる前に**建てる）。 */
function needsHouse(ctx: AiContext): boolean {
  const own = ctx.view.own;
  if (own.popCap >= POP_CAP_MAX) return false;
  return own.popCap - own.pop <= HOUSE_POP;
}

/**
 * 次に建てる内政建物を決める。
 *  - 人口の余裕が家 1 棟ぶんを切ったら家（最優先）
 *  - まだ持っていない資源施設のうち、**いちばん足りない資源**に効くもの
 *  - 建設係の村人が空いていなければ何もしない
 */
export function planEconBuilding(ctx: AiContext): Command | null {
  const wish = pickEconBuilding(ctx);
  if (wish === null) return null;
  return placeBuildingCommand(ctx, wish);
}

function pickEconBuilding(ctx: AiContext): string | null {
  const civ = ctx.view.own.civ;
  if (needsHouse(ctx)) {
    const house = resolveBuildingForCiv(civ, 'house');
    if (house !== null && canCivBuild(civ, house)) return house;
  }
  const scarce = scarcestResource(ctx.view.own.resources);
  for (let k = 0; k < ECON_BUILD_ORDER.length; k++) {
    const id = ECON_BUILD_ORDER[k]!;
    if (id === 'house') continue; // 家は上で見た
    const resolved = resolveBuildingForCiv(civ, id);
    if (resolved === null || !canCivBuild(civ, resolved)) continue;
    const bdef = buildingDefById(resolved);
    if (bdef.age > ctx.view.own.age) continue;
    // 棟数上限のある建物（市場）は 1 棟持っていたら要らない。
    const have = countOwnBuildings(ctx, bdef.index);
    if (bdef.maxCount > 0 && have >= bdef.maxCount) continue;
    // 資源施設は 1 棟ずつでよい。農地だけは「足りない資源が食料のとき」何面でも建てる。
    if (have > 0 && !(id === 'farm' && scarce === FOOD)) continue;
    return resolved;
  }
  return null;
}

/** いちばん足りない資源の添字（同値は添字の小さい方 = RESOURCE_IDS 順で固定）。 */
export function scarcestResource(resources: readonly number[]): number {
  let best = 0;
  for (let r = 1; r < resources.length; r++) {
    if (resources[r]! < resources[best]!) best = r;
  }
  return best;
}

/**
 * 建物 1 棟の着工コマンドを作る（村人 1 名を付ける）。
 * 置ける場所か資源が無ければ `null`。**村人を付けないと永久に完成しない**ので、
 * 建設係が空いていないときは着工しない。
 */
export function placeBuildingCommand(ctx: AiContext, buildingId: string): Command | null {
  const bdef = buildingDefById(buildingId);
  if (!canAfford(ctx.view.own.resources, bdef.cost)) return null;
  const builder = takeBuilder(ctx, bdef.buildTicks);
  if (builder < 0) return null;
  const site = pickBuildSite(ctx, bdef.sizeW, bdef.sizeH);
  if (site === null) return null;
  ctx.memory.buildTick = ctx.view.tick;
  return {
    t: 'placeBuilding',
    p: ctx.playerId,
    type: buildingId,
    x: site.x,
    y: site.y,
    villagers: [builder],
  };
}

/**
 * 建設係の村人を 1 名借りる（**採集係には手を付けない**）。
 * 借りた村人はその建物の `buildTicks` ぶん塞がっている扱いにする。
 * 空いていなければ -1。
 */
function takeBuilder(ctx: AiContext, buildTicks: number): EntityId {
  const m = ctx.memory;
  const tick = ctx.view.tick;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Unit) continue;
    if (memGet(m.villagerRole, oe.index) !== VILLAGER_BUILDER) continue;
    if (memGet(m.villagerBusyUntil, oe.index) > tick) continue;
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    memSet(m.villagerBusyUntil, oe.index, tick + buildTicks);
    return id;
  }
  return -1 as EntityId;
}

/** 自軍の建物の棟数（typeId 指定。建設中も数える）。 */
export function countOwnBuildings(ctx: AiContext, typeId: number): number {
  let n = 0;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind === EntityKind.Building && oe.typeId === typeId) n++;
  }
  return n;
}

/** 自軍の完成した町の中心（index 昇順の最初の 1 棟）。 */
export function findTownCenter(ctx: AiContext): OwnEntity | null {
  const id = resolveBuildingForCiv(ctx.view.own.civ, TOWN_CENTER_ID);
  if (id === null) return null;
  const typeId = buildingDefById(id).index;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind === EntityKind.Building && oe.typeId === typeId && oe.complete) return oe;
  }
  return null;
}

/**
 * 建設地を選ぶ。
 *
 * 町の中心のまわり（`morale.insideOwnWallsRadiusTiles` の範囲）を
 * **Chebyshev 距離昇順に固定した候補表**で走査し、
 *  - マップ内で、足跡のマスすべてが陸で通行可能
 *  - 既にある自軍の建物の足跡と重ならない
 * を満たす最初のマスを返す。走査の開始位置だけ `rngAi` でずらす
 * （毎回同じ場所を試して失敗し続けるのを避けるため。乱数は AI 専用ストリーム）。
 */
export function pickBuildSite(ctx: AiContext, sizeW: number, sizeH: number): { x: Fx; y: Fx } | null {
  const tc = findTownCenter(ctx);
  if (tc === null) return null;
  const map = ctx.view.map;
  const baseTx = idiv(tc.x, FX_ONE);
  const baseTy = idiv(tc.y, FX_ONE);
  const offsets = buildSiteOffsets();
  const start = ctx.rng.nextInt(offsets.length);
  for (let k = 0; k < offsets.length; k++) {
    const o = offsets[(start + k) % offsets.length]!;
    const tx = baseTx + o[0]!;
    const ty = baseTy + o[1]!;
    if (!footprintFree(ctx, tx, ty, sizeW, sizeH)) continue;
    if (overlapsOwnBuilding(ctx, tx, ty, sizeW, sizeH)) continue;
    return { x: tx * FX_ONE + FX_HALF, y: ty * FX_ONE + FX_HALF };
  }
  return null;
}

/** 足跡のマスがすべてマップ内・陸・通行可能か。 */
function footprintFree(ctx: AiContext, tx: number, ty: number, w: number, h: number): boolean {
  const map = ctx.view.map;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (x < 0 || y < 0 || x >= map.widthTiles || y >= map.heightTiles) return false;
      if (hasTerrain(map) && !isPassableFor(map, x, y, Move.Land)) return false;
    }
  }
  return true;
}

/** 既にある自軍の建物の足跡と重なるか（視界に入っている自軍の建物だけを見る）。 */
function overlapsOwnBuilding(
  ctx: AiContext,
  tx: number,
  ty: number,
  w: number,
  h: number
): boolean {
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Building) continue;
    const bdef = buildingDef(oe.typeId);
    const ox = idiv(oe.x, FX_ONE);
    const oy = idiv(oe.y, FX_ONE);
    if (tx < ox + bdef.sizeW && ox < tx + w && ty < oy + bdef.sizeH && oy < ty + h) return true;
  }
  return false;
}

/**
 * 建設候補のマス（町の中心からの相対座標）。
 * 距離 → dy → dx の昇順に固定した**レイアウト表**（バランス数値ではない）。
 * 生成は 1 回だけ。
 */
let SITE_OFFSETS: readonly (readonly [number, number])[] | null = null;

function buildSiteOffsets(): readonly (readonly [number, number])[] {
  if (SITE_OFFSETS !== null) return SITE_OFFSETS;
  // 町の中心の足跡（4×4）を避ける最小距離から、町の内側の範囲まで。
  const tcSize = buildingDefById(TOWN_CENTER_ID).sizeW;
  const min = tcSize;
  const max = tcSize + TOWN_RADIUS_TILES;
  const out: [number, number][] = [];
  for (let d = min; d <= max; d++) {
    for (let dy = -d; dy <= d; dy++) {
      for (let dx = -d; dx <= d; dx++) {
        const cheb = Math.max(dx < 0 ? -dx : dx, dy < 0 ? -dy : dy);
        if (cheb !== d) continue;
        out.push([dx, dy]);
      }
    }
  }
  SITE_OFFSETS = out;
  return out;
}

// ---------------------------------------------------------------- 研究・時代進化

/**
 * 研究を 1 件だけ選ぶ。自軍の建物が持つ `researches` を**建物の index 昇順・
 * 定義順**に見て、まだ取っておらず、文明が禁じておらず、時代が来ているものの最初。
 * 令の仕組みに関わる研究（旗竿・早馬・復唱・二重旗）も同じ経路で入る。
 */
export function planResearch(ctx: AiContext): Command | null {
  const own = ctx.view.own;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Building || !oe.complete) continue;
    const bdef = buildingDef(oe.typeId);
    for (let t = 0; t < bdef.researches.length; t++) {
      const techId = bdef.researches[t]!;
      const tdef = techDefById(techId);
      if (tdef.age > own.age) continue;
      if (!canCivResearch(own.civ, techId)) continue;
      if (own.researched[tdef.index] === true) continue;
      if (!hasPrereqs(ctx, tdef.requires)) continue;
      if (!canAfford(own.resources, tdef.cost)) continue;
      return { t: 'research', p: ctx.playerId, building: ctx.idOf(oe.index), tech: techId };
    }
  }
  return null;
}

function hasPrereqs(ctx: AiContext, requires: readonly string[]): boolean {
  for (let i = 0; i < requires.length; i++) {
    const tdef = techDefById(requires[i]!);
    if (ctx.view.own.researched[tdef.index] !== true) return false;
  }
  return true;
}

/**
 * 時代進化（`03§2`）。`allowAdvanceAge` の段階だけ。
 * 前提（前の世の建物 2 種・資源・研究中でない）の判定は `sim` 側が持っているので、
 * ここでは「最終時代でなければ町の中心に出す」だけ。通らなければ黙って捨てられる。
 */
export function planAgeAdvance(ctx: AiContext): Command | null {
  if (!ctx.cfg.allowAdvanceAge) return null;
  if (ctx.view.own.age >= AGE_IDS.length - 1) return null;
  const tc = findTownCenter(ctx);
  if (tc === null) return null;
  return { t: 'advanceAge', p: ctx.playerId, building: ctx.idOf(tc.index) };
}

// ---------------------------------------------------------------- 市場

/**
 * 資源の偏りへの対処（`07§8`）。
 * 金が `economy.marketPriceUnitStep` 単位以上あり、いちばん足りない資源が
 * それより少ないなら、金を売って足りない資源を `economy.carryCapacity` 単位買う。
 * 市場が無ければ `sim` 側が黙って捨てる。
 */
export function planMarketTrade(ctx: AiContext): Command | null {
  const res = ctx.view.own.resources;
  const goldUnits = fxToInt(res[GOLD]!);
  if (goldUnits < GOLD_SURPLUS_UNITS) return null;
  const scarce = scarcestResource(res);
  if (scarce === GOLD) return null;
  if (fxToInt(res[scarce]!) >= GOLD_SURPLUS_UNITS) return null;
  return {
    t: 'marketTrade',
    p: ctx.playerId,
    sell: RESOURCE_IDS[GOLD]!,
    buy: RESOURCE_IDS[scarce]!,
    amount: TRADE_UNIT,
  };
}

// ---------------------------------------------------------------- 補助

/** 手持ち（Fx）でコスト（Fx）を払えるか。修飾子は AI からは見えないので基礎コストで見積もる。 */
export function canAfford(have: readonly number[], cost: Int32Array | readonly number[]): boolean {
  for (let r = 0; r < have.length; r++) {
    const c = cost[r] ?? 0;
    if (have[r]! < c) return false;
  }
  return true;
}

/** 資源の添字（テストから参照する）。 */
export const RESOURCE_FOOD = FOOD;
export const RESOURCE_WOOD = WOOD;
export const RESOURCE_STONE = STONE;
export const RESOURCE_GOLD = GOLD;
