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

import type { CivId } from '@/shared/types';
import { CIV_IDS, EntityKind } from '@/shared/types';
import type { Command } from '@/sim/command';
import { cfgInt, cfgTiles } from '@/sim/core/config';
import {
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
import { FX_ONE, distSq, idiv } from '@/sim/core/fx';

import type { AiContext } from './AiPlayer';
import { countOwnVillagers } from './econGoals';
import { memGet, memSet } from './AiPlayer';
import type { AiView, OwnEntity } from './view';
import { canAfford, findTownCenter, placeBuildingCommand } from './econGoals';

// ---------------------------------------------------------------- データ由来の定数

/**
 * 戦域が生まれる最小人数（`front.spawnMinUnits` = 3）。
 * 「これ未満では戦域にならない」というシステム上の意味そのままで、
 *  - 攻めに出す最小の兵数
 *  - 囮の兵数（`07§11` の「少数の兵で戦域を立てる」）
 * に使う。
 */
export const SQUAD_MIN_UNITS = cfgInt('front.spawnMinUnits');

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
 *  - **推定できた敵文明が出せる役割 1 つにつき +1**（これから来る脅威）
 * 文明が推定できていなければ後者は 0 になる ―― つまり
 * **偵察していない AI は相性を読めない**（透視をしないことの裏返し）。
 */
export function readEnemy(view: AiView): EnemyRead {
  const roleWeight = new Int32Array(ROLE_COUNT);
  const civSeen = new Uint8Array(CIV_DEFS.length);
  let seenUnits = 0;

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
export function desiredRoleMix(view: AiView): Int32Array {
  const read = readEnemy(view);
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
export function producibleUnits(view: AiView): string[] {
  const civ = view.own.civ as CivId;
  const age = view.own.age;
  const out: string[] = [];
  // 共通兵（黎明の棍棒兵・狩人など。`unitTree` に載らない）。
  for (let i = 0; i < UNIT_DEFS.length; i++) {
    const u = UNIT_DEFS[i]!;
    if (u.civ !== null) continue;
    if (u.lineIdx === 0) continue; // 村人・斥候・伝令は軍事の対象外
    if (u.age > age) continue;
    out.push(u.id);
  }
  // 文明ツリーの現行段。
  const tree = civUnitsAtAge(civ, age);
  for (let i = 0; i < tree.length; i++) {
    const u = unitDefById(tree[i]!);
    if (u.age > age) continue;
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
  const mix = desiredRoleMix(ctx.view);

  // 0) **内政が立つまで兵を作らない**（`07§2` の「0〜5 分は村人だけを増やす時間」）。
  //
  // ここが無いと、同じ食料を村人と兵が取り合い、**兵が勝つ**。
  // 実測（30 分・2 人戦）で `produce` 29 件のほとんどが兵で、
  // 村人が数体しか増えず、採集量が伸びないまま時代も進まなかった。
  // 敵が見えているときは例外（襲われているのに村人を出し続けるのは不合理）。
  if (countOwnVillagers(ctx) < ctx.cfg.villagerTarget && ctx.view.seenEnemies.length === 0) {
    // 兵は作らないが、**手空きの兵を前に出す判断だけは続ける**
    // （既にいる兵を放置すると戦域が立たない）。
    pushDispatch(ctx, cmds);
    return cmds;
  }

  // 1) 兵舎・射場・厩など「作りたい兵の生産元」を建てる（1 判断 1 棟）。
  const bld = planMilitaryBuilding(ctx, mix);
  if (bld !== null) cmds.push(bld);

  // 2) 生産元ごとに、そこで作れるいちばん点数の高い兵を 1 体積む。
  pushUnitProduction(ctx, mix, cmds);

  // 3) 手空きの兵をまとめて前に出す / 到着した兵を令の管理下に戻す。
  pushDispatch(ctx, cmds);

  return cmds;
}

/**
 * 建てたい軍事建物を 1 つ選ぶ。
 * 「作りたい兵（点数順）の生産元をまだ持っていない」ものを上から。
 * 攻城工房は `allowSiege`、城は `allowDecoy`（戦域を広く使う段階）から。
 */
function planMilitaryBuilding(ctx: AiContext, mix: Int32Array): Command | null {
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
    const cmd = placeBuildingCommand(ctx, src);
    if (cmd !== null) return cmd;
  }
  return null;
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
function pushUnitProduction(ctx: AiContext, mix: Int32Array, out: Command[]): void {
  const view = ctx.view;
  if (view.own.pop >= view.own.popCap) return;
  const wanted = producibleUnits(view);
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
      if (!canAfford(view.own.resources, udef.cost)) continue;
      const s = unitScore(mix, udef.id);
      if (s > bestScore || (s === bestScore && bestId !== null && udef.index < unitDefById(bestId).index)) {
        bestScore = s;
        bestId = udef.id;
      }
    }
    if (bestId === null) continue;
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
  const release: number[] = [];
  for (let k = 0; k < units.length; k++) {
    const oe = units[k]!;
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
