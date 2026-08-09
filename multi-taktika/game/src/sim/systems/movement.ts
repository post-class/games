/**
 * システム 6/14: movement — 経路追従・押し出し（実装手順書 §4.6, §6.3, T-M3-07）
 *
 * 責務:
 *  - `destX` / `destY` へ向けて `vx` / `vy` を決め、座標を Fx で更新する。
 *  - 経路は `core/pathfind.ts` の 2 段探索（セクタ粗経路 → セクタ内 A*）で取り、
 *    **経路点（曲がり角）だけ**を保持して毎 tick は直進追従する（局所回避）。
 *  - ユニット同士の重なりを押し出す（近傍は grid で取る）。
 *  - 地形による速度補正（浅瀬の騎兵 -30%。`config.combat.shallowCavSpeed`）。
 *
 * 担当マイルストーン: **M3**（経路追従・押し出し）+ **M7**（陣形・門の通行制限）。
 *
 * ■ 決定論
 *  - 反復は必ず index 昇順。押し出しも index 昇順の 1 パスで、
 *    「i が j を押す」を i < j の側からだけ見る（同時押し合いにしない）。
 *  - 速度・座標は Fx の整数。方向の正規化に `isqrt` を 1 回だけ使う（§4.2 の「必要な箇所」）。
 *  - 経路の再計算は **1 tick あたりの本数を上限で切る**。上限に当たった分は次 tick に回る。
 *    走査が index 昇順なので、どの端末でも同じユニットが同じ tick に再計算される。
 *
 * ■ 経路の保管場所（world.ts / entity.ts への申し送り）
 *  経路点を持つ配列は本来 `Entities`（SoA）に置くべきだが、`entity.ts` は
 *  同時編集を避けるため触っていない。暫定で `Entities` をキーにした
 *  `WeakMap` に SoA を確保している（`EntityId` を持たせて index 再利用を検出する）。
 *  再現性は保たれる（tick 0 から同じ手順で育つ派生データで、状態ハッシュ対象外）が、
 *  「途中状態のセーブ / ロード」を作るときは `Entities` 側へ移すこと。
 */

import { EntityKind } from '@/shared/types';
import type { Entities } from '../core/entity';
import { UnitState, idOfIndex } from '../core/entity';
import type { Fx } from '../core/fx';
import { FX_ONE, fx, fxMul, idiv, isqrt } from '../core/fx';
import { TICK_RATE, cfgFx, cfgNum } from '../core/config';
import { UNIT_DEFS } from '../core/defs';
import { cellCol, cellRow } from '../core/grid';
import type { MoveMask } from '../core/terrain';
import { Move, Tile, hasTerrain, isPassableFor } from '../core/terrain';
import { PathStatus, findPath, getPathfinder } from '../core/pathfind';
import type { World } from '../core/world';

/** 1 ユニットが保持する経路点の最大数（曲がり角のみなので少なくて足りる）。 */
const MAX_WAYPOINTS = cfgNum('movement.maxWaypoints');

/** 1 tick に許す経路探索の本数（負荷の上限。余りは次 tick へ）。 */
const REPATH_BUDGET = cfgNum('movement.repathBudgetPerTick');

/** 再探索を我慢する tick 数（詰まったユニットが毎 tick 探索し直さないように）。 */
const REPATH_COOLDOWN_TICKS = cfgNum('movement.repathCooldownTicks');

/** 到着とみなす距離（Fx）。 */
const ARRIVE_EPS: Fx = fx(cfgNum('movement.arriveEpsTiles'));

/** 経路点を通過したとみなす距離（Fx）。 */
const WAYPOINT_EPS: Fx = fx(cfgNum('movement.waypointEpsTiles'));

/** ユニット同士の最小間隔（Fx）。1 マス = 村人 1 体分の幅（`07§1`）より少し詰める。 */
const SEPARATION: Fx = fx(cfgNum('movement.separationTiles'));

/** 押し出しで 1 tick に動かせる最大量（Fx）。振動を防ぐ。 */
const MAX_PUSH: Fx = fx(cfgNum('movement.maxPushTiles'));

/** 経路が 2 回続けて失敗したら目標を諦める。 */
const MAX_PATH_FAILS = cfgNum('movement.maxPathFails');

/** マス/秒 → Fx/tick が取れないときの既定速度（`units.json` に無い typeId 用）。 */
const FALLBACK_SPEED: Fx = fx(cfgNum('movement.fallbackSpeedTilesPerSec') / TICK_RATE);

// ---------------------------------------------------------------- 方向の正規化

