/**
 * システム 8/14: morale — 士気の増減・退却（`07§6`, 実装手順書 §6.5 / T-M7-07, T-M7-08）
 *
 * 責務（`morale` は 0..FX_ONE。**HP 0 の前に morale 0 で退く**）:
 *  - 減少: 孤立 / 戦域が警告状態 / 直近 3 秒に近くで味方が多数死亡 / 令が届いていない。
 *  - 増加: 密集隊列 / 近くに祈祷師 / 戦域が優勢 / 自軍建物・壁の内側。
 *  - morale 0 → `UnitState.Routed` にして `morale.retreatSec`（10 秒）だけ
 *    最寄り拠点方向へ退却して回復し、戻る。この間 `frontId` は **保持する**。
 *
 * これが「捨てる判断」を成立させる中核。
 * 士気の低い兵から順に下がるので、後退の令で畳めば戦力を全損しない（`07§6` 末尾）。
 *
 * 担当マイルストーン: **M7**（T-M7-07, T-M7-08）。
 *
 * ---------------------------------------------------------------------------
 * 「直近 3 秒の死亡」をどう判定しているか（設計の記録）
 * ---------------------------------------------------------------------------
 * 素直に実装するなら「死亡イベントのリングバッファ」を World に持つべきだが、
 *  - `world.ts` は M2/M8 の担当ファイルで、M7 からは編集できない
 *  - このファイルのモジュールスコープに状態を置くと、World を 2 つ並べた瞬間に
 *    決定論が壊れる（リプレイ検証・デシンク再現で World を複数持つ）
 * ため、**World に既にあるデータだけ**で判定している。2 経路の OR を取る。
 *
 *  経路 A（局所・その tick）: `Entities.pendingDead`。
 *    `markDeadIndex` は `alive = 0` にするだけで、index の解放（`clearSlot`）は
 *    tick 末の cleanup（システム 14）まで行われない。morale はシステム 8 なので、
 *    combat（7）がこの tick に殺した味方の **座標と owner がまだ生きている**。
 *    半径 `deathShockRadiusTiles` 内に味方の死体が `deathShockCount` 体以上あれば成立。
 *
 *  経路 B（時間窓・戦域単位）: `Front.dmgTaken` リングバッファ。
 *    直近 `deathShockWindowSec` 分の被ダメージ合計が
 *    「自分の hpMax × deathShockCount」以上なら「近くで味方が 3 体分倒れた」とみなす。
 *    局所性は「同じ戦域に属していること」で代替している（戦域は半径 15〜30 マス）。
 *
 * A だけでは 3 秒の窓を張れず、B だけでは同一 tick の全滅（一撃で 3 体死ぬ投石）を
 * 拾えないため両方を使う。World に死亡イベントの窓が入ったら B は不要になる
 * （申し送りに `Front.deaths` リングバッファの追加を挙げてある）。
 */

import type { PlayerId } from '@/shared/types';
import { EntityKind, INVALID_ENTITY } from '@/shared/types';
import type { Fx } from '../core/fx';
import { FX_ONE, fx, fxMax, idiv } from '../core/fx';
import { TICK_RATE, cfgFx, cfgInt, cfgNum, cfgTicks, cfgTiles } from '../core/config';
import { ADVANTAGE_WINDOW_TICKS, areAllies, getFront, type Front, type World } from '../core/world';
import { UnitState, idOfIndex } from '../core/entity';
import { unitDef } from '../core/defs';
import { queryCircle } from '../core/grid';
import { Formation } from '../core/damage';
import { hasMoraleBreakImmune, orderPairOfEntity } from '../core/orderEffects';
// 隊列の判定は combat.ts と共通にする（密集の「範囲被害 1.4」と「士気維持」がずれないように）。
import { formationOfEntity } from './combat';

/** 祈祷師が持つ trait（近くの味方の士気を保つ。`units.json` の `priest`）。 */
const TRAIT_MORALE_HOLD = 'morale_hold';

/** 村人は「士気で退く」対象ではない（攻撃されたら塔へ退避する。`07§8`）。 */
const ROLE_VILLAGER = 'villager';

/**
 * 士気の再評価を tick 方向に散らす間隔（tick）。
 *
 * 1 体あたり `queryCircle` を 1 回引くので、毎 tick 全員を評価すると
 * 1600 体で 1 tick の予算を食い潰す。`unitDecision` と同じ 12 tick（約 0.5 秒）に
 * 間引き、位相は **`entityIndex % 12`**（乱数は使わない。手順書 §16-3）。
 *
 * 増減量は「その 12 tick 分をまとめて」適用するので、
 * 長い目で見た 1 秒あたりの変化量は間引きの有無で変わらない（`moraleDelta` を参照）。
 */
