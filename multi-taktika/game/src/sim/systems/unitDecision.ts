/**
 * システム 5/14: unitDecision — 0.5 秒ごとの目標再選択（`07§5`, 実装手順書 §6.3）
 *
 * 責務:
 *  - 令（上段 + 下段）と周囲の状況から、そのユニットの目標を 1 つ選ぶ（スコア最大）。
 *  - `manual = 1` のユニットは対象外（プレイヤーの指示を上書きしない）。
 *  - 戦域外のユニットは `lastOrder`、それも無ければ既定行動「近くの敵に応戦」。
 *
 * 負荷対策の tick 分散（**この形を変えないこと**。§16-3）:
 *   `if (tick % 12 !== i % 12) continue;`  // i = エンティティ index
 *   12 tick ≒ 0.48 秒。乱数で分散させてはいけない（デシンクと挙動のばらつきの原因）。
 *
 * 担当マイルストーン: **M8/M9**（令の解釈は M9、既定行動は M7）。
 *
 * ---- スコア式（手順書 §6.3 のまま）----
 *
 *   score(candidate) =
 *       w.advance * (前進で近づける度合い)
 *     + w.hold    * (持ち場からの距離のマイナス)
 *     + w.guard   * (護衛対象への近さ)
 *     + w.build   * (建設可能地点への近さ)
 *     + w.evade   * (被弾リスクのマイナス)
 *     + counterBonus(自分の role, 相手の role)
 *     + targetPriorityBonus(令の targetPriority)
 *     - 0.2 * (他ユニットが既にその目標を選んだ数)
 *
 * 各項の定義（数値で検証できるように約束を明記する）:
 *  - **前進で近づける度合い**
 *      敵候補 … 自分からその敵までの「近さ」（近い敵ほど 1.0）。突撃が最も近い敵を選ぶ根拠。
 *      地点候補 … その地点から最寄りの敵までの「近さ」（敵に近い地点ほど 1.0）。
 *      どちらも「そこへ行けば敵に近づけるか」なので、`advance` が負（後退）のときは
 *      敵から遠い地点の得点が高くなる。
 *  - **持ち場** … 戦域の中心。戦域外なら「今いる場所」（＝ 遠くまで追わない既定行動）。
 *  - **護衛対象** … 包囲なら最寄りの自軍攻城兵器、建設なら最寄りの自軍村人。
 *  - **建設可能地点** … 最寄りの自軍の建設中の建物。
 *  - **被弾リスク** … その地点に攻撃が届く敵の数（`riskFromCount`。4 体で 1.0）。
 *
 * 候補の種類（この順に評価する。同点は敵どうしなら **index の小さい方**、
 * 敵と地点なら **敵**（先に評価するもの）が勝つ）:
 *   ① 半径内の敵 ② 持ち場 ③ 護衛対象のそば ④ 建設地 ⑤ 退路（最寄りの拠点）
 *
 * ---- 手順書 §6.3 の式に対して足した 3 つの約束（いずれも上流資料の挙動を出すため）----
 *
 *  1. **地点候補の前進項は「増分」**（その地点の敵の近さ − 今いる場所の敵の近さ）。
 *     引かないと「今いる場所」が敵候補と同じ前進量を持ち、立っているだけが最善手になる。
 *  2. **相性・対象優先の加点は、持ち場を守る令では持ち場からの近さで割り引く。**
 *     割り引かないと対象優先（最大 +1.0）が死守（最大 -1.0）を上書きして
 *     「指定地点から離れない」（`07§5`）が壊れる。
 *  3. **後退の令（前進が負で持ち場を持たない）は持ち場そのものを最寄りの拠点に置き換える。**
 *     敵が見えなくなった後も「最寄りの拠点まで下がる」を続けるため。
 *
 * 決定論: 反復は index 昇順、候補の順序は固定、乱数は 1 度も使わない。
 */