/**
 * 斜辺表。`HYP[q] = 65536 * sqrt(1 + (q / 256)^2)`（q = 短辺 / 長辺 × 256、0..256）。
 *
 * **なぜ表にするか**: 毎 tick 全ユニットで `isqrt` を呼ぶと、
 * 座標が Fx（1 マス = 256）で距離の平方が 10^10 規模になるため 1 体あたり 2µs 近くかかり、
 * 1,600 体で 3ms を超える（実測）。長辺と短辺の比だけを 1/256 刻みに量子化すれば
 * 除算 3 回で済み、向きの誤差は 0.2 度未満に収まる。
 *
 * 表そのものは **`isqrt`（整数）で作る**ので、浮動小数も `Math.sqrt` も使っていない。
 */
const HYP: Int32Array = buildHypTable();

function buildHypTable(): Int32Array {
  const t = new Int32Array(257);
  for (let q = 0; q <= 256; q++) {
    // 65536 * sqrt(1 + (q/256)^2) = 256 * sqrt(65536 + q^2) = isqrt((65536 + q^2) * 65536)
    t[q] = isqrt((65536 + q * q) * 65536);
  }
  return t;
}

/** `computeStep` の出力（返り値を配列にしないための作業変数。単一スレッド前提）。 */
let stepVX = 0;
let stepVY = 0;

/**
 * (dx, dy) の向きへ長さ `maxStep` だけ進む変位を `stepVX` / `stepVY` に入れ、
 * **元の距離（Fx）**を返す。すべて整数演算。
 */
function computeStep(dx: number, dy: number, maxStep: Fx): Fx {
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  const xMajor = ax >= ay;
  const hi = xMajor ? ax : ay;
  const lo = xMajor ? ay : ax;
  if (hi === 0) {
    stepVX = 0;
    stepVY = 0;
    return 0;
  }
  const q = idiv(lo * 256, hi);
  const hyp = HYP[q]!;
  const dist = idiv(hi * hyp, 65536);
  const step = maxStep < dist ? maxStep : dist;
  const vhi = idiv(step * 65536, hyp);
  const vlo = idiv(vhi * q, 256);
  if (xMajor) {
    stepVX = dx < 0 ? -vhi : vhi;
    stepVY = dy < 0 ? -vlo : vlo;
  } else {
    stepVY = dy < 0 ? -vhi : vhi;
    stepVX = dx < 0 ? -vlo : vlo;
  }
  return dist;
}

// ---------------------------------------------------------------- 種別ごとの表

/**
 * typeId ごとの速度・移動種・騎兵かどうかを表にしておく（毎 tick の文字列比較を避ける）。
 * `units.json` は起動時に固定なので、表は 1 回作れば足りる。
 */
const SPEED_BY_TYPE: Int32Array = new Int32Array(UNIT_DEFS.length);
const MASK_BY_TYPE: Uint8Array = new Uint8Array(UNIT_DEFS.length);
const MOUNTED_BY_TYPE: Uint8Array = new Uint8Array(UNIT_DEFS.length);

for (let i = 0; i < UNIT_DEFS.length; i++) {
  const def = UNIT_DEFS[i]!;
  SPEED_BY_TYPE[i] = def.speed > 0 ? def.speed : FALLBACK_SPEED;
  MASK_BY_TYPE[i] =
    def.line === 'ship' || def.role === 'ship'
      ? Move.Ship
      : def.role === 'siege'
        ? Move.Wheeled
        : Move.Land;
  MOUNTED_BY_TYPE[i] = def.role === 'cavalry' || def.role === 'camel' ? 1 : 0;
}

/** 浅瀬の騎兵の速度倍率（Fx）。`combat.shallowCavSpeed` は負の比率なので 1 + 比率。 */
const SHALLOW_MOUNTED_MUL: Fx = FX_ONE + cfgFx('combat.shallowCavSpeed');

/**
 * 経路の保管領域（`Entities` ごとに 1 つ）。**World の状態ではない**。
 */
interface MoveStore {
  /** そのスロットを使っている EntityId（index 再利用の検出用。-1 = 空）。 */
  readonly ownerId: Int32Array;
  /** 経路点のタイル添字（`slot * MAX_WAYPOINTS + k`）。 */
  readonly waypoints: Int32Array;
  readonly wpLen: Int32Array;
  readonly wpCur: Int32Array;
  /** 経路を引いたときの目標（変わったら引き直す）。 */
  readonly pathDestX: Int32Array;
  readonly pathDestY: Int32Array;
  /** 次に再探索してよい tick。 */
  readonly repathTick: Int32Array;
  /** 連続失敗回数。 */
  readonly fails: Int32Array;
}