const EVAL_INTERVAL_TICKS = 12;

export function morale(w: World): void {
  const e = w.entities;
  const p = params();
  const phase = w.tick % EVAL_INTERVAL_TICKS;

  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (i % EVAL_INTERVAL_TICKS !== phase) continue;
    const d = unitDef(e.typeId[i]!);
    if (d.role === ROLE_VILLAGER) continue;

    if (e.state[i] === UnitState.Routed) {
      updateRouted(w, i, p);
      continue;
    }
    updateMorale(w, i, p);
  }
}

// ---------------------------------------------------------------- パラメータ

interface MoraleParams {
  /** 士気 1 秒あたりの減少（Fx / 秒）。 */
  readonly decayIsolated: Fx;
  readonly decayFrontWarned: Fx;
  readonly decayDeathShock: Fx;
  readonly decayOrderUndelivered: Fx;
  /** 士気 1 秒あたりの増加（Fx / 秒）。 */
  readonly regenDense: Fx;
  readonly regenPriest: Fx;
  readonly regenFrontAdvantage: Fx;
  readonly regenInsideOwnWalls: Fx;
  readonly regenRetreating: Fx;
  /** 半径（Fx）。 */
  readonly isolationRadius: Fx;
  readonly deathShockRadius: Fx;
  readonly priestRadius: Fx;
  readonly insideOwnWallsRadius: Fx;
  /** 近傍問い合わせを 1 回で済ませるための最大半径。 */
  readonly scanRadius: Fx;
  /** 孤立と判定する「半径内の味方数の上限」（0 = 味方が 1 体でもいれば孤立でない）。 */
  readonly isolationAllyCountMax: number;
  /** 死亡ショックの体数。 */
  readonly deathShockCount: number;
  /** 死亡ショックの時間窓（tick）。 */
  readonly deathShockWindowTicks: number;
  /** 退却の長さ（tick）。 */
  readonly retreatTicks: number;
  /** 戦域の警告しきい値（Fx。負値）。 */
  readonly warnThreshold: Fx;
  /** 退却から戻るときの最低士気（Fx）。 */
  readonly recoveredMorale: Fx;
  /** 危険でないときの回復速度（毎秒。Fx）。 */
  readonly regenPeace: Fx;
}

let cached: MoraleParams | null = null;

function params(): MoraleParams {
  if (cached !== null) return cached;
  const isolationRadius = cfgTiles('morale.isolationRadiusTiles');
  const deathShockRadius = cfgTiles('morale.deathShockRadiusTiles');
  const priestRadius = cfgTiles('morale.priestRadiusTiles');
  // 「自軍建物・壁の内側」の判定半径は config.json に無い（申し送り済み）。
  const insideOwnWallsRadius = cfgTiles('morale.isolationRadiusTiles');
  let scan = isolationRadius;
  scan = fxMax(scan, deathShockRadius);
  scan = fxMax(scan, priestRadius);
  scan = fxMax(scan, insideOwnWallsRadius);
  cached = {
    decayIsolated: cfgFx('morale.decayPerSecIsolated'),
    decayFrontWarned: cfgFx('morale.decayPerSecFrontWarned'),
    decayDeathShock: cfgFx('morale.decayPerSecDeathShock'),
    decayOrderUndelivered: cfgFx('morale.decayPerSecOrderUndelivered'),
    regenDense: cfgFx('morale.regenPerSecDense'),
    regenPriest: cfgFx('morale.regenPerSecPriest'),
    regenFrontAdvantage: cfgFx('morale.regenPerSecFrontAdvantage'),
    regenInsideOwnWalls: cfgFx('morale.regenPerSecInsideOwnWalls'),
    regenRetreating: cfgFx('morale.regenPerSecRetreating'),
    isolationRadius,
    deathShockRadius,
    priestRadius,
    insideOwnWallsRadius,
    scanRadius: scan,
    isolationAllyCountMax: cfgInt('morale.isolationAllyCountMax'),
    deathShockCount: cfgInt('morale.deathShockCount'),
    deathShockWindowTicks: cfgTicks('morale.deathShockWindowSec'),
    retreatTicks: cfgTicks('morale.retreatSec'),
    warnThreshold: cfgFx('front.warnThreshold'),
    recoveredMorale: fx(cfgNum('morale.recoveredOnReturn')),
    regenPeace: fx(cfgNum('morale.regenPerSecPeace')),
  };
  return cached;
}

