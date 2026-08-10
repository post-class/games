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

import type { CivId, EntityId } from '@/shared/types';
import { EntityKind, RESOURCE_IDS } from '@/shared/types';
import type { Command } from '@/sim/command';
import { cfgAges, cfgInt } from '@/sim/core/config';
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
import { FX_HALF, FX_ONE, fx, fxMul, fxToInt, idiv } from '@/sim/core/fx';
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

/** 家の建物 ID。 */
const HOUSE_ID = 'house';

/** コストに「家 1 棟ぶん」を足した必要額（Fx）。使い切り防止の予備。 */
function withHouseReserve(cost: Int32Array): Int32Array {
  const h = buildingDefById(HOUSE_ID).cost;
  const out = new Int32Array(cost.length);
  for (let r = 0; r < out.length; r++) out[r] = cost[r]! + h[r]!;
  return out;
}

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
const GOLD = RESOURCE_IDS.indexOf('gold');

// ---------------------------------------------------------------- 公開: 内政の判断

/**
 * 見えている資源ノードを記憶に足す（`AiMemory.nodeIds` ほか）。
 *
 * `AiView.seenResourceNodes` は**その瞬間に視界に入っているものだけ**なので、
 * 覚えないと「斥候が通り過ぎた金鉱」を二度と使えない。
 * 記憶は**発見順に足すだけ**（並べ替えない）ので、どの端末でも同じ順になる。
 *
 * 枯れたノードは、見えている状態で埋蔵量 0 になったときに落とす
 * （見えていないものは判断できないので残す。使おうとして失敗しても
 * `sim` 側が次のノードへ移してくれる ―― `economy.ts` の `seekSameResource`）。
 */
export function rememberNodes(ctx: AiContext): void {
  const m = ctx.memory;
  const seen = ctx.view.seenResourceNodes;
  for (let k = 0; k < seen.length; k++) {
    const n = seen[k]!;
    let at = -1;
    for (let i = 0; i < m.nodeIds.length; i++) {
      if (m.nodeIds[i] === n.id) {
        at = i;
        break;
      }
    }
    if (n.amount <= 0) {
      // 枯れた。記憶から抜く（末尾を詰めると発見順が壊れるので splice する）
      if (at >= 0) {
        m.nodeIds.splice(at, 1);
        m.nodeResource.splice(at, 1);
        m.nodeX.splice(at, 1);
        m.nodeY.splice(at, 1);
      }
      continue;
    }
    if (at >= 0) continue; // 既に覚えている
    m.nodeIds.push(n.id);
    m.nodeResource.push(n.resource);
    m.nodeX.push(n.x);
    m.nodeY.push(n.y);
  }
}