const stores = new WeakMap<Entities, MoveStore>();

function getStore(e: Entities): MoveStore {
  const hit = stores.get(e);
  if (hit !== undefined) return hit;
  const n = e.capacity;
  const s: MoveStore = {
    ownerId: new Int32Array(n).fill(-1),
    waypoints: new Int32Array(n * MAX_WAYPOINTS),
    wpLen: new Int32Array(n),
    wpCur: new Int32Array(n),
    pathDestX: new Int32Array(n),
    pathDestY: new Int32Array(n),
    repathTick: new Int32Array(n),
    fails: new Int32Array(n),
  };
  stores.set(e, s);
  return s;
}

/** 経路の保管領域のバイト数（メモリ計上用）。 */
export function moveStoreByteLength(e: Entities): number {
  const s = getStore(e);
  return (
    s.ownerId.byteLength +
    s.waypoints.byteLength +
    s.wpLen.byteLength +
    s.wpCur.byteLength +
    s.pathDestX.byteLength +
    s.pathDestY.byteLength +
    s.repathTick.byteLength +
    s.fails.byteLength
  );
}

/** そのユニットの経路を捨てる（M5 の目標変更や M10 の壁破壊のあとに使う）。 */
export function clearPath(e: Entities, i: number): void {
  const s = getStore(e);
  s.wpLen[i] = 0;
  s.wpCur[i] = 0;
  s.fails[i] = 0;
}

/** 目標が設定されているか。`(0, 0)` は「目標なし」の約束（申し送り: `Entities` に旗が欲しい）。 */
function hasDest(e: Entities, i: number): boolean {
  return e.destX[i]! !== 0 || e.destY[i]! !== 0;
}

/** そのユニットの移動種（表引き）。攻城兵器は車輪、船は水上。 */
function moveMaskOf(e: Entities, i: number): MoveMask {
  const t = e.typeId[i]!;
  return t < MASK_BY_TYPE.length ? MASK_BY_TYPE[t]! : Move.Land;
}

/** そのユニットの 1 tick 速度（Fx）。浅瀬の騎兵は減速する（`combat.shallowCavSpeed`）。 */
function speedOf(e: Entities, i: number, tileValue: number): Fx {
  const t = e.typeId[i]!;
  let sp = t < SPEED_BY_TYPE.length ? SPEED_BY_TYPE[t]! : FALLBACK_SPEED;
  if (tileValue === Tile.Shallow && t < MOUNTED_BY_TYPE.length && MOUNTED_BY_TYPE[t] === 1) {
    sp = fxMul(sp, SHALLOW_MOUNTED_MUL);
  }
  return sp < 1 ? 1 : sp;
}

