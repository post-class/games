/**
 * ai/militaryGoals.ts — 軍事の AI（T-M13-03。実装手順書 §10、`03§5` / `03§7`）
 *
 * ■ 中心の考え: **相手文明の「穴」から兵種を逆算する**（`03§5`）
 * 「持っていない」がそのまま読み合いになる、というのが `03§5` の主旨で、資料はこう書いている:
 *   > たとえば相手がアステカだと分かった時点で「騎兵は来ない」と確定するので、
 *   > こちらは槍兵を切って弓兵に寄せられます。
 *
 * これを **文明名の if 文で書かない**。やっているのは次の 3 段だけ:
 *   1. `AiView.seenEnemies` の `typeId` → `units.json` の `civ` で**相手の文明を推定**する
 *      （軍事ユニットは文明固有なので、見た兵から逆算できる。`AiView` に敵の civ は入っていない）。
 *   2. 推定できた文明の `unitTree` から、**その相手が今後出せる役割**を列挙する
 *      （アステカには騎兵・獣兵・火器の段が無い → 重みが 0 になる）。
 *      実際に見えている兵はそのまま重みに足す（目の前の脅威が優先される）。
 *   3. 自分が出せる兵の役割ごとに `config.json:counterMatrix`（`counterMul`）で
 *      **相性の期待値**を採り、高い順に生産する。
 *
 * 結果として「騎兵が来ない相手には槍の点数が伸びず、弓の点数が伸びる」が
 * **データだけで**出る。文明が増えてもコードは変わらない。
 *
 * ズルをしない前提（`07§11`）: 使うのは `AiView` に入っているものだけ。
 * 「相手の文明」も**視界に敵が入って初めて**分かる（見ていないうちは推定なし）。
 */

import type { CivId, EntityId } from '@/shared/types';
import { CIV_IDS, EntityKind } from '@/shared/types';
import type { Command } from '@/sim/command';
import { TICK_RATE, cfgArray, cfgInt, cfgNum, cfgTiles } from '@/sim/core/config';
import {
  BUILDING_DEFS,
  CIV_DEFS,
  ROLE_COUNT,
  ROLE_IDS,
  UNIT_DEFS,
  buildingDef,
  buildingDefById,
  canCivBuild,
  civDefById,
  civUnitsAtAge,
  counterMul,
  resolveBuildingForCiv,
  unitDef,
  unitDefById,
} from '@/sim/core/defs';
import type { Fx } from '@/sim/core/fx';
import { FX_ONE, distSq, fxFromInt, idiv } from '@/sim/core/fx';

import { MAP_TYPE_IDS } from '@/shared/types';
import { mapParams } from '@/sim/systems/mapgen';
import type { AiContext } from './AiPlayer';
import { memGet, memSet } from './AiPlayer';
import type { AiView, OwnEntity } from './view';
import {
  canAfford,
  canAffordWithAgeReserve,
  canQueueProduce,
  findTownCenter,
  markProduce,
  placeBuildingCommand,
} from './econGoals';

// ---------------------------------------------------------------- データ由来の定数

/**
 * 戦域が生まれる最小人数（`front.spawnMinUnits` = 3）。
 * 「これ未満では戦域にならない」というシステム上の意味そのままで、
 *  - 攻めに出す最小の兵数
 *  - 囮の兵数（`07§11` の「少数の兵で戦域を立てる」）
 * に使う。
 */
export const SQUAD_MIN_UNITS = cfgInt('front.spawnMinUnits');

/**
 * 「立ち上げ」区間の終わり（tick）。`config.matchPhases` の `buildup.toSec`。
 * `07§2`「0〜5 分は村人だけを増やす時間」の境目そのもの。
 */
const BUILDUP_END_TICK = (() => {
  const phases = cfgArray('matchPhases');
  for (const raw of phases) {
    const p = raw as Record<string, unknown>;
    if (p['id'] === 'buildup') return Math.round(Number(p['toSec']) * TICK_RATE);
  }
  throw new Error("config.json の matchPhases に buildup がない");
})();

/** 戦域が生まれる半径（`front.spawnRadiusTiles`、Fx）。到着判定に使う。 */
export const ARRIVE_RADIUS: Fx = cfgTiles('front.spawnRadiusTiles');

/** 戦える役割の index（`line` を持つユニットの役割 = 村人・斥候・伝令・祈祷師を除く）。 */
export const COMBAT_ROLES: readonly number[] = buildCombatRoles();

function buildCombatRoles(): number[] {
  const flag = new Uint8Array(ROLE_COUNT);
  for (let i = 0; i < UNIT_DEFS.length; i++) {
    const u = UNIT_DEFS[i]!;
    if (u.lineIdx === 0) continue; // line が無い（村人・斥候・伝令・祈祷師）
    flag[u.roleIdx] = 1;
  }
  const out: number[] = [];
  for (let r = 0; r < ROLE_COUNT; r++) if (flag[r] === 1) out.push(r);
  return out;
}

// ---------------------------------------------------------------- 敵の読み

/** 見た兵から逆算した相手の姿。 */
export interface EnemyRead {
  /** 推定できた敵文明（`CIV_IDS` の順に固定）。見ていなければ空。 */
  readonly civs: readonly CivId[];
  /** 役割ごとの脅威の重み（整数。見えている兵 + 相手文明が出せる役割）。 */
  readonly roleWeight: Int32Array;
  /** 視界内の敵の数（ユニット）。 */
  readonly seenUnits: number;
}

/**
 * `AiView` から相手の姿を読む。
 *
 * 重みの付け方:
 *  - **見えている敵ユニット 1 体につき +1**（今そこにある脅威）
 *  - **見えている敵の建物 1 棟につき `building` の役割へ +1**（`buildingWeightMax` で頭打ち）
 *  - **推定できた敵文明が出せる役割 1 つにつき +1**（これから来る脅威）
 * 文明が推定できていなければ 3 つ目は 0 になる ―― つまり
 * **偵察していない AI は相性を読めない**（透視をしないことの裏返し）。
 *
 * ■ なぜ建物を重みに足すのか（実測。攻城工房が 1 棟も建たなかった理由）
 * `config.json` の `counterMatrix` は **`siege → building: good`** と定めていて、
 * データ側は「攻城は建物に効く」と既に言っている。ところがここで敵の建物を
 * **文明の推定にしか使っていなかった**ので、`roleMixFromWeights` に渡る重みには
 * `building` が 1 度も立たず、**攻城の需要が構造的に 0** だった。
 * その結果 `planMilitaryBuilding` は攻城工房を選ばず、
 * 実測（段階 5・4 組・30 分）で**工房 0 棟・攻城兵器 0 体**だった。
 * ここに足せば既存の相性表がそのまま効く ―― 攻城のための特別扱いを書かなくてよい。
 *
 * `buildingWeightMax` の既定が 0 なのは、**既存の呼び出し（テストを含む）を
 * 1 引数のまま動かすため**。段階ごとの値は `ai.json` にある。
 */