/** テスト用。config を差し替えたときに呼ぶ。 */
export function resetMoraleCache(): void {
  cached = null;
}

/**
 * 「1 秒あたり `ratePerSec`（Fx）」を、`tick` から `tick + span` までの増分に落とす。
 *
 * `cfgPerTickFx` は使えない。0.03/秒 を 25 で割ると 0.0012 で、
 * Fx（1/256 = 0.0039）より小さいので **丸めて 0 になり士気が一切動かなくなる**。
 * そこで累積器を持たずに、グローバル tick を使った Bresenham 式の差分で表す:
 *
 *   delta(tick, span) = trunc(rate * (tick + span) / 25) - trunc(rate * tick / 25)
 *
 * この式は隣接する区間が telescoping するので、
 * 同じ位相で `span` tick ごとに呼び続けても、合計は必ず
 * 「経過秒数 × rate」に一致する（丸め誤差が溜まらない）。
 * 状態を持たないので World を複数並べても決定論が保たれる。
 * `idiv` は 0 方向切り捨てなので、負の rate でも同じ性質が成り立つ。
 */
export function moraleDelta(ratePerSec: Fx, tick: number, span: number): Fx {
  return idiv(ratePerSec * (tick + span), TICK_RATE) - idiv(ratePerSec * tick, TICK_RATE);
}

// ---------------------------------------------------------------- 退却中

function updateRouted(w: World, i: number, p: MoraleParams): void {
  const e = w.entities;
  const m = e.morale[i]! + moraleDelta(p.regenRetreating, w.tick, EVAL_INTERVAL_TICKS);
  e.morale[i] = m > FX_ONE ? FX_ONE : m;

  if (w.tick - e.stateTick[i]! < p.retreatTicks) return;

  // 退却終了。frontId は保持したままなので、そのまま元の戦域へ戻る。
  if (e.morale[i]! < p.recoveredMorale) e.morale[i] = p.recoveredMorale;
  e.stateTick[i] = w.tick;
  e.target[i] = INVALID_ENTITY;

  /**
   * **「また戻ってくる」（`07§6`）を実装する。**
   *
   * `Idle` にして目標も捨てると、退却した兵は二度と元の仕事に戻らない。
   * 移動の目標（`destX/destY`）が残っているならそこへ向かい直す。
   * 目標が無いときだけ `Idle`（次の指示待ち）にする。
   *
   * これが無いと「村人が運搬の途中で退却し、以後 Idle のまま資源が凍る」
   * という壊れ方をする（実測で確認）。
   */
  const hasDest = e.destX[i] !== 0 || e.destY[i] !== 0;
  e.state[i] = hasDest ? UnitState.Moving : UnitState.Idle;
}

// ---------------------------------------------------------------- 通常時