export function movement(w: World): void {
  const e = w.entities;
  const s = getStore(e);
  const terrain = hasTerrain(w.map);
  const maxX = w.map.widthTiles * FX_ONE - 1;
  const maxY = w.map.heightTiles * FX_ONE - 1;
  let budget = REPATH_BUDGET;

  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.state[i] === UnitState.Garrisoned) continue;

    // スロットの持ち主が変わっていたら経路を捨てる（free list による index 再利用）
    const id = idOfIndex(e, i);
    if (s.ownerId[i] !== id) {
      s.ownerId[i] = id;
      s.wpLen[i] = 0;
      s.wpCur[i] = 0;
      s.fails[i] = 0;
      s.repathTick[i] = 0;
    }

    if (!hasDest(e, i)) {
      e.vx[i] = 0;
      e.vy[i] = 0;
      continue;
    }

    const px = e.x[i]!;
    const py = e.y[i]!;
    const dxAll = e.destX[i]! - px;
    const dyAll = e.destY[i]! - py;

    // 到着判定（平方距離で比較する。§4.2）
    if (dxAll * dxAll + dyAll * dyAll <= ARRIVE_EPS * ARRIVE_EPS) {
      arrive(e, s, i);
      continue;
    }

    let tgtX = e.destX[i]!;
    let tgtY = e.destY[i]!;
    const mask = moveMaskOf(e, i);

    if (terrain) {
      // 目標が変わったら経路を捨てる
      if (s.pathDestX[i] !== e.destX[i]! || s.pathDestY[i] !== e.destY[i]!) {
        s.wpLen[i] = 0;
        s.wpCur[i] = 0;
        s.fails[i] = 0;
      }
      if (s.wpCur[i]! >= s.wpLen[i]! && budget > 0 && w.tick >= s.repathTick[i]!) {
        budget -= 1;
        requestPath(w, e, s, i, mask);
      }
      const wp = currentWaypoint(s, i);
      if (wp >= 0) {
        tgtX = (wp % w.map.widthTiles) * FX_ONE + (FX_ONE >> 1);
        tgtY = idiv(wp - (wp % w.map.widthTiles), w.map.widthTiles) * FX_ONE + (FX_ONE >> 1);
      }
    }

    // 経路点 / 目標へ直進する
    const dx = tgtX - px;
    const dy = tgtY - py;
    const tx = clampInt(idiv(px, FX_ONE), 0, w.map.widthTiles - 1);
    const ty = clampInt(idiv(py, FX_ONE), 0, w.map.heightTiles - 1);
    const sp = speedOf(e, i, terrain ? w.map.tiles[ty * w.map.widthTiles + tx]! : Tile.Grass);
    const dist = computeStep(dx, dy, sp);
    if (dist <= 0) {
      advanceWaypoint(s, i);
      e.vx[i] = 0;
      e.vy[i] = 0;
      continue;
    }

    let nx = px + stepVX;
    let ny = py + stepVY;
    if (terrain) {
      const ntx = clampInt(idiv(nx, FX_ONE), 0, w.map.widthTiles - 1);
      const nty = clampInt(idiv(ny, FX_ONE), 0, w.map.heightTiles - 1);
      if ((ntx !== tx || nty !== ty) && !isPassableFor(w.map, ntx, nty, mask)) {
        // 局所回避: 1 歩先が塞がっていたら、通れる軸だけ滑らせる
        const slideX = isPassableFor(w.map, ntx, ty, mask);
        const slideY = isPassableFor(w.map, tx, nty, mask);
        if (slideX && !slideY) ny = py;
        else if (slideY && !slideX) nx = px;
        else {
          nx = px;
          ny = py;
        }
        // 経路が古い可能性があるので、間隔を空けて引き直す
        if (s.repathTick[i]! <= w.tick) s.repathTick[i] = w.tick + REPATH_COOLDOWN_TICKS;
        s.wpLen[i] = 0;
        s.wpCur[i] = 0;
      }
    }

    e.vx[i] = nx - px;
    e.vy[i] = ny - py;
    e.x[i] = clampInt(nx, 0, maxX);
    e.y[i] = clampInt(ny, 0, maxY);
    if (e.state[i] === UnitState.Idle) {
      e.state[i] = UnitState.Moving;
      e.stateTick[i] = w.tick;
    }

    // 経路点に十分近づいたら次へ
    const rx = tgtX - e.x[i]!;
    const ry = tgtY - e.y[i]!;
    if (rx * rx + ry * ry <= WAYPOINT_EPS * WAYPOINT_EPS) advanceWaypoint(s, i);
  }

  pushApart(w);
}

/** 目標に着いた。目標を消して待機に戻す。 */
function arrive(e: Entities, s: MoveStore, i: number): void {
  e.destX[i] = 0;
  e.destY[i] = 0;
  e.vx[i] = 0;
  e.vy[i] = 0;
  s.wpLen[i] = 0;
  s.wpCur[i] = 0;
  s.fails[i] = 0;
  if (e.state[i] === UnitState.Moving) e.state[i] = UnitState.Idle;
}

/** 現在の経路点（タイル添字）。無ければ -1。 */
function currentWaypoint(s: MoveStore, i: number): number {
  const cur = s.wpCur[i]!;
  if (cur >= s.wpLen[i]!) return -1;
  return s.waypoints[i * MAX_WAYPOINTS + cur]!;
}

function advanceWaypoint(s: MoveStore, i: number): void {
  if (s.wpCur[i]! < s.wpLen[i]!) s.wpCur[i] = s.wpCur[i]! + 1;
}