export function readEnemy(view: AiView, buildingWeightMax = 0): EnemyRead {
  const roleWeight = new Int32Array(ROLE_COUNT);
  const civSeen = new Uint8Array(CIV_DEFS.length);
  let seenUnits = 0;
  const buildingRole = ROLE_IDS.indexOf('building' as never);
  let buildingWeight = 0;

  for (let k = 0; k < view.seenEnemies.length; k++) {
    const s = view.seenEnemies[k]!;
    if (s.kind === EntityKind.Unit) {
      const udef = unitDef(s.typeId);
      roleWeight[udef.roleIdx] = roleWeight[udef.roleIdx]! + 1;
      seenUnits++;
      if (udef.civ !== null) civSeen[civDefById(udef.civ).index] = 1;
    } else if (s.kind === EntityKind.Building) {
      const bdef = buildingDef(s.typeId);
      // 固有建物（大天幕・観輪・塩蔵など）も文明を明かす。
      if (bdef.civ !== null) civSeen[civDefById(bdef.civ).index] = 1;
      // **建物は「壊すべき相手」として数える。**
      // 1 棟ごとに素朴に足すと、拠点で 10 棟見えた瞬間に攻城へ寄りすぎるので
      // 上限を置く（`ai.json` の `enemyBuildingWeightMax`）。
      if (buildingRole >= 0 && buildingWeight < buildingWeightMax) {
        roleWeight[buildingRole] = roleWeight[buildingRole]! + 1;
        buildingWeight++;
      }
    }
  }

  const civs: CivId[] = [];
  for (let c = 0; c < CIV_IDS.length; c++) {
    const def = civDefById(CIV_IDS[c]!);
    if (civSeen[def.index] !== 1) continue;
    civs.push(def.id);
    addCivPotentialRoles(def.id, roleWeight);
  }

  return { civs, roleWeight, seenUnits };
}

/** その文明が全時代を通じて出せる役割に +1 する（`unitTree` から。**穴は 0 のまま**）。 */
function addCivPotentialRoles(civ: CivId, out: Int32Array): void {
  const flag = new Uint8Array(ROLE_COUNT);
  for (let age = 1; age < 4; age++) {
    const ids = civUnitsAtAge(civ, age);
    for (let i = 0; i < ids.length; i++) flag[unitDefById(ids[i]!).roleIdx] = 1;
  }
  for (let r = 0; r < ROLE_COUNT; r++) if (flag[r] === 1) out[r] = out[r]! + 1;
}

/**
 * 役割ごとの「欲しい割合」（Fx。合計が `FX_ONE` になるよう正規化）。
 *
 * 点数 = Σ 敵役割の重み × 相性倍率（`counterMul`）。
 * 相手に騎兵が居ない（重み 0）なら、槍の「騎兵に強い ×1.5」は 1 度も掛からず、
 * 代わりに槍が苦手な遠隔・攻城の ×0.7 だけが残るので**槍の割合が下がる**。
 * 遠隔は相手の近接（槍・剣）に ×1.5 が掛かるので**割合が上がる**。
 *
 * 敵が全く見えていないときは、戦える役割に均等（= 特に寄せない）。
 */
export function desiredRoleMix(view: AiView, buildingWeightMax = 0): Int32Array {
  const read = readEnemy(view, buildingWeightMax);
  return roleMixFromWeights(read.roleWeight);
}

/** 脅威の重みから役割ごとの割合（Fx）を作る。テストから直接呼べるように分けている。 */
export function roleMixFromWeights(roleWeight: Int32Array): Int32Array {
  const score = new Int32Array(ROLE_COUNT);
  let total = 0;
  for (let i = 0; i < COMBAT_ROLES.length; i++) {
    const mine = COMBAT_ROLES[i]!;
    let s = 0;
    for (let er = 0; er < ROLE_COUNT; er++) {
      const w = roleWeight[er]!;
      if (w === 0) continue;
      // 重み（整数）× 相性倍率（Fx）→ Fx。浮動小数を使わない。
      s += w * counterMul(mine, er);
    }
    score[mine] = s;
    total += s;
  }
  const mix = new Int32Array(ROLE_COUNT);
  if (total <= 0) {
    // 敵が見えていない → 戦える役割に均等（端数は index 昇順で先に配る）。
    const each = idiv(FX_ONE, COMBAT_ROLES.length);
    for (let i = 0; i < COMBAT_ROLES.length; i++) mix[COMBAT_ROLES[i]!] = each;
    return mix;
  }
  for (let i = 0; i < COMBAT_ROLES.length; i++) {
    const r = COMBAT_ROLES[i]!;
    mix[r] = idiv(score[r]! * FX_ONE, total);
  }
  return mix;
}

/** 役割 ID → 割合（Fx）。テストの可読性のための小道具。 */
export function roleShare(mix: Int32Array, role: string): Fx {
  const i = ROLE_IDS.indexOf(role as never);
  return i < 0 ? 0 : mix[i]!;
}

// ---------------------------------------------------------------- 兵の選択

/** 今その文明・その時代で作れる兵の ID（共通兵 + 文明ツリー + 城のエリート）。 */
/**
 * 船を作る価値があると見なす水域の割合の下限（`maps.json` の `waterRatio`）。
 * 平野は 0.02、内海や列島はこれよりずっと大きい。
 */
const SHIP_MIN_WATER_RATIO = cfgNum('mapgen.aiShipMinWaterRatio');

/** このマップの水域の割合（`maps.json` の `waterRatio`）。 */
function mapWaterRatio(view: AiView): number {
  const id = MAP_TYPE_IDS[view.map.mapType];
  if (id === undefined) return 0;
  return mapParams(id).waterRatio;
}