/** この判断 tick に出す内政の `Command`。 */
export function planEconomy(ctx: AiContext): Command[] {
  const cmds: Command[] = [];
  // 見えている資源ノードを覚える（**判断より先に**。今回の割り当てに使う）。
  rememberNodes(ctx);
  const fresh = classifyVillagers(ctx);

  // 1) 新しくできた村人を採集に就ける（**建てる前に採らせる**。
  //    資源が入らないと家も資源施設も建たないので、順序はこちらが先）。
  for (const c of gatherCommandsFor(ctx, fresh)) cmds.push(c);

  // 1b) 世が変わって必要な資源が変わったら、**既にいる村人を移す**。
  //     移せないと「村人を出し切ったあとに世が上がる」→ 新しく必要になった資源に
  //     誰も就かない、が起きる（実測: 青銅に上がっても金が 50 のまま動かず、
  //     鉄器の要求 200 に永久に届かなかった）。
  for (const c of reassignForNextAge(ctx)) cmds.push(c);

  // 2) 時代進化（段階 3 以上。`ai.json` の allowAdvanceAge）。
  //
  // **この判断のいちばん最初に出す。** 理由は 2 つあり、どちらも実測で踏んだ:
  //  - `Command` は並んだ順に同じ tick で実行される。村人の生産や着工を先に出すと
  //    そこで食料を使ってしまい、進化の費用が 1 体ぶん足りなくなって弾かれる
  //    （費用は貯まるのに age が 0 のままだった原因）。
  //  - 町の中心は「研究中は進化できない」（`canAdvanceAge` が `researchTech !== 0`
  //    を弾く）ので、研究より先に出さないと研究が居座る。
  //
  // 進化を出したこの判断では**他に資源を使わない**（次の判断から再開する）。
  const advance = planAgeAdvance(ctx);
  if (advance !== null) {
    cmds.push(advance);
    return cmds;
  }

  // 3) 村人を出し続ける（人口枠と目標数の範囲で。`07§2`「0〜5 分は村人だけを増やす時間」）。
  pushVillagerProduction(ctx, cmds);

  // 4) 建物（家 → 資源施設 → 市場）。1 回の判断で 1 棟だけ着工する
  //    （同じ tick に何棟も着工すると資源を使い切って村人が止まる）。
  const build = planEconBuilding(ctx);
  if (build !== null) cmds.push(build);

  // 4) 研究（自軍の建物が持つ研究のうち、まだ取っていない最初のもの）。
  //    **進化の費用が貯まっているときは研究しない**（町の中心を空けておく）。
  const research = canAffordNextAge(ctx) ? null : planResearch(ctx);
  if (research !== null) cmds.push(research);

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
function classifyVillagers(ctx: AiContext): OwnEntity[] {
  const m = ctx.memory;
  const villagerType = unitDefById(VILLAGER_ID).index;
  const firstLook = m.villagerKnownId.length === 0;
  const list = ctx.view.ownEntities;

  // 今いる建設係の数。**枠が空いているぶんだけ**新しい村人を建設係にする。
  let builders = 0;
  if (!firstLook) {
    for (let k = 0; k < list.length; k++) {
      const oe = list[k]!;
      if (oe.kind !== EntityKind.Unit || oe.typeId !== villagerType) continue;
      if (memGet(m.villagerRole, oe.index) === VILLAGER_BUILDER) builders++;
    }
  }

  /** この判断で新しく採集に就ける村人（`planEconomy` が `gather` を出す）。 */
  const toGather: OwnEntity[] = [];
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Unit || oe.typeId !== villagerType) continue;
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    if (memGet(m.villagerKnownId, oe.index) === id) continue;
    memSet(m.villagerKnownId, oe.index, id);
    memSet(m.villagerBusyUntil, oe.index, 0);
    if (firstLook) {
      // 開始時の村人は `setup` が資源に就かせている。触らない。
      memSet(m.villagerRole, oe.index, VILLAGER_GATHERER);
      continue;
    }
    // 生産されたばかりの村人。**建設係の枠が埋まっていたら、その場で採集に送る。**
    //
    // 以前は「全員いったん建設係にして、余ったら後で採集に回す」形だった。
    // これだと建設係が建設で塞がっている間は余りが見えず、実測で
    // **30 分に `gather` が 1 回しか出なかった**（＝生産された村人がほぼ全員遊んでいた）。
    // 遊ばせるくらいなら採らせるほうが常に得なので、既定を採集側に寄せる。
    if (builders < ctx.cfg.villagerBuilderCount) {
      memSet(m.villagerRole, oe.index, VILLAGER_BUILDER);
      builders++;
    } else {
      memSet(m.villagerRole, oe.index, VILLAGER_GATHERER);
      toGather.push(oe);
    }
  }
  return toGather;
}

/**
 * 村人 1 体を出すのに必要な手持ち = 村人のコスト + 家 1 棟のコスト。
 *
 * **家の資源まで使い切ってはいけない。** 使い切ると人口上限に当たったときに
 * 家が建てられず、そこから何も出せなくなって内政が破綻する（T-M13-02 の
 * 「破綻せず回す」はこれを指す）。数値はデータ（`units.json` / `buildings.json`）由来。
 */