function updateMorale(w: World, i: number, p: MoraleParams): void {
  const e = w.entities;
  const owner = e.owner[i]!;
  const cx = e.x[i]!;
  const cy = e.y[i]!;

  // 近傍を 1 回だけ引いて、半径ごとに数え分ける（queryCircle は index 昇順）。
  const out = w.scratch.neighbors;
  const n = queryCircle(w.grid, e, cx, cy, p.scanRadius, out);
  const isoSq = p.isolationRadius * p.isolationRadius;
  const priestSq = p.priestRadius * p.priestRadius;
  const wallSq = p.insideOwnWallsRadius * p.insideOwnWallsRadius;

  let allyNear = 0;
  let priestNear = false;
  let insideOwnWalls = false;
  for (let k = 0; k < n; k++) {
    const t = out[k]!;
    if (t === i) continue;
    if (e.alive[t] !== 1) continue;
    const other = e.owner[t]!;
    if (!areAllies(w, owner, other)) continue;
    const dx = e.x[t]! - cx;
    const dy = e.y[t]! - cy;
    const sq = dx * dx + dy * dy;
    const kind = e.kind[t]!;
    if (kind === EntityKind.Unit) {
      if (sq <= isoSq) allyNear += 1;
      if (!priestNear && sq <= priestSq && unitDef(e.typeId[t]!).traits.includes(TRAIT_MORALE_HOLD)) {
        priestNear = true;
      }
    } else if (kind === EntityKind.Building || kind === EntityKind.Attachment) {
      if (sq <= wallSq) insideOwnWalls = true;
    }
  }

  const f = frontOf(w, e.owner[i]! as PlayerId, e.frontId[i]!);
  const formation = formationOfEntity(w, i);

  /**
   * **危険にさらされているか。**
   *
   * `07§6` の士気は「兵は体力 0 で死ぬ前に、士気 0 で退きます」という**戦闘の仕組み**で、
   * 全滅を避けるためにある。だから減少要因（孤立・戦域の劣勢・味方の死・令の未着）は
   * **危険な状況でしか効かせない**。
   *
   * これを見ないと「敵のいない平地を 1 体で歩いているだけの兵が、孤立を理由に
   * 士気 0 まで落ちて退却し、指示を失って元の位置へ戻る」という壊れ方をする
   * （実測: 30 マス先へ向かわせた棍棒兵が 17 マス進んで退却し、出発点付近で待機。
   *  同じ理由で開始村人が運搬途中に固まり、資源が tick 2500 で止まっていた）。
   *
   * 危険の定義: 戦域に属している / 直近に殴られた / 視界内に敵がいる のいずれか。
   */
  const inDanger = isInDanger(w, i, p);

  // ---- 平時: 回復するだけ（他の要因は見ない）----
  if (!inDanger) {
    if (e.morale[i]! < FX_ONE) {
      const m = e.morale[i]! + moraleDelta(p.regenPeace, w.tick, EVAL_INTERVAL_TICKS);
      e.morale[i] = m > FX_ONE ? FX_ONE : m;
    }
    return;
  }

  // ---- 危険なときの減少要因 ----
  let rate = 0;
  if (allyNear <= p.isolationAllyCountMax) rate -= p.decayIsolated;
  if (f !== null && f.advantage < p.warnThreshold) rate -= p.decayFrontWarned;
  if (deathShock(w, i, p, f)) rate -= p.decayDeathShock;
  if (f !== null && f.pendingOrder !== null && f.advantage < 0) rate -= p.decayOrderUndelivered;

  // ---- 増加要因 ----
  if (formation === Formation.Dense) rate += p.regenDense;
  if (priestNear) rate += p.regenPriest;
  if (f !== null && f.advantage > 0) rate += p.regenFrontAdvantage;
  if (insideOwnWalls) rate += p.regenInsideOwnWalls;

  if (rate !== 0) {
    let m = e.morale[i]! + moraleDelta(rate, w.tick, EVAL_INTERVAL_TICKS);
    if (m > FX_ONE) m = FX_ONE;
    if (m < 0) m = 0;
    e.morale[i] = m;
  }

  if (e.morale[i]! <= 0 && !breakImmune(w, i)) beginRout(w, i);
}

/**
 * 危険にさらされているか（士気の減少要因を効かせる条件）。
 *
 * 3 つのどれかが成り立てば危険:
 *  1. 戦域に属している（交戦中の場所にいる）
 *  2. 直近に実際に殴られた（`lastDamagedTick`）
 *  3. 視界内に敵の戦闘ユニットがいる
 *
 * 3 は「まだ殴られていないが目の前に敵がいる」状況を拾うため。
 * これを外すと、突撃してきた敵の前で兵の士気が最後まで下がらなくなる。
 */
function isInDanger(w: World, i: number, p: MoraleParams): boolean {
  const e = w.entities;
  if (e.frontId[i] !== 0) return true;

  const since = w.tick - e.lastDamagedTick[i]!;
  if (e.lastDamagedTick[i]! >= 0 && since >= 0 && since <= p.retreatTicks) return true;

  // 視界内の敵（自分の視界半径で見る。index 昇順）
  const sight = unitDef(e.typeId[i]!).sight;
  if (sight <= 0) return false;
  const out = w.scratch.neighbors2;
  const n = queryCircle(w.grid, e, e.x[i]!, e.y[i]!, sight, out);
  const owner = e.owner[i]!;
  for (let k = 0; k < n; k++) {
    const t = out[k]!;
    if (t === i || e.alive[t] !== 1) continue;
    if (e.kind[t] !== EntityKind.Unit) continue;
    const other = e.owner[t]!;
    if (other >= w.playerCount) continue; // 中立
    if (areAllies(w, owner, other as PlayerId)) continue;
    if (unitDef(e.typeId[t]!).atk > 0) return true;
  }
  return false;
}

/**
 * 令「方陣」（ローマ / `moraleBreakImmune`）: **士気 0 でも退却しない**。
 *
 * `01` の一行説明「損耗しても隊列が崩れない」の実装。
 *  - 士気そのものは下がる（0 で止まる）。下がっているのに退かない、という形にしてある。
 *    こうすると令を外した瞬間に（士気 0 のまま）崩れるので、「方陣を解く」判断が意味を持つ。
 *  - **体力 0 では死ぬ。** 死亡は `combat.ts` の HP 判定なので、ここには一切関与しない
 *    （＝方陣は全滅を防がない。粘るぶん被害は増える）。
 *  - 令の名前では分岐しない。`moraleBreakImmune` フラグを持つ令なら同じに効く。
 */