export function producibleUnits(view: AiView): string[] {
  const civ = view.own.civ as CivId;
  const age = view.own.age;
  const out: string[] = [];
  // **水がほとんど無いマップでは船を作らない。**
  // `07§13` は平野を「水域=ほぼ無し。港と船はほぼ不要」と定めている。
  // これが無いと、船を作るために港（木材）を建ててしまい、実測で
  // 木材が 2 まで枯れて家が建たず、人口 30 で詰まって世に上がれなかった。
  const water = mapWaterRatio(view);
  const allowShips = water >= SHIP_MIN_WATER_RATIO;
  // 共通兵（黎明の棍棒兵・狩人など。`unitTree` に載らない）。
  for (let i = 0; i < UNIT_DEFS.length; i++) {
    const u = UNIT_DEFS[i]!;
    if (u.civ !== null) continue;
    if (u.lineIdx === 0) continue; // 村人・斥候・伝令は軍事の対象外
    if (u.age > age) continue;
    if (!allowShips && u.role === 'ship') continue;
    out.push(u.id);
  }
  // 文明ツリーの現行段。
  const tree = civUnitsAtAge(civ, age);
  for (let i = 0; i < tree.length; i++) {
    const u = unitDefById(tree[i]!);
    if (u.age > age) continue;
    if (!allowShips && u.role === 'ship') continue;
    out.push(u.id);
  }
  // 城のエリート（`unitTree` の elite 段に載っていない文明もあるため明示的に足す）。
  const elite = civDefById(civ).eliteUnit;
  if (elite !== '' && unitDefById(elite).age <= age && !out.includes(elite)) out.push(elite);
  return out;
}

/**
 * 兵 1 種の点数（Fx）。役割の割合をそのまま点数に使う。
 * 同点は `units.json` の並び順（= index 昇順）で決まるので全順序になる。
 */
function unitScore(mix: Int32Array, unitId: string): Fx {
  return mix[unitDefById(unitId).roleIdx]!;
}

// ---------------------------------------------------------------- 公開: 軍事の判断

/** この判断 tick に出す軍事の `Command`。 */
export function planMilitary(ctx: AiContext): Command[] {
  // 段階 1（素人）は**内政のみ。攻めてこない**（`07§11`）。
  if (ctx.cfg.maxFronts <= 0) return [];

  const cmds: Command[] = [];
  // 敵の建物も「壊すべき相手」として構成比に入れる（`readEnemy` の注記）。
  // これが無いと攻城の需要が構造的に立たず、攻城工房が 1 棟も建たない。
  const mix = desiredRoleMix(ctx.view, ctx.cfg.enemyBuildingWeightMax);

  // 0) **内政が立つまで兵を作らない**（`07§2` の「0〜5 分は村人だけを増やす時間」）。
  //
  // ここが無いと、同じ食料を村人と兵が取り合い、**兵が勝つ**。
  // 実測（30 分・2 人戦）で `produce` 29 件のほとんどが兵で、
  // 村人が数体しか増えず、採集量が伸びないまま時代も進まなかった。
  // 敵が見えているときは例外（襲われているのに村人を出し続けるのは不合理）。
  //
  // 待つ条件は 2 つ:
  //  - 村人が目標数に届いていない（採集人数が足りない）
  //  - **まだ一度も世を上げていない**（`07§2` の「0〜5 分は村人だけを増やす時間」）。
  //    上げる前に兵を作ると、貯めた食料が兵に変わって永久に上がれない。実測で
  //    村人 24 体まで育っても食料が 12〜30 に張り付き、age 0 のままだった。
  //    進化しない段階（`allowAdvanceAge` が false）はこの条件を課さない
  //    ―― 上がらないのだから待つ意味が無く、待たせると永久に兵が出ない。
  // 立ち上げの区間（`config.matchPhases` の `buildup` = 0〜5 分）は兵を作らない。
  //
  // ここは一度「最初の世に上がるまで待つ」にしてみたが、**強すぎた** ――
  // 世に上がるのが 18〜24 分なので、28 組の総当たりが全部引き分けになり、
  // 戦闘が 1 度も起きなかった。`07§2` は 0〜5 分を「村人だけを増やす時間」、
  // 5〜12 分を「初接触」と定めているので、その境目をそのまま使う。
  //
  // **村人の数を兵の前提にしない。** 一度「村人が目標数（18）に届くまで待つ」に
  // していたが、18 体に届くのが 15 分ごろなので、`07§2` が「5〜12 分に最初の戦域が
  // 立つ」と定めている区間に戦域が 1 本も立たなかった（`tests/balance/tempo.test.ts`
  // の実測で 0 本）。村人を増やすのと兵を出すのは**同時に進める**ものであり、
  // 食料の取り合いは人間も抱えている普通の判断。
  const inBuildup = ctx.view.tick < BUILDUP_END_TICK;
  // 例外は「**戦域が立っている**」＝実際に戦っているとき。
  //
  // ここを「敵が視界に入った」にしていたら、**斥候が敵を一度見ただけで**
  // 兵の生産が解禁され、貯めていた食料が兵に変わって進化できなくなった（実測）。
  // 戦域は交戦から自動で立つ（`07§3`）ので、これが本当の「戦っている」の合図。
  const underAttack = ctx.view.ownFronts.length > 0;
  if (inBuildup && !underAttack) {
    // 兵は作らないが、**手空きの兵を前に出す判断だけは続ける**
    // （既にいる兵を放置すると戦域が立たない）。
    pushSiege(ctx, cmds);
    pushDispatch(ctx, cmds);
    return cmds;
  }

  // 1) 兵舎・射場・厩など「作りたい兵の生産元」を建てる（1 判断 1 棟）。
  const wishBuilding = pickMilitaryBuilding(ctx, mix);
  const bld = wishBuilding === null ? null : placeBuildingCommand(ctx, wishBuilding);
  if (bld !== null) cmds.push(bld);

  // 2) 生産元ごとに、そこで作れるいちばん点数の高い兵を 1 体積む。
  //
  // **建てたい生産元がまだ建っていないなら、その費用は兵に使わない。**
  //
  // ■ なぜ必要か（実測。攻城工房が 1 棟も建たなかった直接の原因）
  // 遠隔兵は木材を食う（1 体 25〜45）。生産元 2 棟から出し続けると木材の消費が
  // 毎分 100 前後になり、**木材の手持ちが 5〜31 のまま動かない**。
  // 拠点のそばの森が尽きたあとの木材の収入は毎分 40 前後なので、
  // 攻城工房（木材 200）はどう待っても貯まらない ―― 実測（段階 5・4 組・30 分）で
  // **工房 0 棟・攻城兵器 0 体**、着工試行にも一度も出てこなかった。
  // 人間は「工房を建てるから弓は少し止める」と考える。ここではその 1 棟ぶんだけ取り置く
  // （建て終われば取り置きは消える。永久に兵を止めるわけではない）。
  const buildReserve =
    bld === null && wishBuilding !== null ? buildingDefById(wishBuilding).cost : null;
  pushUnitProduction(ctx, mix, cmds, buildReserve);

  // 3) **拠点を落としに行く**（守り手のいない建物を名指しで殴る）。
  //    `pushDispatch` より先。ここで攻城に就いた兵は派遣の対象から外れる。
  pushSiege(ctx, cmds);

  // 4) 手空きの兵をまとめて前に出す / 到着した兵を令の管理下に戻す。
  pushDispatch(ctx, cmds);

  return cmds;
}

