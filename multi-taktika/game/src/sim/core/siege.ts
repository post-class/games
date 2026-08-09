/**
 * sim/core/siege.ts — 攻城兵器と梯子・攻城櫓の挙動（M10。`03§6` / `01` 決着は、城の前で）
 *
 * 担当マイルストーン: **M10**（T-M10-06 / 08 / 12）。
 *
 * ---- 兵器の「得意」「弱点」を兵器 ID で書かない ----
 *
 * `03§6` の 12 種は文明ごとに形が違うが、挙動の差は
 * `units.json` の `attackClass` と `traits` と攻撃力の有無で全部言い表せる。
 *
 * | 分類（判定条件） | 該当（03§6） | 得意 | 弱点 |
 * |---|---|---|---|
 * | 壁越え兵器: `carry_units` かつ atk = 0 | 井楼・攻城塔 | 歩兵を壁の向こうへ送る | **壁を壊さない**（退くと元に戻る） |
 * | 破城槌: `carry_units` かつ atk > 0 | 破城槌 | 門と建物 | 壁は苦手・野戦は無力 |
 * | 投石系: 範囲攻撃（`aoeRadius > 0`） | 投石機・大投石機・オナゲル・火箭車・簡易投石機 | **壁を崩す**・密集歩兵 | 味方も巻き込む |
 * | 直射: `pierce` かつ範囲 0 の `siege` | バリスタ・床子弩 | 兵を貫く | 建物にほとんど効かない |
 * | 火器: `attackClass = gunpowder` | 大筒・大砲 | 単発火力（塔・城） | 高価・護衛必須 |
 * | 焼き討ち隊: `anti_building` | 焼き討ち隊 | 建物を焼く | **壁は壊せない** |
 *
 * 倍率はすべて `config.json:construction.siege.*`。コードに数値リテラルは書かない。
 *
 * ---- 壁越え（T-M10-08）----
 *
 * 井楼・攻城塔は**壁を壊さない**。半径内の自軍歩兵を壁の反対側へ送るだけで、
 * 壁の HP も `Pass.Blocked` も動かさないので、兵器が退けば（あるいは倒されれば）
 * 送り込みが止まり、壁は元のまま残る（`01`「梯子 — 壁は壊れないので退くと元に戻る」）。
 * **攻城兵器は運べない**（`construction.siegePassesGateOrHoleOnly`。門か穴を使うしかない）。
 *
 * 決定論: 反復は index 昇順、発射タイミングは `tick % 間隔 === index % 間隔` の固定分散。
 */