function breakImmune(w: World, i: number): boolean {
  return hasMoraleBreakImmune(orderPairOfEntity(w, i));
}

/**
 * `frontId`（1..6, 0 = 所属なし）から Front を引く。
 * 戦域はプレイヤーごとに 6 枠あるので所有者も必要（`combat.ts` と同じ規約）。
 */
function frontOf(w: World, owner: PlayerId, frontId: number): Front | null {
  if (frontId <= 0) return null;
  const f = getFront(w, owner, frontId);
  if (f === undefined || !f.active) return null;
  return f;
}

/**
 * 死亡ショック（ファイル冒頭の設計メモを参照）。
 * 経路 A（この tick に近くで死んだ味方の数）と
 * 経路 B（戦域の直近被ダメージが味方 n 体分の HP を超えたか）の OR。
 */
function deathShock(w: World, i: number, p: MoraleParams, f: Front | null): boolean {
  const e = w.entities;

  // 経路 A: pendingDead はまだ座標も owner も残っている（cleanup は tick 末）。
  const cx = e.x[i]!;
  const cy = e.y[i]!;
  const rSq = p.deathShockRadius * p.deathShockRadius;
  let deaths = 0;
  for (let k = 0; k < e.pendingDeadCount; k++) {
    const t = e.pendingDead[k]!;
    if (t === i) continue;
    if (e.kind[t] !== EntityKind.Unit) continue;
    if (!areAllies(w, e.owner[i]!, e.owner[t]!)) continue;
    const dx = e.x[t]! - cx;
    const dy = e.y[t]! - cy;
    if (dx * dx + dy * dy > rSq) continue;
    deaths += 1;
    if (deaths >= p.deathShockCount) return true;
  }

  // 経路 B: 戦域の直近被ダメージ。
  if (f === null) return false;
  const threshold = e.hpMax[i]! * p.deathShockCount;
  if (threshold <= 0) return false;
  let taken = 0;
  const window = p.deathShockWindowTicks;
  for (let k = 0; k < window; k++) {
    const idx = ((w.tick - k) % ADVANTAGE_WINDOW_TICKS + ADVANTAGE_WINDOW_TICKS) % ADVANTAGE_WINDOW_TICKS;
    taken += f.dmgTaken[idx]!;
    if (taken >= threshold) return true;
  }
  return false;
}

/**
 * 退却を始める（morale 0）。
 *  - `state = Routed`、`stateTick` に現 tick。
 *  - `frontId` は **保持する**（戻ってきたら同じ戦域で戦う。`07§6`）。
 *  - `homeId` と `destX/destY` に最寄りの自軍建物を入れる。movement（M3）が実際に運ぶ。
 */
function beginRout(w: World, i: number): void {
  const e = w.entities;
  e.morale[i] = 0;
  e.state[i] = UnitState.Routed;
  e.stateTick[i] = w.tick;
  e.target[i] = INVALID_ENTITY;
  e.cooldown[i] = 0;

  const home = nearestOwnBuilding(w, i);
  if (home >= 0) {
    e.homeId[i] = idOfIndex(e, home);
    e.destX[i] = e.x[home]!;
    e.destY[i] = e.y[home]!;
  } else {
    // 拠点が無ければその場で踏み止まる（前進はしない）。
    e.destX[i] = e.x[i]!;
    e.destY[i] = e.y[i]!;
  }
}

/**
 * 最寄りの自軍（または味方）建物の index。無ければ -1。
 * 退却の開始時にしか呼ばないので全走査でよい（grid は半径を切るため使えない）。
 * タイブレークは「平方距離が小さい → index が小さい」。
 */
function nearestOwnBuilding(w: World, i: number): number {
  const e = w.entities;
  const cx = e.x[i]!;
  const cy = e.y[i]!;
  let best = -1;
  let bestSq = 0;
  for (let t = 0; t < e.highWater; t++) {
    if (e.alive[t] !== 1) continue;
    if (e.kind[t] !== EntityKind.Building) continue;
    if (!areAllies(w, e.owner[i]!, e.owner[t]!)) continue;
    const dx = e.x[t]! - cx;
    const dy = e.y[t]! - cy;
    const sq = dx * dx + dy * dy;
    if (best < 0 || sq < bestSq) {
      best = t;
      bestSq = sq;
    }
  }
  return best;
}