/**
 * 建てたい軍事建物を 1 つ選ぶ。
 * 「作りたい兵（点数順）の生産元をまだ持っていない」ものを上から。
 * 攻城工房は `allowSiege`、城は `allowDecoy`（戦域を広く使う段階）から。
 */
function planMilitaryBuilding(ctx: AiContext, mix: Int32Array): Command | null {
  const wish = pickMilitaryBuilding(ctx, mix);
  return wish === null ? null : placeBuildingCommand(ctx, wish);
}

/**
 * 建てたい軍事建物の ID を選ぶ（**まだ着工しない**）。
 *
 * 着工と分けている理由: 払えないときに「何を建てたかったか」を呼び出し側が知る必要がある。
 * それが分かれば、その建物のぶんの資源を**兵に使わずに取り置ける**
 * （`pushUnitProduction` の `buildReserve`）。分ける前は、
 * 建てたい建物が払えないまま兵がその資源を食べ続け、永久に建たなかった。
 */
function pickMilitaryBuilding(ctx: AiContext, mix: Int32Array): string | null {
  const view = ctx.view;
  const civ = view.own.civ as CivId;
  const wanted = producibleUnits(view);
  // 点数の高い順（同点は units.json の index 昇順）。
  wanted.sort((a, b) => {
    const d = unitScore(mix, b) - unitScore(mix, a);
    return d !== 0 ? d : unitDefById(a).index - unitDefById(b).index;
  });

  for (let i = 0; i < wanted.length; i++) {
    const udef = unitDefById(wanted[i]!);
    const src = resolveBuildingForCiv(civ, udef.producedAt);
    if (src === null || !canCivBuild(civ, src)) continue;
    const bdef = buildingDefById(src);
    if (bdef.age > view.own.age) continue;
    if (udef.roleIdx === roleIndexOf('siege') && !ctx.cfg.allowSiege) continue;
    if (bdef.frontSlotBonus > 0 && !ctx.cfg.allowDecoy) continue; // 城・大天幕は段階 4 以上
    if (hasBuilding(view, bdef.index)) continue;
    return src;
  }
  return null;
}

/**
 * 「建てたい生産元 1 棟ぶんを残したうえで」その兵を作れるか。
 * 取り置きは 0 で止める（引き算で負にすると、その資源を 1 も使わない兵まで作れなくなる
 * ―― `canAffordWithAgeReserve` と同じ理由）。
 */
function affordsWithBuildReserve(
  view: AiView,
  cost: Int32Array,
  reserve: Int32Array | null,
): boolean {
  if (reserve === null) return true;
  const res = view.own.resources;
  for (let r = 0; r < res.length; r++) {
    const usable = (res[r] ?? 0) - (reserve[r] ?? 0);
    if ((usable > 0 ? usable : 0) < (cost[r] ?? 0)) return false;
  }
  return true;
}

function roleIndexOf(role: string): number {
  return ROLE_IDS.indexOf(role as never);
}

/** 自軍がその建物を持っているか（建設中も数える）。 */
function hasBuilding(view: AiView, typeId: number): boolean {
  for (let k = 0; k < view.ownEntities.length; k++) {
    const oe = view.ownEntities[k]!;
    if (oe.kind === EntityKind.Building && oe.typeId === typeId) return true;
  }
  return false;
}

/** 生産元 1 棟につき 1 体、いちばん点数の高い兵を積む。 */
/** 自軍の兵の数（村人を除くユニット）。 */
function countOwnArmy(ctx: AiContext): number {
  let n = 0;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Unit) continue;
    if (unitDef(oe.typeId).role === 'villager') continue;
    n++;
  }
  return n;
}