const VILLAGER_RESERVE: Int32Array = (() => {
  const v = unitDefById(VILLAGER_ID).cost;
  const h = buildingDefById('house').cost;
  const out = new Int32Array(v.length);
  for (let r = 0; r < out.length; r++) out[r] = v[r]! + h[r]!;
  return out;
})();

/** 自軍の村人の数（生産中は数えない）。 */
export function countOwnVillagers(ctx: AiContext): number {
  const villagerType = unitDefById(VILLAGER_ID).index;
  let n = 0;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind === EntityKind.Unit && oe.typeId === villagerType) n++;
  }
  return n;
}

/** 村人を 1 体ずつ町の中心に積む（人口枠と手持ち資源が足りているときだけ）。 */
function pushVillagerProduction(ctx: AiContext, out: Command[]): void {
  const own = ctx.view.own;
  if (own.pop >= own.popCap) return; // 上限に当たっている（`07§8`「生産ボタンが止まります」）
  // **目標数で止める。** 止めないと入ってきた資源を全部村人に変えてしまい、
  // 手持ちが 0 付近に張り付いて次の世に上がれない（`AiLevelConfig.villagerTarget` 参照）。
  // **目標数で止める。**
  //
  // 止めないと入った食料をその場で村人に変え続け、手持ちが 0 付近に張り付いて
  // 次の世に上がれない。逆に止めるのが早すぎると採集人数が増えず、
  // やはり上がれない ―― 実測で「12 体で貯め始める」形にしたら
  // **村人 12 体のまま 30 分間固定**になった（費用も貯まらない）。
  //
  // だから貯めるための別のしきい値は持たず、**目標数まで出したら自然に止まる**
  // 形にしている（`villagerTarget` に達したあとは食料が余り始め、
  // その余りが次の世の費用になる）。軍事の生産も同じ目標数を待つので、
  // 「村人を揃える → 世を上げる → 兵を出す」の順に流れる。
  if (countOwnVillagers(ctx) >= ctx.cfg.villagerTarget) return;
  const udef = unitDefById(VILLAGER_ID);
  if (!canAfford(own.resources, VILLAGER_RESERVE)) return;
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
  const m = ctx.memory;
  const civ = ctx.view.own.civ as CivId;
  if (needsHouse(ctx)) {
    const house = resolveBuildingForCiv(civ, 'house');
    if (house !== null && canCivBuild(civ, house)) return house;
  }
  // **次の世に足りない資源**を優先して施設を建てる。
  //
  // ここを `scarcestResource`（手持ちの単純比較）にしていたら、
  // 果樹が枯れて食料が 200 で止まっているのに「石材のほうが数値が小さい」ため
  // 農地が 1 面も建たず、青銅の世の 500 に永久に届かなかった（実測）。
  // 農地は食料ノードを作り直せる唯一の手段なので、ここの選び方が効く。
  const scarce = deficitOrScarcest(ctx);
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
    // 資源施設は 1 棟ずつでよい。農地だけは「足りない資源が食料のとき」建て増す。
    //
    // ただし **働き手の数を超えて建てない。**
    // 農地は食料ノードを載せるだけで、誰も就いていなければ 1 も採れない。
    // 実測（席 1 側）で農地 13 面まで建てながら食料が 166 で止まり、
    // 木材を農地に吸われて家が建たず、人口 30 で詰まって
    // **青銅の世に一度も上がらなかった**（席 0 側は農地 6 面で上がった）。
    // 誰も働かない農地は木材を捨てているのと同じ。
    const canGrowFarms =
      id === 'farm' && scarce === FOOD && have < memGet(m.assignedByResource, FOOD);
    if (have > 0 && !canGrowFarms) continue;
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
  // **家 1 棟ぶんは常に残す。** 使い切ると人口上限に当たったときに家が建てられず、
  // そこから何も出せなくなる（家そのものを建てるときは当然この予備を要求しない）。
  const reserve = buildingId === HOUSE_ID ? bdef.cost : withHouseReserve(bdef.cost);
  if (!canAfford(ctx.view.own.resources, reserve)) return null;
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
  const id = resolveBuildingForCiv(ctx.view.own.civ as CivId, TOWN_CENTER_ID);
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
      if (!canCivResearch(own.civ as CivId, techId)) continue;
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
 * 余った建設係を採集に就ける（`07§2` の「村人を遊ばせない」）。
 *
 * ■ なぜ必要になったか（実測で分かった不具合）
 * `classifyVillagers` は「後から現れた村人 = 建設係」と決めるが、建設係は
 * `takeBuilder` に借りられるまで**何もしない**。着工は 1 回の判断で 1 棟だけなので、
 * 生産された村人はほぼ全員が手空きのまま立ち続けていた。
 * 実測（8 人・30 分）で **石材と金の累計採集量が 0**、食料も設計値の約 1/20 で、
 * 結果として誰も鉄器の世に到達せず**文明ごとの兵種が 1 体も出なかった**。
 *
 * ■ 直し方
 * 建設係を `villagerBuilderCount` 人だけ残し、**それを超えた手空きの村人は
 * いちばん足りない資源のノードへ送って採集係にする**。
 * 一度採集係にしたら触らない（`sim` 側が枯れたら次のノードへ移してくれる）。
 *
 * ■ 決定論
 * `ownEntities` は index 昇順、`seenResourceNodes` も index 昇順。
 * 距離は平方距離の整数比較で、同距離なら**先に見つけたノード**を採る。
 * 乱数を使わないので全端末で同じ結論になる。
 */
export function gatherCommandsFor(ctx: AiContext, villagers: readonly OwnEntity[]): Command[] {
  if (villagers.length === 0) return [];
  const m = ctx.memory;
  // **記憶から選ぶ**（視界内だけだと拠点の周りの森と果樹しか選べない）。
  if (m.nodeIds.length === 0) return [];
  const cmds: Command[] = [];
  for (let k = 0; k < villagers.length; k++) {
    const oe = villagers[k]!;
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    // **半分は 4 資源に順番で、半分は「次の世に足りないもの」へ。**
    //
    // 決め方を 2 度作り直している。経緯を残す:
    //  1. 「いちばん足りない資源」だけを狙わせた → 食料と木材は入った瞬間に消えるので
    //     常にこの 2 つが最下位になり、**石材と金は 30 分で 0 のまま**だった。
    //  2. 4 資源に均等に散らした → 石材と金は入るようになったが、こんどは
    //     **食料が 200 前後で止まり**、青銅の世の 500 に届かなかった（1/4 しか採らない）。
    //  3. いま: 偶数番目は順番に（4 資源すべてに人が就くのを保証）、
    //     奇数番目は**次の世の費用に対していちばん足りない資源**へ寄せる。
    //     これで「建物に使う木と石も採れるが、進化に必要なものが優先される」形になる。
    //
    // 割り当ては「その村人が何人目か」で決めるので乱数を使わない。
    const seq = memGet(m.gatherAssignSeq, 0) + k;
    // 順番のほうは `seq / 2` で数える（`seq % 4` だと偶数の seq が 0 と 2 しか
    // 取らず、木材と金に誰も就かない ―― 実測で踏んだ）。
    //
    // 回す先は **`gatherTargets` が返す「いま必要な資源」だけ**。
    // 4 資源に均等に散らしていたら、age 0 では使い道の無い石材が 800、金が 599 まで
    // 積み上がる一方で、青銅の世に必要な食料 500 に 25 分かかっていた。
    // 余る資源に人を置くのは、その人ぶんの食料を捨てているのと同じ。
    // 半分は `gatherTargets` を順番に、半分は「次の世に足りない資源」へ。
    //
    // 「順番だけ」にしてみたら（age 0 なら食料と木材で半々）内政が壊れた ――
    // 食料に就く人が半分に減り、村人が 15 体から増えないまま相手に押し切られた。
    // 逆に「足りない資源だけ」にすると木材が細って農地が建たない
    // （農地は木材 60。木材 → 農地 → 食料 がひと続きの流れになっている）。
    // 両方を混ぜるこの形が実測でいちばんよかった。
    const targets = gatherTargets(ctx);
    const want =
      seq % 2 === 0
        ? targets[Math.floor(seq / 2) % targets.length]!
        : nextAgeDeficitResource(ctx);
    const target = nearestNodeOf(ctx, oe, want) ?? nearestNodeOf(ctx, oe, -1);
    if (target === null) break;
    cmds.push({ t: 'gather', p: ctx.playerId, units: [id], target });
    memSet(m.assignedByResource, want, memGet(m.assignedByResource, want) + 1);
  }
  memSet(m.gatherAssignSeq, 0, memGet(m.gatherAssignSeq, 0) + villagers.length);
  return cmds;
}

/**
 * その村人にいちばん近い資源ノード（`resource` が -1 なら種類を問わない）。
 * 平方距離で比べる（平方根を取らない。§0.3）。
 */
function nearestNodeOf(ctx: AiContext, from: OwnEntity, resource: number): EntityId | null {
  const m = ctx.memory;
  let best: EntityId | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (let k = 0; k < m.nodeIds.length; k++) {
    if (resource >= 0 && m.nodeResource[k] !== resource) continue;
    const dx = m.nodeX[k]! - from.x;
    const dy = m.nodeY[k]! - from.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = m.nodeIds[k] as EntityId;
    }
  }
  return best;
}