import type { PlayerId } from '@/shared/types';
import { EntityKind, INVALID_ENTITY, NEUTRAL_OWNER } from '@/shared/types';
import { UnitState, entityIndex, idOfIndex, isAlive } from '../core/entity';
import type { Entities } from '../core/entity';
import type { Fx } from '../core/fx';
import { FX_ONE, fxMul, fxToInt, isqrt } from '../core/fx';
import { PROGRESS_DONE } from '../core/effects';
import { buildingDef, roleToIndex, unitDef } from '../core/defs';
import { cellCol, cellRow } from '../core/grid';
import { rangeWithTerrain } from '../core/damage';
import { isForest } from '../core/terrain';
import {
  AVOID_COMBAT_PENALTY,
  DECISION_RADIUS,
  DEFAULT_DECISION_RADIUS,
  LINE_OF_FIRE_PENALTY,
  LINE_OF_FIRE_WIDTH,
  Tag,
  approachPoint,
  closenessFx,
  counterBonus,
  crowdPenalty,
  distFx,
  homeCampX,
  homeCampY,
  isSiegeRole,
  isTradeCartIndex,
  isVillagerRole,
  nearSegment,
  normDistFx,
  resolveOrderForUnit,
  riskFromCount,
  sideStepPoint,
  standoffFor,
  tagsOfTarget,
  targetPriorityBonus,
  type OrderWeights,
  type ResolvedOrder,
} from '../core/order';
import { areAllies, getFront, type Front, type World } from '../core/world';

/** 判断の分散周期（tick）。0.5 秒 ≒ 12 tick。 */
export const DECISION_PERIOD_TICKS = 12;

/** 1 回の判断で見る敵の上限。溢れた分は index の大きい方を捨てる（決定論のため固定）。 */
const MAX_ENEMIES = 96;

/** 射線を空ける相手（味方の投石手）の上限。 */
const MAX_SHOOTERS = 8;

/** 範囲攻撃で味方も削る trait（`combat.ts` と同じ語）。 */
const TRAIT_FRIENDLY_FIRE = 'friendly_fire';

/** 相性表の `building` 行（建物を殴るときの防御側 role。すべて等倍）。 */
const BUILDING_ROLE = roleToIndex('building');

// ---------------------------------------------------------------------------
// 作業領域（**状態ではない**ので World には持たない = ハッシュ対象外）
// ---------------------------------------------------------------------------

interface Scratch {
  /** 候補になり得る敵の index（昇順）。 */
  readonly enemies: Int32Array;
  enemyCount: number;
  /** 味方の投石手（射線を空ける対象）の index。 */
  readonly shooters: Int32Array;
  shooterCount: number;
  /** 近傍のうち自軍のユニット・建物の index（護衛対象と建設地の探索用）。 */
  readonly own: Int32Array;
  ownCount: number;
  /** 「その目標を既に選んだ数」。添字 = 目標の entity index。 */
  readonly claims: Int32Array;
  /** claims のうち 0 でない添字（毎 tick の先頭で戻すため）。 */
  readonly claimed: number[];
}

const scratches = new WeakMap<Entities, Scratch>();

function getScratch(e: Entities): Scratch {
  const hit = scratches.get(e);
  if (hit !== undefined) return hit;
  const s: Scratch = {
    enemies: new Int32Array(MAX_ENEMIES),
    enemyCount: 0,
    shooters: new Int32Array(MAX_SHOOTERS),
    shooterCount: 0,
    own: new Int32Array(MAX_ENEMIES),
    ownCount: 0,
    claims: new Int32Array(e.capacity),
    claimed: [],
  };
  scratches.set(e, s);
  return s;
}

/** 目標の重複カウントを 0 に戻す（触った所だけ）。 */
function resetClaims(s: Scratch): void {
  for (let k = 0; k < s.claimed.length; k++) s.claims[s.claimed[k]!] = 0;
  s.claimed.length = 0;
}

/**
 * 1 体を評価している間だけ有効な文脈。**毎 tick 作り直さない**
 * （400 体 / 12 tick = 33 体ぶんのオブジェクト生成を避ける）。
 */
interface Ctx {
  w: World;
  /** 評価対象の index。 */
  i: number;
  /** 合成後の重み（`siegeLead` の補正を織り込んだもの）。 */
  weights: OrderWeights;
  /** 持ち場。 */
  holdX: Fx;
  holdY: Fx;
  /** 護衛対象の index（-1 = なし）。 */
  guardIdx: number;
  /** 建設地の index（-1 = なし）。 */
  buildIdx: number;
  /** 自分の攻撃が届く距離（Fx。近接は 0）。 */
  reach: Fx;
  /** 自分の role。 */
  selfRole: number;
  /** 略奪の「戦闘ユニットを避ける」。 */
  avoidCombatUnits: boolean;
  /** 令の対象優先。 */
  targetPriority: readonly string[];
  /** 今いる場所から見た「敵の近さ」（地点候補の前進量の基準）。 */
  selfThreatCloseness: Fx;
  s: Scratch;
}