function pushUnitProduction(
  ctx: AiContext,
  mix: Int32Array,
  out: Command[],
  /** 建てたい生産元 1 棟ぶんの費用（兵に使わない。上の注記）。無ければ null。 */
  buildReserve: Int32Array | null = null,
): void {
  const view = ctx.view;
  if (view.own.pop >= view.own.popCap) return;
  const wanted = producibleUnits(view);
  // **戦域が立つ最小人数までは取り置きを無視して作る。**
  //
  // 戦域は「双方が `front.spawnMinUnits` 体以上を 15 マス内に集める」ことで立つ
  // （`07§3`）。取り置きを全額効かせると青銅の世に上がるまで兵が 1 体も出ず、
  // 30 分のあいだ戦域が 1 本も立たない（`07§2` は 5〜12 分に立つと定めている）。
  // 抱える量は「戦域 1 本ぶん × `armyFloorSquads`」。ちょうど 1 本ぶんだと
  // 1 体死ぬたびに戦域が崩れるので、既定は 2 本ぶん（`ai.json`）。
  const armyFloor = SQUAD_MIN_UNITS * ctx.cfg.armyFloorSquads;
  const armyNow = countOwnArmy(ctx);
  const belowMinSquad = armyNow < armyFloor;

  // ■ もっと大きな例外は入れないことにした
  // 「最初の 1 隊は取り置きを無視して作る」を試したが、どちらに振っても悪化した:
  //  - 兵が死ぬたびに例外が復活する形 → 取り置きが永久に効かず、
  //    食料が 318 で止まって世が上がらない
  //  - 例外を一度だけにする形 → 1 隊が死んだあと兵が出ず、村人 22 → 2 に壊滅
  //  - 例外を常に有効にする形 → 兵は 5〜7 体で安定するが世が上がらない
  // いちばん健全だったのは**例外なし**（世が上がり、そのあと兵が 23 体まで育つ）。
  // 詳しくは `docs/BALANCE.md`。
  for (let k = 0; k < view.ownEntities.length; k++) {
    const oe = view.ownEntities[k]!;
    if (oe.kind !== EntityKind.Building || !oe.complete) continue;
    const bdef = buildingDef(oe.typeId);
    let bestId: string | null = null;
    let bestScore = -1;
    for (let i = 0; i < wanted.length; i++) {
      const udef = unitDefById(wanted[i]!);
      if (udef.producedAt !== bdef.id && udef.producedAt !== bdef.replaces) continue;
      if (udef.roleIdx === roleIndexOf('siege') && !ctx.cfg.allowSiege) continue;
      // **次の世のぶんを取り置いたうえで**払えるものだけ作る。
      // 取り置かないと入った食料が全部兵に変わり、永久に世が上がらない
      // （実測で兵 26 体・食料 0〜19 のまま age 0 だった）。
      const affordable = belowMinSquad
        ? canAfford(view.own.resources, udef.cost)
        : canAffordWithAgeReserve(ctx, udef.cost) && affordsWithBuildReserve(view, udef.cost, buildReserve);
      if (!affordable) continue;
      const s = unitScore(mix, udef.id);
      if (s > bestScore || (s === bestScore && bestId !== null && udef.index < unitDefById(bestId).index)) {
        bestScore = s;
        bestId = udef.id;
      }
    }
    if (bestId === null) continue;
    // **1 体できあがるまで次を頼まない**（`AiMemory.produceTick` の注記）。
    //
    // 村人と同じ理由。生産元 1 棟につき判断ごとに `produce` を出していたので、
    // 判断が速い段階ほど同じ 1 体を何度も注文し、待ち行列に食料と金が吸われていた。
    // 実測（段階 5・4 組・30 分）では鉄器の世に上がれたのが 4/8 席しかなく、
    // 判断が半分の速さの段階 4（7/8 席）より弱かった。
    if (!canQueueProduce(ctx, oe.index, unitDefById(bestId).buildTicks, true)) continue;
    markProduce(ctx, oe.index, true);
    out.push({
      t: 'produce',
      p: ctx.playerId,
      building: ctx.idOf(oe.index),
      unit: bestId,
      count: 1,
    });
  }
}

// ---------------------------------------------------------------- 出撃

/** 戦える自軍ユニット（`line` を持つ = 村人・斥候・伝令・祈祷師を除く）。 */
export function combatUnits(view: AiView): OwnEntity[] {
  const out: OwnEntity[] = [];
  for (let k = 0; k < view.ownEntities.length; k++) {
    const oe = view.ownEntities[k]!;
    if (oe.kind !== EntityKind.Unit) continue;
    if (unitDef(oe.typeId).lineIdx === 0) continue;
    out.push(oe);
  }
  return out;
}

/**
 * 攻める先の候補（近い順に固定した全順序）。
 *  1. 見えている敵の建物（位置が分かっている拠点）
 *  2. 見えている敵の戦域（輪の中心。中身は見えない ―― `07§7`）
 *  3. 味方でないプレイヤーの開始位置（`AiView.map.starts`。人間も知っている情報）
 *
 * 並びは「自軍の町の中心からの平方距離 → y → x」昇順（§16-2 と同じ全順序）。
 */
export function attackTargets(ctx: AiContext): { x: Fx; y: Fx }[] {
  const view = ctx.view;
  const tc = findTownCenter(ctx);
  const ox = tc === null ? 0 : tc.x;
  const oy = tc === null ? 0 : tc.y;
  const out: { x: Fx; y: Fx; d: number }[] = [];

  // 見えている敵の戦闘ユニット。**戦域は戦闘から生まれる**（`07§3`）ので、
  // 建物より兵を先に狙う方が戦域が立つ（建物だけ殴ると令を配る場が生まれない）。
  for (let k = 0; k < view.seenEnemies.length; k++) {
    const s = view.seenEnemies[k]!;
    if (s.kind !== EntityKind.Unit) continue;
    if (unitDef(s.typeId).lineIdx === 0) continue;
    out.push({ x: s.x, y: s.y, d: distSq(ox, oy, s.x, s.y) });
  }
  for (let k = 0; k < view.seenEnemies.length; k++) {
    const s = view.seenEnemies[k]!;
    if (s.kind !== EntityKind.Building) continue;
    out.push({ x: s.x, y: s.y, d: distSq(ox, oy, s.x, s.y) });
  }
  for (let k = 0; k < view.enemyFronts.length; k++) {
    const f = view.enemyFronts[k]!;
    out.push({ x: f.x, y: f.y, d: distSq(ox, oy, f.x, f.y) });
  }
  const starts = view.map.starts;
  for (let p = 0; p * 2 + 1 < starts.length; p++) {
    const sx = starts[p * 2]!;
    const sy = starts[p * 2 + 1]!;
    if (sx === 0 && sy === 0) continue; // 未使用の席
    if (view.isAlly(p as never)) continue;
    out.push({ x: sx, y: sy, d: distSq(ox, oy, sx, sy) });
  }

  out.sort((a, b) => (a.d !== b.d ? a.d - b.d : a.y !== b.y ? a.y - b.y : a.x - b.x));
  return out.map((t) => ({ x: t.x, y: t.y }));
}

// ---------------------------------------------------------------- 攻城（拠点を落とす）

/**
 * 攻める建物 1 件（並びは決定論的な全順序）。
 */
export interface SiegeTarget {
  /** `attackTarget` に載せる目標（`SeenEntity.id`。視界を通った敵だけ）。 */
  readonly id: EntityId;
  readonly x: Fx;
  readonly y: Fx;
  /** 優先度の段（0 = 町の中心、1 = 生産元、2 = その他）。 */
  readonly rank: number;
}

/**
 * 「ユニットの生産元になる建物」の旗（`BUILDING_DEFS` の index を添字にする）。
 *
 * **`buildings.json` の `produces` だけでは足りない。** 兵舎・射場・厩の `produces` は
 * 空で、生産の対応は逆側（`units.json` の `producedAt`）に書かれているため
 * （実測: `produces` だけで判定したら兵舎が「その他」の段に落ちた）。
 * 文明固有の置き換え（`replaces`）も同じ生産元として数える。
 */