import type { PlayerId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import type { Fx } from './fx';
import { FX_ONE, distSq, fxMul } from './fx';
import { TICK_RATE, cfgFx, cfgInt, cfgNum, cfgTiles } from './config';
import type { BuildingDef, UnitDef } from './defs';
import { unitDef } from './defs';
import { UnitState } from './entity';
import { Move, Pass, hasTerrain, inBounds, isPassableFor, tileIndex } from './terrain';
import { areAllies, type World } from './world';
import { queryCircle } from './grid';
import {
  canCarryOverWall,
  moveMaskOfUnit,
  tileCenterFx,
  tileOf,
} from './structure';
import { clearPath } from '../systems/movement';

// ---------------------------------------------------------------- 設定値

const WALL_CROSSER_VS_STRUCTURE: Fx = cfgFx('construction.siege.wallCrosserVsStructureMul');
const RAM_VS_GATE: Fx = cfgFx('construction.siege.ramVsGateMul');
const RAM_VS_BUILDING: Fx = cfgFx('construction.siege.ramVsBuildingMul');
const RAM_VS_WALL: Fx = cfgFx('construction.siege.ramVsWallMul');
const AOE_VS_WALL: Fx = cfgFx('construction.siege.aoeVsWallMul');
const DIRECT_VS_STRUCTURE: Fx = cfgFx('construction.siege.directVsStructureMul');
const ANTI_BUILDING_VS_WALL: Fx = cfgFx('construction.siege.antiBuildingVsWallMul');
const ANTI_BUILDING_VS_BUILDING: Fx = cfgFx('construction.siege.antiBuildingVsBuildingMul');
const TARGET_BONUS_WALL: Fx = cfgFx('construction.siege.targetBonusWall');
const TARGET_BONUS_GATE: Fx = cfgFx('construction.siege.targetBonusGate');
const TARGET_BONUS_BUILDING: Fx = cfgFx('construction.siege.targetBonusBuilding');

/** 壁越えで運べる歩兵を探す半径（Fx）。 */
const LADDER_RADIUS: Fx = cfgTiles('construction.ladderRadiusTiles');
/** 1 回の壁越えで運べる人数。 */
const LADDER_CARRY: number = cfgInt('construction.ladderCarryPerCross');
/** 壁越えの間隔（tick）。 */
const LADDER_TICKS: number = Math.max(
  1,
  Math.round(cfgNum('construction.ladderCrossSec') * TICK_RATE)
);
/** 越えられる壁の厚み（マス）。 */
const LADDER_MAX_THICKNESS: number = cfgInt('construction.ladderMaxWallThickness');

/** `units.json` の traits。 */
const TRAIT_CARRY_UNITS = 'carry_units';
const TRAIT_ANTI_BUILDING = 'anti_building';

/** 4 近傍（上下左右）。斜めに梯子は掛けない。 */
const DIR_X: readonly number[] = [1, -1, 0, 0];
const DIR_Y: readonly number[] = [0, 0, 1, -1];

// ---------------------------------------------------------------- 分類

/** 攻城兵器（役割で判定。人口 3 を占めるのは `units.json` の pop）。 */
export function isSiegeUnit(d: UnitDef): boolean {
  return d.role === 'siege';
}

/** 壁を越えさせる兵器（井楼・攻城塔）。運搬特性を持ち、自分では攻撃しない。 */
export function isWallCrosser(d: UnitDef): boolean {
  return d.traits.includes(TRAIT_CARRY_UNITS) && d.atk <= 0;
}

/** 破城槌（運搬特性を持ち、かつ自分で殴る）。 */
export function isRam(d: UnitDef): boolean {
  return d.traits.includes(TRAIT_CARRY_UNITS) && d.atk > 0;
}

/** 投石系（範囲攻撃で壁を崩す）。 */
export function isBombard(d: UnitDef): boolean {
  return d.aoeRadius > 0;
}

/** 直射の対兵兵器（バリスタ・床子弩）。 */
export function isDirectShooter(d: UnitDef): boolean {
  return isSiegeUnit(d) && d.pierce && d.aoeRadius <= 0 && d.attackClass !== 'gunpowder';
}

/** 焼き討ち隊（火矢で建物を焼くが壁は壊せない）。 */
export function isAntiBuilding(d: UnitDef): boolean {
  return d.traits.includes(TRAIT_ANTI_BUILDING);
}

// ---------------------------------------------------------------- 得意・弱点

/**
 * その兵が構造物に与えるダメージの倍率（Fx）。`03§6` の「得意」「弱点」の実体。
 * 1.0（`FX_ONE`）が等倍、0 は「壊せない」。
 *
 * **申し送り（combat.ts は別担当）**: `combat.dealDamage` の直前で
 * `fxMul(dmg, structureDamageMul(...))` を掛けること。今は判定だけを用意している
 * （テスト `tests/unit/siege.test.ts` が表の内容を固定している）。
 */
export function structureDamageMul(d: UnitDef, b: BuildingDef): Fx {
  const isWall = b.isWall && !b.isGate;
  if (isWallCrosser(d)) return WALL_CROSSER_VS_STRUCTURE;
  if (isAntiBuilding(d)) return isWall ? ANTI_BUILDING_VS_WALL : ANTI_BUILDING_VS_BUILDING;
  if (isRam(d)) {
    if (b.isGate) return RAM_VS_GATE;
    return isWall ? RAM_VS_WALL : RAM_VS_BUILDING;
  }
  if (isBombard(d)) return isWall ? AOE_VS_WALL : FX_ONE;
  if (isDirectShooter(d)) return DIRECT_VS_STRUCTURE;
  return FX_ONE;
}

/**
 * 「包囲」の令で構造物を狙う加点（Fx）。壊せない相手（倍率 0）には加点しない
 * ので、井楼は壁を殴りに行かず歩兵を運ぶ側に残る。
 *
 * **申し送り（unitDecision.ts は別担当）**: `scoreEnemy` の
 * `targetPriorityBonus` に足し込むと `orders.json:siege.targetPriority`
 * （`wall_gate` → `building` → `unit`）が兵器の形に応じて重み付けされる。
 */
export function siegeTargetBonus(d: UnitDef, b: BuildingDef): Fx {
  if (structureDamageMul(d, b) <= 0) return 0;
  if (b.isGate) return TARGET_BONUS_GATE;
  if (b.isWall) return TARGET_BONUS_WALL;
  return TARGET_BONUS_BUILDING;
}

// ---------------------------------------------------------------- 壁越え

/**
 * 1 tick ぶんの壁越え（T-M10-08）。
 *
 * 壁越え兵器の 4 近傍に封鎖されたマスがあれば、その先の最初の通れるマスを着地点にして、
 * 半径内の自軍歩兵を最大 `ladderCarryPerCross` 名まで運ぶ。
 * **壁には一切触らない**（HP も封鎖も変えない）ので、兵器が消えれば通り道も消える。
 *
 * @returns 運んだ人数（テストが挙動を確かめるために返す）
 */
export function crossWalls(w: World): number {
  const map = w.map;
  if (!hasTerrain(map)) return 0;
  const e = w.entities;
  const out = w.scratch.neighbors;
  const phase = w.tick % LADDER_TICKS;
  let carried = 0;

  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.state[i] === UnitState.Garrisoned || e.state[i] === UnitState.Routed) continue;
    if (!isWallCrosser(unitDef(e.typeId[i]!))) continue;
    if (i % LADDER_TICKS !== phase) continue;
    carried += crossWallsFor(w, i, out);
  }
  return carried;
}