const ctx: Ctx = {
  w: null as unknown as World,
  i: -1,
  weights: { advance: 0, hold: 0, guard: 0, build: 0, evade: 0 },
  holdX: 0,
  holdY: 0,
  guardIdx: -1,
  buildIdx: -1,
  reach: 0,
  selfRole: 0,
  avoidCombatUnits: false,
  targetPriority: [],
  selfThreatCloseness: 0,
  s: null as unknown as Scratch,
};

/** 移動先の受け皿（毎回作らない）。 */
const destPoint = { x: 0 as Fx, y: 0 as Fx };

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export function unitDecision(w: World): void {
  const e = w.entities;
  const s = getScratch(e);
  const phase = w.tick % DECISION_PERIOD_TICKS;
  // 「他ユニットが既にその目標を選んだ数」は **12 tick の 1 周期ぶん**ためる。
  // 毎 tick 消すと 1/12 のユニットしか互いを見られず、集中しすぎ防止が効かない。
  if (phase === 0) resetClaims(s);
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (i % DECISION_PERIOD_TICKS !== phase) continue;
    decideForUnit(w, i, s);
  }
}

/**
 * 判断の対象外か。
 *  - `manual = 1` … プレイヤーが手で動かしている（`07§5`。T-M9-09）
 *  - 収容中 / 士気 0 の退却中 … 別のシステムが動かしている
 *  - 交易荷車 … `economy` の担当
 */
function skipUnit(w: World, i: number): boolean {
  const e = w.entities;
  if (e.manual[i] === 1) return true;
  const st = e.state[i]!;
  if (st === UnitState.Garrisoned || st === UnitState.Routed) return true;
  if (isTradeCartIndex(e, i)) return true;
  return false;
}

/** `frontId`（1..6, 0 = 所属なし）から Front を引く。 */
function frontOf(w: World, owner: PlayerId, frontId: number): Front | null {
  if (frontId <= 0) return null;
  const f = getFront(w, owner, frontId);
  if (f === undefined || !f.active) return null;
  return f;
}