const PRODUCER_FLAG: Uint8Array = buildProducerFlag();

function buildProducerFlag(): Uint8Array {
  const flag = new Uint8Array(BUILDING_DEFS.length);
  for (let b = 0; b < BUILDING_DEFS.length; b++) {
    const bd = BUILDING_DEFS[b]!;
    if (bd.produces.length > 0) {
      flag[b] = 1;
      continue;
    }
    for (let u = 0; u < UNIT_DEFS.length; u++) {
      const at = UNIT_DEFS[u]!.producedAt;
      if (at === bd.id || (bd.replaces !== null && at === bd.replaces)) {
        flag[b] = 1;
        break;
      }
    }
  }
  return flag;
}

/**
 * 建物の優先度の段。
 *  - 0: **町の中心**（`lossCausesDefeat`）。根拠は勝利条件そのもの
 *       ―― `03§10`「相手の町の中心をすべて破壊」。ここを落とさないと試合は終わらない。
 *  - 1: **生産元**（兵舎・射場・厩など）。落とせば相手の兵の湧きが止まる。
 *  - 2: それ以外（家・資源施設・壁など）。
 */
function siegeRank(typeId: number): number {
  const b = buildingDef(typeId);
  if (b.lossCausesDefeat) return 0;
  return PRODUCER_FLAG[b.index] === 1 ? 1 : 2;
}

/**
 * 見えている敵の建物を攻める順に並べる。
 *
 * 全順序（同値のときの決め方まで固定する。§0.3。ここが揺れると全端末でデシンクする）:
 *   `rank` 昇順 → **自軍の町の中心からの平方距離**昇順 → y 昇順 → x 昇順 → `EntityId` 昇順
 * 平方距離のまま比べる（平方根を取らない）。
 */
export function siegeTargets(ctx: AiContext): SiegeTarget[] {
  const view = ctx.view;
  const tc = findTownCenter(ctx);
  const ox = tc === null ? 0 : tc.x;
  const oy = tc === null ? 0 : tc.y;
  const rows: { t: SiegeTarget; d: number }[] = [];
  for (let k = 0; k < view.seenEnemies.length; k++) {
    const s = view.seenEnemies[k]!;
    if (s.kind !== EntityKind.Building) continue;
    rows.push({
      t: { id: s.id, x: s.x, y: s.y, rank: siegeRank(s.typeId) },
      d: distSq(ox, oy, s.x, s.y),
    });
  }
  rows.sort((a, b) =>
    a.t.rank !== b.t.rank
      ? a.t.rank - b.t.rank
      : a.d !== b.d
        ? a.d - b.d
        : a.t.y !== b.t.y
          ? a.t.y - b.t.y
          : a.t.x !== b.t.x
            ? a.t.x - b.t.x
            : a.t.id - b.t.id
  );
  return rows.map((r) => r.t);
}

/** マス数（`ai.json` の整数）を Fx に直す。 */
function tilesToFx(tiles: number): Fx {
  return fxFromInt(tiles);
}

/** その地点の付近に敵の**戦闘**ユニットがいるか（いるなら攻城しない）。 */
function enemyCombatNear(ctx: AiContext, x: Fx, y: Fx, radius: Fx): boolean {
  const list = ctx.view.seenEnemies;
  const r2 = radius * radius;
  for (let k = 0; k < list.length; k++) {
    const s = list[k]!;
    if (s.kind !== EntityKind.Unit) continue;
    if (unitDef(s.typeId).lineIdx === 0) continue; // 村人・斥候・伝令は守り手ではない
    if (distSq(x, y, s.x, s.y) <= r2) return true;
  }
  return false;
}

/**
 * **拠点を攻め落としに行く**（`attackTarget` を出す唯一の場所）。
 *
 * ■ なぜこれが必要になったか（実測。30 分・AI 段階 4 同士 × 112 試合が**全部時間切れ**）
 * ```
 *  5分 兵 0/0  建物 8/10  町中心HP 2400/2400 敵拠点まで  -/-  マス 戦域 0
 * 15分 兵 5/7  建物 17/18 町中心HP 2400/2400 敵拠点まで 67/50 マス 戦域 0
 * 25分 兵 20/4 建物 21/17 町中心HP 2400/2400 敵拠点まで 14/137マス 戦域 1
 * 30分 兵 24/5 建物 19/14 町中心HP 2400/2400 敵拠点まで 18/107マス 戦域 1
 * ```
 * **町の中心の HP が 30 分間まったく減らない。** 兵は敵拠点の 14〜18 マスまで
 * 寄っているのに、そこで固まっていた。理由は 2 段:
 *  1. AI が出していたのは `moveUnits` と `releaseManual` だけで、
 *     `attackTarget` を一度も出していなかった（建物を名指しできなかった）。
 *  2. `pushDispatch` は目標の `ARRIVE_RADIUS`（= `front.spawnRadiusTiles` = 15 マス）まで
 *     来たら「着いた」と見なして `releaseManual` で令に返す。ところが戦域は
 *     「双方が 15 マス内に `spawnMinUnits` 体」で初めて立つので（`07§3`）、
 *     **守り手のいない拠点の前では戦域が立たず、令の受け皿が無い**。
 *     兵は令を待つ場所も攻める相手も無いまま立ち続ける。
 * 勝利条件は `03§10`「相手の町の中心をすべて破壊」なので、これでは永久に決着しない。
 *
 * ■ 判断（`07§11` の「ズルなし」の範囲内。使うのは `AiView` だけ）
 *  - 目標のそばに自軍の戦闘ユニットが `siegeMinSquads` 隊ぶん集まっている
 *    （半径は `siegeStageRadiusTiles`。15 では 18 マスで止まった兵を数え落とす）
 *  - かつ **その付近に敵の戦闘ユニットがいない**（`siegeClearRadiusTiles`）。
 *    敵兵がいるなら既存の挙動（交戦 → 戦域が立つ → 令で戦う）に任せる。
 *  - **戦域に入っている兵は 1 体も抜かない**（`frontId !== 0` を外す）。
 *    戦っている隊から兵を引き抜くと戦域が崩れる。
 *
 * ■ APM（`07§11` / `tests/balance/apm.test.ts`）
 * 命令は **1 判断につき 1 件**、しかも「目標が変わった」「新しい兵が加わった」ときだけ。
 * すでに全員がその建物に就いているなら何も出さない（`memory.siegeTarget` で照合）。
 * 目標が視界から消えた（落ちた・見失った）ときだけ `releaseManual` を 1 件出して令に返す。
 */