/**
 * 建てる施設を選ぶときの「足りない資源」。
 * 次の世の費用に足りないものがあればそれを、無ければ手持ちがいちばん少ないものを返す。
 */
export function deficitOrScarcest(ctx: AiContext): number {
  if (!canAffordNextAge(ctx)) return nextAgeDeficitResource(ctx);
  return scarcestResource(ctx.view.own.resources);
}

/**
 * 次の世の費用に対していちばん足りない資源（同値は `RESOURCE_IDS` 順で固定）。
 * 足りないものが無ければ食料（いつでも人口の元になる）。
 */
export function nextAgeDeficitResource(ctx: AiContext): number {
  const age = ctx.view.own.age;
  const next = cfgAges()[age + 1];
  const res = ctx.view.own.resources;
  if (next === undefined) return FOOD;
  let best = -1;
  let bestDeficit = 0;
  for (let r = 0; r < RESOURCE_IDS.length; r++) {
    const need = next.cost[RESOURCE_IDS[r]!] ?? 0;
    if (need <= 0) continue;
    const deficit = need - fxToInt(res[r] ?? 0);
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      best = r;
    }
  }
  return best < 0 ? FOOD : best;
}

/**
 * 世が変わって必要になった資源に、**既にいる採集係を移す**。
 *
 * `gather` は新しくできた村人にしか出していないので、村人を出し切ったあとに
 * 世が上がると、新しく要求される資源（鉄器なら金）に誰も就かないまま終わる。
 *
 * 移すのは **1 判断につき 1 人まで**（全員を一度に動かすと採集が止まる）。
 * 誰を動かすかは `ownEntities` の index 昇順で最初に見つかった採集係
 * ―― 乱数を使わないので全端末で同じ村人が動く。
 */