/** 経路を引く。失敗が続いたら目標を諦める（無限に探索し続けないため）。 */
function requestPath(w: World, e: Entities, s: MoveStore, i: number, mask: MoveMask): void {
  const pf = getPathfinder(w.map);
  const out = w.scratch.indices;
  const sx = clampInt(idiv(e.x[i]!, FX_ONE), 0, w.map.widthTiles - 1);
  const sy = clampInt(idiv(e.y[i]!, FX_ONE), 0, w.map.heightTiles - 1);
  const gx = clampInt(idiv(e.destX[i]!, FX_ONE), 0, w.map.widthTiles - 1);
  const gy = clampInt(idiv(e.destY[i]!, FX_ONE), 0, w.map.heightTiles - 1);
  const st = findPath(pf, mask, sx, sy, gx, gy, out);

  s.pathDestX[i] = e.destX[i]!;
  s.pathDestY[i] = e.destY[i]!;
  s.repathTick[i] = w.tick + 1;

  if (st === PathStatus.AlreadyThere) {
    s.wpLen[i] = 0;
    s.wpCur[i] = 0;
    s.fails[i] = 0;
    return;
  }
  if (st === PathStatus.Unreachable || out.length === 0) {
    s.wpLen[i] = 0;
    s.wpCur[i] = 0;
    s.fails[i] = s.fails[i]! + 1;
    s.repathTick[i] = w.tick + REPATH_COOLDOWN_TICKS;
    if (s.fails[i]! >= MAX_PATH_FAILS) arrive(e, s, i); // 目標を諦めて待機に戻す
    return;
  }
  // 部分経路でも歩き出す（歩き切ったところで引き直す）
  const n = out.length < MAX_WAYPOINTS ? out.length : MAX_WAYPOINTS;
  const base = i * MAX_WAYPOINTS;
  for (let k = 0; k < n; k++) s.waypoints[base + k] = out[k]!;
  s.wpLen[i] = n;
  s.wpCur[i] = 0;
  s.fails[i] = st === PathStatus.Found ? 0 : s.fails[i]!;
}

/**
 * 押し出し。index 昇順の 1 パスで、i < j の対だけを見て両方を半分ずつ離す。
 * 近傍は grid（tick 頭に作り直したもの）から取るので、
 * この tick の移動ぶんだけ位置が古いことがあるが、全端末で同じ結果になる。
 *
 * `queryCircle` を使わずセルを直接走査しているのは、
 * 全ユニットぶんの結果整列（`Array.prototype.sort`）が 1,600 体で 0.2ms/tick を食うため。
 * 走査順は「セル (row, col) 昇順 → セル内 index 昇順」で完全に決まっているので、
 * 整列しなくても全端末で同じ順に対を処理する（§16-2）。
 */
function pushApart(w: World): void {
  const e = w.entities;
  const g = w.grid;
  const sepSq = SEPARATION * SEPARATION;
  const maxX = w.map.widthTiles * FX_ONE - 1;
  const maxY = w.map.heightTiles * FX_ONE - 1;

  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.state[i] === UnitState.Garrisoned) continue;
    const c0 = cellCol(g, e.x[i]! - SEPARATION);
    const c1 = cellCol(g, e.x[i]! + SEPARATION);
    const r0 = cellRow(g, e.y[i]! - SEPARATION);
    const r1 = cellRow(g, e.y[i]! + SEPARATION);
    for (let row = r0; row <= r1; row++) {
      const base = row * g.cols;
      for (let col = c0; col <= c1; col++) {
        const cell = base + col;
        const end = g.cellStart[cell + 1]!;
        for (let k = g.cellStart[cell]!; k < end; k++) {
          const j = g.items[k]!;
          if (j <= i) continue; // 対は i < j の側からだけ見る
          if (e.alive[j] !== 1) continue;
          if (e.kind[j] !== EntityKind.Unit) continue;
          if (e.state[j] === UnitState.Garrisoned) continue;
          let dx = e.x[j]! - e.x[i]!;
          let dy = e.y[j]! - e.y[i]!;
          let d2 = dx * dx + dy * dy;
          if (d2 >= sepSq) continue;
          if (d2 === 0) {
            // 完全に重なっている: index の差で決まる固定方向へ散らす（乱数を使わない）
            dx = ((j - i) & 1) === 0 ? 1 : -1;
            dy = ((j - i) & 2) === 0 ? 1 : -1;
            d2 = 2;
          }
          const d = isqrt(d2);
          const overlap = SEPARATION - d;
          const move = overlap > MAX_PUSH * 2 ? MAX_PUSH : idiv(overlap, 2);
          if (move <= 0) continue;
          const ux = d > 0 ? idiv(dx * move, d) : 0;
          const uy = d > 0 ? idiv(dy * move, d) : 0;
          e.x[i] = clampInt(e.x[i]! - ux, 0, maxX);
          e.y[i] = clampInt(e.y[i]! - uy, 0, maxY);
          e.x[j] = clampInt(e.x[j]! + ux, 0, maxX);
          e.y[j] = clampInt(e.y[j]! + uy, 0, maxY);
        }
      }
    }
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