export function pushSiege(ctx: AiContext, out: Command[]): void {
  const need = ctx.cfg.siegeMinSquads * SQUAD_MIN_UNITS;
  if (need <= 0) return; // 段階 1（素人）は拠点を攻めない（`07§11`「内政のみ」）
  const m = ctx.memory;
  const view = ctx.view;
  const stageR = tilesToFx(ctx.cfg.siegeStageRadiusTiles);
  const clearR = tilesToFx(ctx.cfg.siegeClearRadiusTiles);
  const stage2 = stageR * stageR;

  const units = combatUnits(view);
  const targets = siegeTargets(ctx);

  // 1) 目標が視界から消えた兵を令に返す（落とした建物・見失った建物の記憶を捨てる）。
  //    ここを **`releaseManual` で締める**のが大事: `manual = 1` のままだと
  //    `frontEnrollment` が編入しないので、兵が二度と戦域に入れなくなる。
  const stale: EntityId[] = [];
  for (let k = 0; k < units.length; k++) {
    const oe = units[k]!;
    const held = memGet(m.siegeTarget, oe.index);
    if (held === 0) continue;
    let stillThere = false;
    for (let t = 0; t < targets.length; t++) {
      if (targets[t]!.id === held) {
        stillThere = true;
        break;
      }
    }
    if (stillThere) continue;
    memSet(m.siegeTarget, oe.index, 0);
    const id = ctx.idOf(oe.index);
    if (id > 0) stale.push(id);
  }
  if (stale.length > 0) out.push({ t: 'releaseManual', p: ctx.playerId, units: stale });

  // 2) 攻める建物を 1 つ選ぶ（優先度順に見て、条件を満たす最初のもの）。
  for (let t = 0; t < targets.length; t++) {
    const tg = targets[t]!;
    // 守り手がいるなら攻城しない（交戦と戦域の既存の流れを壊さない）。
    if (enemyCombatNear(ctx, tg.x, tg.y, clearR)) continue;

    // そばに集まっている手空きの兵（index 昇順。`combatUnits` がその順に返す）。
    const nearIdx: number[] = [];
    for (let k = 0; k < units.length; k++) {
      const oe = units[k]!;
      if (oe.frontId !== 0) continue; // 戦っている兵は抜かない
      const id = ctx.idOf(oe.index);
      if (id <= 0) continue;
      // **一度送って着いた兵だけ**（`pushDispatch` が令に返した兵）を攻城に使う。
      //
      // ここを「手空きの兵すべて」にすると、拠点で生産した直後の兵まで
      // 攻城に取られ、`pushDispatch` の派遣と `planDecoy` の囮が動かなくなる
      // （実測: `tests/unit/ai.front.test.ts` の囮のテストが 2 隊 → 0 隊になった）。
      // 攻める順は「送る（`moveUnits`）→ 着く（`releaseManual`）→ 攻める（`attackTarget`）」。
      if (memGet(m.released, oe.index) !== id) continue;
      if (distSq(oe.x, oe.y, tg.x, tg.y) > stage2) continue;
      nearIdx.push(oe.index);
    }
    if (nearIdx.length < need) continue;

    // まだこの建物に就いていない兵だけに命じる（同じ命令を出し直さない = APM を食わない）。
    const ids: EntityId[] = [];
    const idx: number[] = [];
    for (let k = 0; k < nearIdx.length; k++) {
      const i = nearIdx[k]!;
      if (memGet(m.siegeTarget, i) === tg.id) continue;
      ids.push(ctx.idOf(i));
      idx.push(i);
    }
    // 全員すでに攻城中 → 命令は出さない（攻城は続いている）。
    if (ids.length === 0) return;
    for (let k = 0; k < idx.length; k++) memSet(m.siegeTarget, idx[k]!, tg.id);
    out.push({
      t: 'attackTarget',
      p: ctx.playerId,
      units: ids,
      target: tg.id,
    });
    return; // 1 判断 1 目標
  }

  // 3) 攻める建物が 1 件も見えていない → **敵の拠点へ寄せ直す**（進軍）。
  pushSiegeMarch(ctx, units, out);
}

/**
 * **敵の拠点へ進軍する**（攻城の前段）。
 *
 * ■ なぜ必要か（これが無いと攻城の判断が一度も働かない。実測で確認済み）
 * `pushDispatch` は兵を「いちばん近い攻撃目標」へ 1 度だけ送り、
 * `ARRIVE_RADIUS`（= `front.spawnRadiusTiles` = 15 マス）まで来たら `releaseManual` で
 * 令に返す。ところが:
 *  - いちばん近い目標は多くの場合**自陣の近くをうろつく敵の兵**なので、
 *    軍は敵の拠点へ向かわない（実測で敵拠点まで 67 / 107 マスに散っていた）。
 *  - 15 マス手前で令に返された兵は、**戦域が立たないので受け皿が無く**そこで止まる。
 *    ユニットの視界は 4〜6 マスなので、15 マス先の町の中心は**視界に入らない**
 *    ―― 実測で `seenEnemies` に町の中心が 30 分間 1 度も現れなかった。
 *    名指しできない建物は攻められない（`attackTarget` は `EntityId` を要る）。
 *
 * そこで「返されたまま手が空いている兵」を**敵の開始位置**へまとめて送り直す。
 * 開始位置（`AiView.map.starts`）は人間も知っている情報で（`07§13` のマップの席）、
 * `attackTargets` も既に候補に入れている ―― 新しく覗く情報は無い。
 * 拠点まで歩けば周りの建物が視界に入り、そこから 2) の攻城が働く。
 *
 * APM: 送るのは**まだその拠点へ向けていない兵だけ**なので、1 拠点につき実質 1 回。
 */