/** 1 台ぶんの壁越え。 */
function crossWallsFor(w: World, engine: number, out: number[]): number {
  const e = w.entities;
  const map = w.map;
  const etx = tileOf(e.x[engine]!);
  const ety = tileOf(e.y[engine]!);

  // 4 近傍の封鎖マスを探し、その先の着地点を決める（方向は固定順で全順序）。
  let landX = -1;
  let landY = -1;
  for (let d = 0; d < DIR_X.length && landX < 0; d++) {
    const dx = DIR_X[d]!;
    const dy = DIR_Y[d]!;
    const wx = etx + dx;
    const wy = ety + dy;
    if (!inBounds(map, wx, wy)) continue;
    if ((map.passable[tileIndex(map, wx, wy)]! & Pass.Blocked) === 0) continue;
    // 封鎖が続くあいだ進み、その先の最初の歩ける（Land）マスが着地点。
    for (let t = 1; t <= LADDER_MAX_THICKNESS; t++) {
      const nx = etx + dx * (t + 1);
      const ny = ety + dy * (t + 1);
      if (!inBounds(map, nx, ny)) break;
      if ((map.passable[tileIndex(map, nx, ny)]! & Pass.Blocked) !== 0) continue;
      if (!isPassableFor(map, nx, ny, Move.Land)) break;
      landX = nx;
      landY = ny;
      break;
    }
  }
  if (landX < 0) return 0;

  const owner = e.owner[engine]! as PlayerId;
  const n = queryCircle(w.grid, e, e.x[engine]!, e.y[engine]!, LADDER_RADIUS, out);
  let carried = 0;
  for (let k = 0; k < n && carried < LADDER_CARRY; k++) {
    const u = out[k]!;
    if (u === engine) continue;
    if (e.kind[u] !== EntityKind.Unit) continue;
    if (e.state[u] === UnitState.Garrisoned || e.state[u] === UnitState.Routed) continue;
    const other = e.owner[u]!;
    if (other !== owner && !areAllies(w, owner, other as PlayerId)) continue;
    // 攻城兵器は運べない（門か穴を使うしかない。`07§9`）。
    if (!canCarryOverWall(w, u)) continue;
    // 徒歩のものだけ（船は論外）。
    if (moveMaskOfUnit(w, u) !== Move.Land) continue;
    // すでに壁の向こう側にいる者を運び直さない。
    if (tileOf(e.x[u]!) === landX && tileOf(e.y[u]!) === landY) continue;

    e.x[u] = tileCenterFx(landX);
    e.y[u] = tileCenterFx(landY);
    // 経路点は壁のこちら側のものなので捨てる（残すと壁に向かって戻ろうとする）。
    clearPath(e, u);
    carried++;
  }
  return carried;
}

/**
 * その地点から見て最も近い自軍の攻城兵器（包囲の護衛対象。テストと AI 用）。
 * タイブレークは「平方距離が小さい → index が小さい」。
 */
export function nearestOwnSiegeEngine(w: World, p: PlayerId, x: Fx, y: Fx): number {
  const e = w.entities;
  let best = -1;
  let bestSq = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.owner[i] !== p) continue;
    if (!isSiegeUnit(unitDef(e.typeId[i]!))) continue;
    const sq = distSq(x, y, e.x[i]!, e.y[i]!);
    if (best < 0 || sq < bestSq) {
      best = i;
      bestSq = sq;
    }
  }
  return best;
}

/** 攻城兵器 1 台が構造物に与える 1 撃のダメージ（Fx。相性・地形は含めない概算）。 */
export function siegeHitOnStructure(d: UnitDef, b: BuildingDef): Fx {
  return fxMul(d.atk, structureDamageMul(d, b));
}