function decideForUnit(w: World, i: number, s: Scratch): void {
  if (skipUnit(w, i)) return;

  const e = w.entities;
  const owner = e.owner[i]! as PlayerId;
  const front = frontOf(w, owner, e.frontId[i]!);
  const ro = resolveOrderForUnit(w, i, front);

  // 戦域から令が届いているあいだ、ユニット側に控えを残す。
  // 戦域が閉じた後もこの令の挙動を続ける（`07§3`「最後の令を保持して待機」）。
  // `lastOrder` は 1 枠しかないので、二重旗のときは**上段**を控える。
  if (ro.fromFront) {
    const keep = ro.upper ?? ro.lower;
    if (keep !== null) e.lastOrder[i] = keep.index + 1;
  }

  const d = unitDef(e.typeId[i]!);

  // 村人は経済（M4）が動かしている。判断エンジンが割り込むのは
  // **建設の令を受けていて、かつ手が空いているとき**だけ（`07§5` 建設）。
  // ここを緩めると採集の往復（Gathering / Hauling / Moving）が 0.5 秒ごとに壊れる。
  if (isVillagerRole(d.roleIdx)) {
    if (ro.weights.build <= 0) return;
    const st = e.state[i]!;
    if (st !== UnitState.Idle && st !== UnitState.Building) return;
  }

  collectNeighbors(w, i, ro, s);

  // ---- 文脈を組む ----
  ctx.w = w;
  ctx.i = i;
  ctx.s = s;
  ctx.weights.advance = ro.weights.advance;
  ctx.weights.hold = ro.weights.hold;
  ctx.weights.guard = ro.weights.guard;
  ctx.weights.build = ro.weights.build;
  ctx.weights.evade = ro.weights.evade;
  // 包囲: 攻城兵器の前進を優先する（`07§5`「兵器が前、歩兵が周囲」）。
  if (ro.siegeLead && isSiegeRole(d.roleIdx) && ctx.weights.advance < FX_ONE) {
    ctx.weights.advance = FX_ONE;
  }
  // 持ち場。遊撃（crossFront）は戦域の枠を越えて動き続けるので持ち場に縛られない。
  ctx.holdX = front !== null && !ro.crossFront ? front.x : e.x[i]!;
  ctx.holdY = front !== null && !ro.crossFront ? front.y : e.y[i]!;
  // **後退の令（前進が負で持ち場を持たない）は「持ち場」そのものが最寄りの拠点になる。**
  // 「戦いながら最寄りの拠点まで下がる」（`07§5`）を、敵が見えなくなった後も続けるため。
  if (ctx.weights.advance < 0 && ctx.weights.hold <= 0) {
    ctx.holdX = homeCampX(w, owner);
    ctx.holdY = homeCampY(w, owner);
  }
  ctx.guardIdx = findGuardSubject(w, i, ro, s);
  ctx.buildIdx = findBuildSite(w, i, s);
  ctx.selfRole = d.roleIdx;
  ctx.avoidCombatUnits = ro.avoidCombatUnits;
  ctx.targetPriority = ro.targetPriority;
  // 森の中の遠隔は射程 −25%（`07§6`）。
  ctx.reach =
    d.range > 0
      ? rangeWithTerrain(d.range, isForest(w.map, fxToInt(e.x[i]!), fxToInt(e.y[i]!)), true)
      : 0;

  ctx.selfThreatCloseness = closenessFx(nearestEnemyDist(e.x[i]!, e.y[i]!), DECISION_RADIUS);

  // 敵も護衛対象も建設地も無いなら、比べる相手がいない = 持ち場に構えるだけ。
  // 令の無い兵が大量に待機している局面（試合の大半）をここで打ち切る（負荷対策）。
  if (s.enemyCount === 0 && ctx.guardIdx < 0 && ctx.buildIdx < 0) {
    applyDecision(w, i, -1, ctx.holdX, ctx.holdY, ctx.weights.advance, d.range, s);
    return;
  }

  // ---- 候補を評価する ----
  let bestScore: Fx = 0;
  let bestTarget = -1;
  let bestX: Fx = e.x[i]!;
  let bestY: Fx = e.y[i]!;
  let found = false;

  // ① 半径内の敵（index 昇順）
  for (let k = 0; k < s.enemyCount; k++) {
    const t = s.enemies[k]!;
    const sc = scoreEnemy(t);
    // 同点は **index の小さい方**（走査順に依存しない全順序。§16-2 と同じ考え方）。
    if (!found || sc > bestScore || (sc === bestScore && t < bestTarget)) {
      found = true;
      bestScore = sc;
      bestTarget = t;
      bestX = e.x[t]!;
      bestY = e.y[t]!;
    }
  }

  // ② 持ち場（動かずに構える）
  {
    const sc = scorePoint(ctx.holdX, ctx.holdY);
    if (!found || sc > bestScore) {
      found = true;
      bestScore = sc;
      bestTarget = -1;
      bestX = ctx.holdX;
      bestY = ctx.holdY;
    }
  }

  // ③ 護衛対象のそば（投石手を護衛するときは射線から横にずれる）
  if (ctx.guardIdx >= 0 && ctx.weights.guard > 0) {
    guardStandPoint(w, i, ctx.guardIdx, destPoint);
    const gx = destPoint.x;
    const gy = destPoint.y;
    const sc = scorePoint(gx, gy);
    if (sc > bestScore) {
      bestScore = sc;
      bestTarget = -1;
      bestX = gx;
      bestY = gy;
    }
  }

  // ④ 建設地
  if (ctx.buildIdx >= 0 && ctx.weights.build > 0) {
    const bx = e.x[ctx.buildIdx]!;
    const by = e.y[ctx.buildIdx]!;
    const sc = scorePoint(bx, by);
    if (sc > bestScore) {
      bestScore = sc;
      bestTarget = -1;
      bestX = bx;
      bestY = by;
    }
  }

  // ⑤ 退路（最寄りの拠点。「戦いながら最寄りの拠点まで下がる」）
  {
    const hx = homeCampX(w, owner);
    const hy = homeCampY(w, owner);
    const sc = scorePoint(hx, hy);
    if (sc > bestScore) {
      bestScore = sc;
      bestTarget = -1;
      bestX = hx;
      bestY = hy;
    }
  }

  applyDecision(w, i, bestTarget, bestX, bestY, ctx.weights.advance, d.range, s);
}