function pushSiegeMarch(ctx: AiContext, units: readonly OwnEntity[], out: Command[]): void {
  const need = ctx.cfg.siegeMinSquads * SQUAD_MIN_UNITS;
  const m = ctx.memory;
  const base = nearestEnemyBase(ctx);
  if (base === null) return;

  const ids: EntityId[] = [];
  const idx: number[] = [];
  for (let k = 0; k < units.length; k++) {
    const oe = units[k]!;
    if (oe.frontId !== 0) continue; // 戦っている兵は抜かない（戦域を崩さない）
    if (memGet(m.siegeTarget, oe.index) !== 0) continue; // 攻城中
    const id = ctx.idOf(oe.index);
    if (id <= 0) continue;
    // **一度送って返された兵だけ**を対象にする（= 目標に着いて手が空いている兵）。
    // まだ移動中の兵を横取りすると、`pushDispatch` の派遣と喧嘩して往復する。
    if (memGet(m.released, oe.index) !== id) continue;
    // すでにこの拠点へ向けてある兵は数えるが命じ直さない（APM を食わない）。
    if (memGet(m.dispatchX, oe.index) === base.x && memGet(m.dispatchY, oe.index) === base.y) {
      idx.push(-1);
      continue;
    }
    ids.push(id);
    idx.push(oe.index);
  }
  // 拠点に殴り込むのだから、戦域 1 本ぶんでは足りない（攻城と同じ人数を要求する）。
  if (idx.length < need) return;
  if (ids.length === 0) return; // 全員すでに進軍中
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]!;
    if (i < 0) continue;
    memSet(m.dispatched, i, ctx.idOf(i));
    memSet(m.dispatchX, i, base.x);
    memSet(m.dispatchY, i, base.y);
  }
  out.push({ t: 'moveUnits', p: ctx.playerId, units: ids, x: base.x, y: base.y, queued: false });
}

/**
 * 味方でないプレイヤーの開始位置のうち、**自軍の町の中心にいちばん近いもの**。
 * 全順序: 平方距離昇順 → 席番号（`starts` の index）昇順。
 */
function nearestEnemyBase(ctx: AiContext): { x: Fx; y: Fx } | null {
  const view = ctx.view;
  const tc = findTownCenter(ctx);
  const ox = tc === null ? 0 : tc.x;
  const oy = tc === null ? 0 : tc.y;
  const starts = view.map.starts;
  let bx = 0;
  let by = 0;
  let best = -1;
  for (let p = 0; p * 2 + 1 < starts.length; p++) {
    const sx = starts[p * 2]!;
    const sy = starts[p * 2 + 1]!;
    if (sx === 0 && sy === 0) continue; // 未使用の席
    if (view.isAlly(p as never)) continue;
    const d = distSq(ox, oy, sx, sy);
    if (best >= 0 && d >= best) continue; // 同値は席番号の小さい方（先に見た方）
    best = d;
    bx = sx;
    by = sy;
  }
  return best < 0 ? null : { x: bx, y: by };
}

/** 攻城に就いている兵の数（テストと HUD の検証用）。 */
export function siegeCount(ctx: AiContext): number {
  const m = ctx.memory;
  let n = 0;
  for (let i = 0; i < m.siegeTarget.length; i++) if (memGet(m.siegeTarget, i) !== 0) n++;
  return n;
}

/**
 * 手空きの兵を前に出し、着いた兵を令の管理下に戻す。
 *
 * `moveUnits` は `manual = 1` を立てるので、そのままでは戦域に編入されない
 * （`front.enrollSkipManual`）。**着いたら `releaseManual` を出す**ことで
 * 「歩かせるのは手で、戦うのは令で」という `07§11` の建前を守る。
 */
function pushDispatch(ctx: AiContext, out: Command[]): void {
  const m = ctx.memory;
  const view = ctx.view;
  const units = combatUnits(view);
  const targets = attackTargets(ctx);

  // 1) 着いた兵を令に返す。
  //    **攻城中の兵は対象外。** `releaseManual` は `manual` を下ろすので、
  //    攻城中に掛けると目標を忘れて建物を殴るのをやめてしまう（`pushSiege` の注記）。
  const release: number[] = [];
  for (let k = 0; k < units.length; k++) {
    const oe = units[k]!;
    if (memGet(m.siegeTarget, oe.index) !== 0) continue;
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    if (memGet(m.dispatched, oe.index) !== id) continue;
    if (memGet(m.released, oe.index) === id) continue; // もう返してある
    const tx = memGet(m.dispatchX, oe.index);
    const ty = memGet(m.dispatchY, oe.index);
    if (distSq(oe.x, oe.y, tx, ty) > ARRIVE_RADIUS * ARRIVE_RADIUS) continue;
    release.push(id);
    // `dispatched` は消さない。消すと「未派遣」に見えて毎回送り直してしまう。
    memSet(m.released, oe.index, id);
  }
  if (release.length > 0) out.push({ t: 'releaseManual', p: ctx.playerId, units: release });

  // 2) まだ送っていない兵を集める（戦域に入っている兵は令に任せる）。
  if (targets.length === 0) return;
  const idle: number[] = [];
  for (let k = 0; k < units.length; k++) {
    const oe = units[k]!;
    if (oe.frontId !== 0) continue;
    if (memGet(m.siegeTarget, oe.index) !== 0) continue; // 攻城中の兵は動かさない
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    if (memGet(m.dispatched, oe.index) === id) continue;
    idle.push(oe.index);
  }
  // 戦域にならない人数では出さない（`front.spawnMinUnits`）。
  if (idle.length < SQUAD_MIN_UNITS) return;

  // 囮を使う段階（`allowDecoy`）は、本命 1 隊ぶんに加えて囮 1 隊ぶんが揃ったときだけ
  // 囮用の兵を残す。**本命を削って囮を出すことはしない**（囮に本命を食わせない）。
  const reserve =
    ctx.cfg.allowDecoy && idle.length >= SQUAD_MIN_UNITS + SQUAD_MIN_UNITS ? SQUAD_MIN_UNITS : 0;
  const sendCount = idle.length - reserve;

  const target = targets[0]!;
  const ids: number[] = [];
  for (let k = 0; k < sendCount; k++) {
    const i = idle[k]!;
    const id = ctx.idOf(i);
    ids.push(id);
    memSet(m.dispatched, i, id);
    memSet(m.dispatchX, i, target.x);
    memSet(m.dispatchY, i, target.y);
  }
  out.push({ t: 'moveUnits', p: ctx.playerId, units: ids, x: target.x, y: target.y, queued: false });
}