export function reassignForNextAge(ctx: AiContext): Command[] {
  const m = ctx.memory;
  // 移す先は**いちばん足りない資源**だけにする。
  //
  // ■ ここを「誰も就いていない資源」にしてみたら悪化した（実測）
  // 金に誰も就いていないので村人を 1 人送る、という形にしたところ、
  // その村人が**単独で遠くの金鉱まで歩いて死に**、村人が 26 → 10 に減って
  // 内政が崩れた（食料も 411 → 12）。拠点から離れた資源へ人を送るには
  // 「安全に行けるか」「護衛を付けるか」の判断が要る。**それは別の仕事**なので、
  // ここでは「もともと採っている資源のうち、いちばん足りないもの」に寄せるだけにする。
  // 遠くの資源を使うには `mining_camp` のような搬入点を先に建てる形が要る（未実装）。
  const need = nextAgeDeficitResource(ctx);
  if (memGet(m.assignedByResource, need) > 0) return [];
  if (!knowsResource(ctx, need)) return []; // 場所を知らないなら探索の仕事
  const villagerType = unitDefById(VILLAGER_ID).index;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Unit || oe.typeId !== villagerType) continue;
    if (memGet(m.villagerRole, oe.index) !== VILLAGER_GATHERER) continue;
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    const target = nearestNodeOf(ctx, oe, need);
    if (target === null) return [];
    memSet(m.assignedByResource, need, 1);
    return [{ t: 'gather', p: ctx.playerId, units: [id], target }];
  }
  return [];
}