// ---------------------------------------------------------------------------
// スコア
// ---------------------------------------------------------------------------

/** 敵候補のスコア。 */
function scoreEnemy(t: number): Fx {
  const e = ctx.w.entities;
  const i = ctx.i;
  const tx = e.x[t]!;
  const ty = e.y[t]!;
  const dSelf = distFx(e.x[i]!, e.y[i]!, tx, ty);

  // ① 前進で近づける度合い = 自分からその敵までの近さ
  let sc = fxMul(ctx.weights.advance, closenessFx(dSelf, DECISION_RADIUS));
  sc += commonTerms(tx, ty);

  // 目標に依存する加点
  let tags = tagsOfTarget(e, t);
  if (ctx.reach > 0 ? dSelf <= ctx.reach : dSelf <= FX_ONE) tags |= Tag.InRange;
  // 相性と対象優先は「どれを狙うか」の加点。**持ち場を守る令では、持ち場から
  // 遠い目標ほど狙う価値を下げる**（そうしないと対象優先の加点が死守を上書きして
  // 「持ち場から離れない」が壊れる。`07§5` 死守 / 死守+包囲）。
  let bonus = counterBonus(ctx.selfRole, roleOfTarget(e, t));
  bonus += targetPriorityBonus(ctx.targetPriority, tags);
  if (ctx.weights.hold > 0) {
    bonus = fxMul(bonus, closenessFx(distFx(ctx.holdX, ctx.holdY, tx, ty), DECISION_RADIUS));
  }
  sc += bonus;
  sc -= crowdPenalty(ctx.s.claims[t]!);
  // 略奪: 戦闘ユニットを避けて回り込む（`orders.json` の `avoidCombatUnits`）。
  if (ctx.avoidCombatUnits && isCombatUnit(e, t)) sc -= AVOID_COMBAT_PENALTY;
  return sc;
}

/**
 * 地点候補（目標を取らずにそこへ行く）のスコア。
 *
 * 前進の項は「その地点の敵の近さ **− 今いる場所の敵の近さ**」= 前進で稼げる増分。
 * これを引かないと「今いる場所」が常に敵候補と同じ前進量を持ってしまい、
 * 立っているだけが最善手になる（後退の令も動かなくなる）。
 */
function scorePoint(px: Fx, py: Fx): Fx {
  const gain = closenessFx(nearestEnemyDist(px, py), DECISION_RADIUS) - ctx.selfThreatCloseness;
  return fxMul(ctx.weights.advance, gain) + commonTerms(px, py);
}

/** 敵候補・地点候補で共通の項（②〜⑥）。 */
function commonTerms(px: Fx, py: Fx): Fx {
  const e = ctx.w.entities;
  let sc: Fx = 0;

  // ② 持ち場からの距離のマイナス
  if (ctx.weights.hold !== 0) {
    const dHold = distFx(ctx.holdX, ctx.holdY, px, py);
    sc -= fxMul(ctx.weights.hold, normDistFx(dHold, DECISION_RADIUS));
  }
  // ③ 護衛対象への近さ
  if (ctx.weights.guard !== 0 && ctx.guardIdx >= 0) {
    const dg = distFx(e.x[ctx.guardIdx]!, e.y[ctx.guardIdx]!, px, py);
    sc += fxMul(ctx.weights.guard, closenessFx(dg, DECISION_RADIUS));
  }
  // ④ 建設可能地点への近さ
  if (ctx.weights.build !== 0 && ctx.buildIdx >= 0) {
    const db = distFx(e.x[ctx.buildIdx]!, e.y[ctx.buildIdx]!, px, py);
    sc += fxMul(ctx.weights.build, closenessFx(db, DECISION_RADIUS));
  }
  // ⑤ 被弾リスクのマイナス
  if (ctx.weights.evade !== 0) {
    sc -= fxMul(ctx.weights.evade, riskFromCount(threatCount(px, py)));
  }
  // ⑥ 投石系の射線に立たない（`07§5` 包囲 / `07§6` 友軍被害）
  if (ctx.s.shooterCount > 0 && onFriendlyLineOfFire(px, py)) sc -= LINE_OF_FIRE_PENALTY;

  return sc;
}