/**
 * いま人を就かせる価値がある資源（`RESOURCE_IDS` の添字。昇順）。
 *
 *  - **次の世が要求する資源**（これが無いと世が上がらない）
 *  - **食料**（人口の元。常に要る）
 *  - **木材**（家と資源施設の元。常に要る）
 *
 * 石材と金は「次の世が要求するとき」だけ入る。使い道が無いのに採らせると、
 * その村人ぶんの食料を捨てているのと同じになる（実測で石材 800・金 599 が
 * 使われずに余り、そのぶん青銅の世が 25 分まで遅れていた）。
 */
export function gatherTargets(ctx: AiContext): number[] {
  const want = new Set<number>([FOOD, RESOURCE_IDS.indexOf('wood')]);
  const next = cfgAges()[ctx.view.own.age + 1];
  if (next !== undefined) {
    for (const resId of Object.keys(next.cost)) {
      const r = RESOURCE_IDS.indexOf(resId as (typeof RESOURCE_IDS)[number]);
      if (r >= 0) want.add(r);
    }
  }
  // **`Set` の反復順に依存しない**（§0.3）。添字昇順に並べ直す。
  const out: number[] = [];
  for (let r = 0; r < RESOURCE_IDS.length; r++) if (want.has(r)) out.push(r);
  return out;
}

/** 記憶にその資源のノードがあるか（探索を続けるかの判断に使う）。 */
export function knowsResource(ctx: AiContext, resource: number): boolean {
  const m = ctx.memory;
  for (let k = 0; k < m.nodeResource.length; k++) {
    if (m.nodeResource[k] === resource) return true;
  }
  return false;
}

/**
 * 時代進化（`03§2`）。`allowAdvanceAge` の段階だけ。
 * 前提（前の世の建物 2 種・資源・研究中でない）の判定は `sim` 側が持っているので、
 * ここでは「最終時代でなければ町の中心に出す」だけ。通らなければ黙って捨てられる。
 */
/** 次の世の費用が手元にあるか（無ければ貯める）。最終世なら true（貯める必要が無い）。 */
/**
 * 次の世のために取り置く額（資源 index 順の Fx）。上げない段階と最終世は 0。
 *
 * ■ なぜ取り置くのか
 * 兵は食料を食う。取り置かないと**入った食料が全部兵に変わって永久に世が上がらない**。
 * 実測（段階 4・30 分）で兵が 26 体まで育つ一方、食料は 0〜19 に張り付き、
 * 青銅の世の 500 に一度も届かなかった。石材 500・金 410 は誰も使わずに余っていた。
 *
 * 人間も「次の世のぶんは手を付けない」と決めて兵を出すので、これは自然な形。
 */
export function ageReserveFx(ctx: AiContext): Int32Array {
  const out = new Int32Array(RESOURCE_IDS.length);
  if (!ctx.cfg.allowAdvanceAge) return out;
  const age = ctx.view.own.age;
  if (age >= AGE_IDS.length - 1) return out;
  const next = cfgAges()[age + 1];
  if (next === undefined) return out;
  // 最初の世（黎明 → 青銅）は**全額**取り置く。青銅で兵種ツリーが枝分かれするので、
  // ここに上がらないと文明の違いが盤に出ない。
  // 2 つ目以降は割合ぶんだけ（全額のままだと兵が 1 体も出ないまま試合が終わる）。
  const ratio = age === 0 ? FX_ONE : fx(ctx.cfg.ageReserveRatioAfterFirst);
  for (const [resId, amount] of Object.entries(next.cost)) {
    const r = RESOURCE_IDS.indexOf(resId as (typeof RESOURCE_IDS)[number]);
    if (r >= 0) out[r] = fxMul(fx(amount), ratio);
  }
  return out;
}

/**
 * 「次の世のぶんを取り置いたうえで」その費用を払えるか。
 * 世を上げない段階では取り置きが 0 なので `canAfford` と同じ。
 */
export function canAffordWithAgeReserve(
  ctx: AiContext,
  cost: Int32Array | readonly number[],
): boolean {
  const reserve = ageReserveFx(ctx);
  const res = ctx.view.own.resources;
  for (let r = 0; r < res.length; r++) {
    // **取り置きは 0 で止める。**
    // 引き算のままにすると「取り置き > 手持ち」のとき残りが負になり、
    // **その資源を 1 も使わない兵まで作れなくなる**（実測: 金 50 に対し取り置き 100 で
    // 食料だけの兵も出せず、30 分で兵 0 体だった）。
    const usable = (res[r] ?? 0) - (reserve[r] ?? 0);
    if ((usable > 0 ? usable : 0) < (cost[r] ?? 0)) return false;
  }
  return true;
}

export function canAffordNextAge(ctx: AiContext): boolean {
  if (!ctx.cfg.allowAdvanceAge) return true;
  const age = ctx.view.own.age;
  if (age >= AGE_IDS.length - 1) return true;
  const next = cfgAges()[age + 1];
  if (next === undefined) return true;
  const res = ctx.view.own.resources;
  for (const [resId, amount] of Object.entries(next.cost)) {
    const r = RESOURCE_IDS.indexOf(resId as (typeof RESOURCE_IDS)[number]);
    if (r < 0) continue;
    if (fxToInt(res[r] ?? 0) < amount) return false;
  }
  return true;
}

export function planAgeAdvance(ctx: AiContext): Command | null {
  if (!ctx.cfg.allowAdvanceAge) return null;
  const age = ctx.view.own.age;
  if (age >= AGE_IDS.length - 1) return null;
  const tc = findTownCenter(ctx);
  if (tc === null) return null;
  // **資源が足りているときだけ出す。**
  //
  // 以前はここで毎回出していた。`sim` 側は足りなければ黙って捨てるので
  // 動作としては正しく見えるが、実測で**全コマンドの 96〜97% がこの空打ち**になり、
  // 操作量（APM）の計測が意味を失っていた（段階 5 で APM 62 のうち有効な操作は 2 件）。
  // 「出せないなら出さない」は人間の操作でも同じ（UI はボタンを暗くする。`05§4`）。
  if (!canAffordNextAge(ctx)) return null;
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
  // **次の世の費用を売り払わない。**
  // 鉄器の世は金 200 を要求するが、以前はここで金を売り続けて
  // 金が 90〜100 に張り付き、永久に届かなかった（実測で交換 133 回）。
  // 貯めている最中に貯めているものを手放すのは、どんな相場でも損。
  if (!canAffordNextAge(ctx)) return null;
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