/** その地点から最寄りの敵までの距離（Fx）。敵がいなければ探索半径（= 近さ 0）。 */
function nearestEnemyDist(px: Fx, py: Fx): Fx {
  const e = ctx.w.entities;
  const s = ctx.s;
  let bestSq = -1;
  for (let k = 0; k < s.enemyCount; k++) {
    const t = s.enemies[k]!;
    const dx = e.x[t]! - px;
    const dy = e.y[t]! - py;
    const sq = dx * dx + dy * dy;
    if (bestSq < 0 || sq < bestSq) bestSq = sq;
  }
  if (bestSq < 0) return DECISION_RADIUS;
  return isqrt(bestSq);
}

/** その地点に攻撃が届く敵の数（被弾リスクの材料）。 */
function threatCount(px: Fx, py: Fx): number {
  const e = ctx.w.entities;
  const s = ctx.s;
  let count = 0;
  for (let k = 0; k < s.enemyCount; k++) {
    const t = s.enemies[k]!;
    if (e.kind[t] !== EntityKind.Unit) continue;
    const d = unitDef(e.typeId[t]!);
    if (d.atk <= 0) continue;
    // 近接は 1 マスで届く（`combat.meleeReachTiles` と同じ扱い）。
    const reach = d.range > 0 ? d.range : FX_ONE;
    const dx = e.x[t]! - px;
    const dy = e.y[t]! - py;
    if (dx * dx + dy * dy <= reach * reach) count++;
  }
  return count;
}

/** 味方の投石手の射線上か（`07§5`「投石系は射線に味方を置かない」）。 */
function onFriendlyLineOfFire(px: Fx, py: Fx): boolean {
  const e = ctx.w.entities;
  const s = ctx.s;
  for (let k = 0; k < s.shooterCount; k++) {
    const sh = s.shooters[k]!;
    if (sh === ctx.i) continue;
    const tid = e.target[sh]!;
    if (!isAlive(e, tid)) continue;
    const ti = entityIndex(tid);
    if (nearSegment(px, py, e.x[sh]!, e.y[sh]!, e.x[ti]!, e.y[ti]!, LINE_OF_FIRE_WIDTH)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 周囲の収集
// ---------------------------------------------------------------------------

/**
 * 判断に使う近傍を集める。
 *
 * **`queryCircle` を使わずグリッドのセルを直接走査する。** queryCircle は
 * 「全件を配列に積んで index 昇順へ整列」するので、1600 体が密に並ぶと
 * 整列だけで unitDecision の支配的コストになる（実測 470 → 1300 tick/s の差）。
 * `combat.findNearestEnemy` と同じ方針。
 *
 * 走査順はセルの並び順（index 昇順ではない）になるが、
 * **候補の比較を `(スコア, index)` の全順序にしてある**ので結果は走査順に依存しない。
 *
 * `wantOwn` は「護衛 / 建設の重みがあるときだけ自軍も集める」ためのスイッチ。
 * 令が無いユニット（既定重み）では自軍を数える必要がないので、その分を丸ごと省く。
 */
function collectNeighbors(w: World, i: number, ro: ResolvedOrder, s: Scratch): void {
  const e = w.entities;
  const g = w.grid;
  const cx = e.x[i]!;
  const cy = e.y[i]!;
  // 遊撃は戦域を跨いで動くので見る範囲も広い（`orders.json` の `crossFront`）。
  // 令を受けていない兵は「近くの敵に応戦」だけなので狭く見る。
  const radius = ro.crossFront
    ? DECISION_RADIUS * 2
    : ro.upper === null && ro.lower === null
      ? DEFAULT_DECISION_RADIUS
      : DECISION_RADIUS;
  const rr = radius * radius;
  const wantOwn = ro.weights.guard > 0 || ro.weights.build > 0;
  const owner = e.owner[i]!;

  s.enemyCount = 0;
  s.shooterCount = 0;
  s.ownCount = 0;

  const c0 = cellCol(g, cx - radius);
  const c1 = cellCol(g, cx + radius);
  const r0 = cellRow(g, cy - radius);
  const r1 = cellRow(g, cy + radius);

  for (let row = r0; row <= r1; row++) {
    const base = row * g.cols;
    for (let col = c0; col <= c1; col++) {
      const cell = base + col;
      const end = g.cellStart[cell + 1]!;
      for (let k = g.cellStart[cell]!; k < end; k++) {
        const t = g.items[k]!;
        if (t === i) continue;
        if (e.alive[t] !== 1) continue;
        const dx = e.x[t]! - cx;
        const dy = e.y[t]! - cy;
        if (dx * dx + dy * dy > rr) continue;
        const other = e.owner[t]!;
        if (other === NEUTRAL_OWNER) continue;
        if (other === owner || areAllies(w, owner, other)) {
          if (!wantOwn) continue;
          if (other === owner && s.ownCount < s.own.length) s.own[s.ownCount++] = t;
          if (s.shooterCount < MAX_SHOOTERS && isFriendlyFireShooter(e, t)) {
            s.shooters[s.shooterCount++] = t;
          }
          continue;
        }
        if (!isTargetable(e, t)) continue;
        if (s.enemyCount < MAX_ENEMIES) s.enemies[s.enemyCount++] = t;
      }
    }
  }
}

/**
 * 自動で狙える相手か。
 * **井戸・種籾蔵は含めない**（`buildingDef.autoTargetable === false`。
 * 掟破りは手動選択時のみ。§16-7 / `03§3`）。
 */
function isTargetable(e: Entities, t: number): boolean {
  const kind = e.kind[t]!;
  if (kind === EntityKind.Unit) return true;
  if (kind === EntityKind.Building || kind === EntityKind.Attachment) {
    return buildingDef(e.typeId[t]!).autoTargetable;
  }
  return false;
}

/** 戦闘ユニットか（略奪が避ける相手）。村人と攻撃力 0 の支援は含まない。 */
function isCombatUnit(e: Entities, t: number): boolean {
  if (e.kind[t] !== EntityKind.Unit) return false;
  const d = unitDef(e.typeId[t]!);
  if (isVillagerRole(d.roleIdx)) return false;
  return d.atk > 0;
}

/** 範囲攻撃で味方も削るユニットか（投石系）。 */
function isFriendlyFireShooter(e: Entities, t: number): boolean {
  if (e.kind[t] !== EntityKind.Unit) return false;
  const d = unitDef(e.typeId[t]!);
  return d.aoeRadius > 0 && d.traits.includes(TRAIT_FRIENDLY_FIRE);
}

/** 目標の role（建物は相性表の `building` 行 = 等倍）。 */
function roleOfTarget(e: Entities, t: number): number {
  if (e.kind[t] === EntityKind.Unit) return unitDef(e.typeId[t]!).roleIdx;
  return BUILDING_ROLE;
}

/**
 * 護衛対象。
 *  - 包囲（`siegeLead` / `followSiege`）で自分が兵器でなければ **最寄りの自軍攻城兵器**。
 *    これが「兵器が下がると歩兵も下がる」の実体（護衛対象の位置が下がれば得点も動く）。
 *  - それ以外で `guard` があるなら **最寄りの自軍村人**（建設の令の「兵は村人の護衛」）。
 * 見つからなければ -1。
 */
function findGuardSubject(w: World, i: number, ro: ResolvedOrder, s: Scratch): number {
  if (ro.weights.guard <= 0) return -1;
  const e = w.entities;
  const selfRole = unitDef(e.typeId[i]!).roleIdx;

  let bestSiege = -1;
  let bestSiegeSq = 0;
  let bestVill = -1;
  let bestVillSq = 0;

  for (let k = 0; k < s.ownCount; k++) {
    const t = s.own[k]!;
    if (e.kind[t] !== EntityKind.Unit) continue;
    const d = unitDef(e.typeId[t]!);
    const dx = e.x[t]! - e.x[i]!;
    const dy = e.y[t]! - e.y[i]!;
    const sq = dx * dx + dy * dy;
    if (isSiegeRole(d.roleIdx)) {
      if (bestSiege < 0 || sq < bestSiegeSq) {
        bestSiege = t;
        bestSiegeSq = sq;
      }
    } else if (isVillagerRole(d.roleIdx)) {
      if (bestVill < 0 || sq < bestVillSq) {
        bestVill = t;
        bestVillSq = sq;
      }
    }
  }

  if (isSiegeRole(selfRole)) return -1; // 兵器は護衛されるがわ
  if ((ro.siegeLead || ro.followSiege) && bestSiege >= 0) return bestSiege;
  if (!isVillagerRole(selfRole) && bestVill >= 0) return bestVill;
  if (bestSiege >= 0) return bestSiege;
  return -1;
}

/** 最寄りの自軍の建設中の建物（`buildProgress` が未完了）。無ければ -1。 */
function findBuildSite(w: World, i: number, s: Scratch): number {
  const e = w.entities;
  let best = -1;
  let bestSq = 0;
  for (let k = 0; k < s.ownCount; k++) {
    const t = s.own[k]!;
    if (e.kind[t] !== EntityKind.Building) continue;
    // 完成の印は `buildProgress = PROGRESS_DONE`（`effects.isBuildingComplete` の規約）。
    // 着工直後は 0 なので「0 は完成」と誤らないこと。
    if (e.buildProgress[t]! >= PROGRESS_DONE) continue;
    const dx = e.x[t]! - e.x[i]!;
    const dy = e.y[t]! - e.y[i]!;
    const sq = dx * dx + dy * dy;
    if (best < 0 || sq < bestSq) {
      best = t;
      bestSq = sq;
    }
  }
  return best;
}

/**
 * 護衛対象のそばで実際に立つ場所。
 *
 * 護衛対象が投石手（範囲攻撃 + `friendly_fire`）で目標を持っているときは、
 * その射線から横に `LINE_OF_FIRE_WIDTH * 2` だけずれた位置を返す
 * （`07§5`「投石系は射線に味方を置かない」）。それ以外は護衛対象の位置そのまま。
 */
function guardStandPoint(w: World, i: number, g: number, out: { x: Fx; y: Fx }): void {
  const e = w.entities;
  out.x = e.x[g]!;
  out.y = e.y[g]!;
  if (!isFriendlyFireShooter(e, g)) return;
  const tid = e.target[g]!;
  if (!isAlive(e, tid)) return;
  const ti = entityIndex(tid);
  sideStepPoint(
    e.x[g]!,
    e.y[g]!,
    e.x[g]!,
    e.y[g]!,
    e.x[ti]!,
    e.y[ti]!,
    LINE_OF_FIRE_WIDTH * 2,
    e.x[i]!,
    e.y[i]!,
    out
  );
}

// ---------------------------------------------------------------------------
// 決定の適用
// ---------------------------------------------------------------------------

/**
 * 選んだ結果を `target` / `destX` / `destY` に書く。
 *
 * 遠隔ユニットは**射程ぶん手前で止まる**（`standoffFor`）。
 * ただし前進が最大の令（突撃・上陸・圧壊）は射程の有利を捨てて距離を詰める（`07§5`）。
 * 実際に動かすのは `movement`（システム 6）、殴るのは `combat`（システム 7）。
 */
function applyDecision(
  w: World,
  i: number,
  target: number,
  px: Fx,
  py: Fx,
  advanceWeight: Fx,
  range: Fx,
  s: Scratch
): void {
  const e = w.entities;

  if (target >= 0) {
    e.target[i] = idOfIndex(e, target);
    approachPoint(e.x[i]!, e.y[i]!, px, py, standoffFor(advanceWeight, range), destPoint);
    e.destX[i] = destPoint.x;
    e.destY[i] = destPoint.y;
    // 「他ユニットが既にその目標を選んだ数」を積む（集中しすぎ防止の材料）。
    if (s.claims[target] === 0) s.claimed.push(target);
    s.claims[target] = s.claims[target]! + 1;
  } else {
    e.target[i] = INVALID_ENTITY;
    e.destX[i] = px;
    e.destY[i] = py;
  }

  if (e.state[i] === UnitState.Idle) {
    e.state[i] = UnitState.Moving;
    e.stateTick[i] = w.tick;
  }
}
