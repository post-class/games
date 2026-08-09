/**
 * sim/core/order.ts — 令の遅延計算と判断の重み解決（M9。`07§4` / `07§5` / 手順書 §6.2, §6.3）
 *
 * ここに置くのは **状態を持たない計算** だけ。実際に World を書き換えるのは
 * `systems/orderDelivery.ts`（遅延のカウントダウン → 発効）と
 * `systems/unitDecision.ts`（0.5 秒ごとの目標再選択）。
 *
 * ---- 遅延式（手順書 §6.2。計算順を変えないこと）----
 *
 *   delaySec = clamp((1.5 + dist*0.02 + 伝令補正) * 復唱倍率 + 忠誠度ペナルティ, 0.5, 8.0)
 *   計算順: (1.5 + dist*0.02) → 伝令加算 → 復唱の乗算 → 忠誠度の加算 → 上下限クランプ
 *
 * **秒は Fx ではなく「ミリ秒の整数」で計算する。** 理由は精度:
 * `order.perTileSec = 0.02` を Fx にすると `fx(0.02) = 5`（= 0.01953…）に丸まり、
 * dist = 200 で 3.906 秒になって検算値 `(1.5 + 4.0 - 1.0) * 0.5 = 2.25 秒` が出ない。
 * ミリ秒（1/1000）なら 0.02 秒 = 20ms で厳密に表せるので、資料の検算値が一致する。
 * ミリ秒も整数なので浮動小数を状態に持たない約束（§0.3）は守られる。
 *
 * ---- 判断の重み（手順書 §6.3）----
 *
 * 令は命令書ではなく **評価の重み**（`07§5`）。二重旗のときは
 * 「上段 = 移動・配置の方針」「下段 = 攻撃目標の優先」を担当する（`07§4`）ので、
 * `advance / hold / build / evade` は上段から、`targetPriority` は下段から取り、
 * `guard`（護衛）は両段の大きい方を使う。これで「死守 + 包囲」が
 * 「足場を固定したまま（hold 1.0）兵器を護衛して（guard 1.0）門を叩く（wall_gate 優先）」になる。
 */

import type { CivId, PlayerId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import { TICK_RATE, cfgNum } from './config';
import type { OrderDef } from './defs';
import { ORDER_DEFS, buildingDef, counterMul, roleToIndex, unitDef, unitIndex } from './defs';
import {
  getPlayerModifiers,
  isBuildingComplete,
  orderDelayDistanceZero,
  orderDelayMul,
} from './effects';
import type { Entities } from './entity';
import type { Fx } from './fx';
import { FX_ONE, fx, fxClamp, fxDiv, fxMul, idiv, isqrt } from './fx';
import type { Front, World } from './world';

// ---------------------------------------------------------------------------
// 設定値（すべて `config.json` 由来。コードに数値リテラルを置かない。§0.5）
// ---------------------------------------------------------------------------

/** 秒 → ミリ秒（読込時に 1 回だけ丸める。以降は整数演算のみ）。 */
function secToMs(sec: number): number {
  return Math.round(sec * 1000);
}

/** 基礎遅延（ms）。`order.baseDelaySec` = 1.5 秒。 */
const BASE_DELAY_MS = secToMs(cfgNum('order.baseDelaySec'));
/** 距離 1 マスあたりの遅延（ms）。`order.perTileSec` = 0.02 秒 = 20ms。 */
const PER_TILE_MS = secToMs(cfgNum('order.perTileSec'));
/** 下限（ms）。`order.delayMinSec` = 0.5 秒。 */
const DELAY_MIN_MS = secToMs(cfgNum('order.delayMinSec'));
/** 上限（ms）。`order.delayMaxSec` = 8.0 秒。 */
const DELAY_MAX_MS = secToMs(cfgNum('order.delayMaxSec'));
/** 伝令がいるときの加算（ms）。`order.denreiFlatSec` = -1.0 秒。重複しない。 */
const HERALD_MS = secToMs(cfgNum('order.denreiFlatSec'));
/** 忠誠度が閾値未満のときの加算（ms）。`order.lowLoyaltyPenaltySec` = +2.0 秒。 */
const LOW_LOYALTY_MS = secToMs(cfgNum('order.lowLoyaltyPenaltySec'));
/** 忠誠度ペナルティの閾値（Fx）。`loyalty.thresholdDelayPenalty` = 0.80。 */
const LOW_LOYALTY_THRESHOLD: Fx = fx(cfgNum('loyalty.thresholdDelayPenalty'));

/** 伝令ユニットの typeId（`units.json` の `herald`）。 */
export const HERALD_TYPE = unitIndex('herald');

/** 交易荷車の typeId。`economy` が動かすので判断エンジンは触らない。 */
const TRADE_CART_TYPE = unitIndex('trade_cart');

/** 村人の role 添字。 */
const VILLAGER_ROLE = roleToIndex('villager');

/** 攻城兵器の role 添字（包囲の「兵器が前」判定に使う）。 */
const SIEGE_ROLE = roleToIndex('siege');

/**
 * 判断の探索半径（Fx）。**戦域の最大半径**（`front.growMaxRadiusTiles` = 30 マス）に合わせる。
 * 「戦域に入っている全員が同じ景色を見て判断する」ための自然な上限で、
 * これ以上遠い相手は戦域の外なので判断材料にしない。
 */
export const DECISION_RADIUS: Fx = fx(cfgNum('front.growMaxRadiusTiles'));

/**
 * **令を受けていない**ユニットの探索半径（Fx）。
 * 既定行動は「近くの敵に応戦」だけなので、戦域が立つ距離
 * （`front.spawnRadiusTiles` = 15 マス）までしか見ない。
 * 令が無い兵は試合中いちばん数が多いので、ここを絞ると全体の負荷が大きく下がる
 * （1600 体の待機で 1040 → 1400 tick/s）。
 */
export const DEFAULT_DECISION_RADIUS: Fx = fx(cfgNum('front.spawnRadiusTiles'));

/**
 * 集中しすぎ防止の減点（手順書 §6.3 の `- 0.2 * (他ユニットが既にその目標を選んだ数)`）。
 *
 * 申し送り: この 3 つ（`CROWD_PENALTY` / `PRIORITY_BONUS_MAX` / `RISK_NORM_COUNT`）と
 * 既定重み（`DEFAULT_WEIGHTS`）は手順書 §6.3 に直接書かれた値で、`config.json` に
 * 対応キーが無い。バランス調整のために `config.decision.*` を追加してほしい（M18）。
 */
const CROWD_PENALTY: Fx = fx(0.2);

/** `targetPriority` の先頭に一致したときの加点（末尾ほど小さくなる）。 */
const PRIORITY_BONUS_MAX: Fx = fx(1.0);

/** 被弾リスクの正規化に使う敵の数（この人数から届いていればリスク 1.0）。 */
const RISK_NORM_COUNT = 4;

/** 投石系の射線を空ける幅（Fx）。近接の間合い（`combat.meleeReachTiles`）と同じ。 */
export const LINE_OF_FIRE_WIDTH: Fx = fx(cfgNum('combat.meleeReachTiles'));

/** 射線上に立つ候補地点への減点。 */
export const LINE_OF_FIRE_PENALTY: Fx = fx(1.0);

/** 「戦闘ユニットを避けて回り込む」（略奪）の減点。 */
export const AVOID_COMBAT_PENALTY: Fx = fx(1.0);

// ---------------------------------------------------------------------------
// T-M9-01 発信点と距離
// ---------------------------------------------------------------------------

/**
 * 令の発信点のうち **本陣**（不動）の座標。各プレイヤーの開始位置（`map.starts`）。
 * 町の中心を全部失っても本陣そのものは動かない（`07§4`「本陣は八国とも不動」）。
 */
export function homeCampX(w: World, p: PlayerId): Fx {
  return w.map.starts[p * 2] ?? 0;
}

/** 本陣の y 座標。 */
export function homeCampY(w: World, p: PlayerId): Fx {
  return w.map.starts[p * 2 + 1] ?? 0;
}

/**
 * そのエンティティが `p` の令の発信点か（完成済みの `isOrderSource` な建物）。
 * 町の中心・城・大天幕が該当する（`buildings.json` の `isOrderSource`）。
 * モンゴルの大天幕は `movable` なので、畳んで前に出せば発信点ごと動く。
 */
export function isOrderSourceIndex(w: World, i: number, p: PlayerId): boolean {
  const e = w.entities;
  if (e.alive[i] !== 1) return false;
  if (e.kind[i] !== EntityKind.Building) return false;
  if (e.owner[i] !== p) return false;
  if (!buildingDef(e.typeId[i]!).isOrderSource) return false;
  // 建設中の城からは令を出せない（完成してはじめて発信点になる）。
  return isBuildingComplete(w, i);
}

/**
 * **最も近い発信点**（本陣 ∪ 自軍の城 / 大天幕 / 町の中心）から `(x, y)` までの直線距離（Fx）。
 * 地形は考慮しない（`07§4`）。
 *
 * 比較は平方距離で行い、**最後に 1 回だけ** `isqrt` で距離に直す（§4.2 の例外。
 * 遅延式は距離そのものを必要とするため）。
 */
export function nearestOrderSourceDistFx(w: World, p: PlayerId, x: Fx, y: Fx): Fx {
  const e = w.entities;
  let bestSq = distSqOf(homeCampX(w, p), homeCampY(w, p), x, y);
  for (let i = 0; i < e.highWater; i++) {
    if (!isOrderSourceIndex(w, i, p)) continue;
    const sq = distSqOf(e.x[i]!, e.y[i]!, x, y);
    if (sq < bestSq) bestSq = sq;
  }
  return isqrt(bestSq);
}

/** 平方距離（Fx*Fx。比較専用）。 */
function distSqOf(x0: Fx, y0: Fx, x1: Fx, y1: Fx): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return dx * dx + dy * dy;
}

/** 直線距離（Fx）。`isqrt` は切り捨てなので誤差は 0 以上 1/256 未満。 */
export function distFx(x0: Fx, y0: Fx, x1: Fx, y1: Fx): Fx {
  return isqrt(distSqOf(x0, y0, x1, y1));
}

// ---------------------------------------------------------------------------
// T-M9-04 伝令ユニット
// ---------------------------------------------------------------------------

/**
 * その戦域に伝令（`units.json` の `herald`）がいるか。
 *
 * **1 体でも 2 体でも効果は同じ**（`07§4`「重複しない」）なので、
 * 数えるのではなく「いるか」を返す。見つけた時点で打ち切る。
 *
 * 「戦域内」は `frontId` が一致するもの（編入済み）に加えて、
 * **半径内にいる自軍の伝令**も認める。`frontEnrollment` は令をセットした tick より
 * 後に走ることがあり、「連れて行ったのに効かない」を避けるため。
 */
export function hasHeraldInFront(w: World, f: Front): boolean {
  const e = w.entities;
  const rr = f.radius * f.radius;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.typeId[i] !== HERALD_TYPE) continue;
    if (e.owner[i] !== f.owner) continue;
    if (e.frontId[i] === f.slot) return true;
    if (distSqOf(e.x[i]!, e.y[i]!, f.x, f.y) <= rr) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// T-M9-02 遅延式
// ---------------------------------------------------------------------------

/** 遅延式の入力。テストから式そのものを検算できるように分けてある。 */
export interface OrderDelayInput {
  /** 最寄りの発信点から戦域中心までの距離（Fx）。 */
  distFx: Fx;
  /** 戦域内に伝令がいるか（1 体でも 2 体でも同じ）。 */
  herald: boolean;
  /** 復唱などの遅延倍率（Fx。既定 FX_ONE、研究「復唱」で 0.5）。 */
  delayMul: Fx;
  /** モンゴル「駅伝」= 距離の項を 0 にする。 */
  distanceZero: boolean;
  /** 忠誠度が 80% 未満か（+2.0 秒。乗算ではなく加算）。 */
  lowLoyalty: boolean;
}

/**
 * 遅延（ミリ秒）。**手順書 §6.2 の計算順そのまま**。
 *
 * 検算（`07§4`）:
 *  - dist=200 / 伝令 / 復唱 → (1500 + 4000 - 1000) * 0.5 = **2250ms = 2.25 秒**
 *  - dist = 20 / 100 / 200 / 325 → 1900 / 3500 / 5500 / 8000ms（325 は上限で打ち止め）
 */
export function orderDelayMs(inp: OrderDelayInput): number {
  // ① 基礎 + 距離
  let ms = BASE_DELAY_MS;
  if (!inp.distanceZero) {
    // dist(Fx) * 20ms / 256。dist=200 マス（= 51200）なら厳密に 4000ms。
    ms += idiv(inp.distFx * PER_TILE_MS, FX_ONE);
  }
  // ② 伝令の加算（重複しない）
  if (inp.herald) ms += HERALD_MS;
  // ③ 復唱の乗算
  ms = idiv(ms * inp.delayMul, FX_ONE);
  // ④ 忠誠度の加算（丸め前に足す）
  if (inp.lowLoyalty) ms += LOW_LOYALTY_MS;
  // ⑤ 上下限
  if (ms < DELAY_MIN_MS) return DELAY_MIN_MS;
  if (ms > DELAY_MAX_MS) return DELAY_MAX_MS;
  return ms;
}

/** ミリ秒 → tick（四捨五入。整数演算のみ）。 */
export function msToTicks(ms: number): number {
  return idiv(ms * TICK_RATE + 500, 1000);
}

/** 遅延式の入力を World から組み立てる（`setOrder` と UI の表示が同じ値を見るため）。 */
export function orderDelayInputFor(w: World, f: Front): OrderDelayInput {
  const p = f.owner;
  const pl = w.players[p];
  const m = getPlayerModifiers(w, p);
  const distanceZero = orderDelayDistanceZero(m);
  return {
    // 駅伝のときは距離を測る必要すらない（発信点の探索も省ける）。
    distFx: distanceZero ? 0 : nearestOrderSourceDistFx(w, p, f.x, f.y),
    herald: hasHeraldInFront(w, f),
    delayMul: orderDelayMul(m),
    distanceZero,
    lowLoyalty: pl !== undefined && pl.loyalty < LOW_LOYALTY_THRESHOLD,
  };
}

/** その戦域に今から令を出したときの配達に掛かる tick 数。 */
export function orderDelayTicks(w: World, f: Front): number {
  return msToTicks(orderDelayMs(orderDelayInputFor(w, f)));
}

// ---------------------------------------------------------------------------
// T-M9-05〜08 判断の重み
// ---------------------------------------------------------------------------

/** 判断エンジンの重み（すべて Fx。値域 -1.0..1.0）。 */
export interface OrderWeights {
  /** 前進の強さ。 */
  advance: Fx;
  /** 持ち場を守る強さ。 */
  hold: Fx;
  /** 護衛の強さ。 */
  guard: Fx;
  /** 建設の強さ。 */
  build: Fx;
  /** 被弾回避の強さ。 */
  evade: Fx;
}

/**
 * 令がないときの既定重み（手順書 §6.3）= 「近くの敵に応戦」。
 * 持ち場（= 今いる場所）から離れず、近くに来た敵だけを相手にする。
 */
export const DEFAULT_WEIGHTS: Readonly<OrderWeights> = {
  advance: fx(0.3),
  hold: fx(0.5),
  guard: 0,
  build: 0,
  evade: 0,
};

/**
 * 令がないときの対象優先 = 「近くの敵」。
 *
 * 手順書 §6.3 は既定**重み**だけを決めていて対象優先を書いていないが、
 * 空にすると「立っているだけ」が最善手になり `07§3` の既定行動
 * （「近くの敵に応戦する」）が成立しない。探索半径は
 * `DEFAULT_DECISION_RADIUS`（15 マス）に絞ってあるので、遠くまで追いかけはしない。
 */
export const DEFAULT_TARGET_PRIORITY: readonly string[] = ['nearest'];

/** 解決済みの令（上段 + 下段をまとめたもの）。 */
export interface ResolvedOrder {
  /** 上段の令（移動・配置の方針）。 */
  upper: OrderDef | null;
  /** 下段の令（攻撃目標の優先）。 */
  lower: OrderDef | null;
  weights: OrderWeights;
  targetPriority: readonly string[];
  /** 戦域から来た令か（false = `lastOrder` の継続、または令なし）。 */
  fromFront: boolean;
  /** 略奪: 戦闘ユニットを避けて回り込む。 */
  avoidCombatUnits: boolean;
  /** 包囲: 攻城兵器の前進を優先する。 */
  siegeLead: boolean;
  /** 包囲: 兵器が下がると歩兵も下がる。 */
  followSiege: boolean;
  /** 遊撃: 戦域を跨いで動き続ける（持ち場に縛られない）。 */
  crossFront: boolean;
}

/** 令なしの解決結果（`lastOrder` も無いユニット用）。 */
function defaultResolved(): ResolvedOrder {
  return {
    upper: null,
    lower: null,
    weights: { ...DEFAULT_WEIGHTS },
    targetPriority: DEFAULT_TARGET_PRIORITY,
    fromFront: false,
    avoidCombatUnits: false,
    siegeLead: false,
    followSiege: false,
    crossFront: false,
  };
}

/** `OrderDef.flags` の真偽値を引く。 */
function flag(d: OrderDef | null, key: string): boolean {
  return d !== null && d.flags[key] === true;
}

/** `weights` に無いキーは 0（`defs.ts` の仕様）。 */
function wOf(d: OrderDef | null, key: string): Fx {
  if (d === null) return 0;
  return d.weights[key] ?? 0;
}

/**
 * 上段・下段から重みと対象優先を合成する（`07§4` の役割分担）。
 *
 *  - `advance` / `hold` / `build` / `evade` … **上段**（移動・配置の方針）。
 *    上段が無ければ下段の値、どちらも無ければ既定重み。
 *  - `targetPriority` … **下段**（攻撃目標の優先）。無ければ上段のもの。
 *  - `guard` … 両段の**大きい方**。包囲（下段）の護衛が死守（上段）と両立するため。
 */
export function combineOrders(upper: OrderDef | null, lower: OrderDef | null): ResolvedOrder {
  if (upper === null && lower === null) return defaultResolved();
  const move = upper ?? lower;
  const gUpper = wOf(upper, 'guard');
  const gLower = wOf(lower, 'guard');
  return {
    upper,
    lower,
    weights: {
      advance: wOf(move, 'advance'),
      hold: wOf(move, 'hold'),
      guard: gUpper > gLower ? gUpper : gLower,
      build: wOf(move, 'build'),
      evade: wOf(move, 'evade'),
    },
    targetPriority: (lower ?? upper)!.targetPriority,
    fromFront: false,
    avoidCombatUnits: flag(upper, 'avoidCombatUnits') || flag(lower, 'avoidCombatUnits'),
    siegeLead: flag(upper, 'siegeLead') || flag(lower, 'siegeLead'),
    followSiege: flag(upper, 'followSiege') || flag(lower, 'followSiege'),
    crossFront: flag(upper, 'crossFront') || flag(lower, 'crossFront'),
  };
}

/** `Entities.lastOrder`（令 index + 1、0 = なし）→ OrderDef。壊れた値は null。 */
export function lastOrderDefOf(e: Entities, i: number): OrderDef | null {
  const v = e.lastOrder[i]!;
  if (v <= 0) return null;
  return ORDER_DEFS[v - 1] ?? null;
}

/**
 * そのユニットが今従っている令を解決する。
 *
 *  - 戦域に所属していて `defected` でなければ、その戦域の上段 / 下段。
 *  - 戦域が閉じた / 離反した / 戦域外なら **`lastOrder`**（`07§3` の「最後の令を保持」）。
 *  - それも無ければ既定重み（「近くの敵に応戦」）。
 *
 * `front.defected` の戦域は **令を無視して既定行動のみ**（`07§10`）。
 * 離反した旗は最後の令すら聞かないので `lastOrder` も見ない。
 */
export function resolveOrderForUnit(w: World, i: number, front: Front | null): ResolvedOrder {
  if (front !== null && front.defected) return defaultResolved();
  if (front !== null) {
    const upper = front.order === null ? null : orderDefOrNull(front.order);
    const lower = front.orderLower === null ? null : orderDefOrNull(front.orderLower);
    if (upper !== null || lower !== null) {
      const r = combineOrders(upper, lower);
      r.fromFront = true;
      return r;
    }
  }
  const last = lastOrderDefOf(w.entities, i);
  if (last === null) return defaultResolved();
  return last.tier === 'lower' ? combineOrders(null, last) : combineOrders(last, null);
}

/**
 * 令 ID → 定義。**未知の ID は null**（`defs.orderDefById` は例外を投げるので使えない）。
 * 古いリプレイや改造クライアントの値で試合が落ちてはいけない（`command.ts` と同じ方針）。
 * `Map` はキー引きにしか使わないので反復順の問題は起きない（§0.3）。
 */
const ORDER_BY_ID = new Map<string, OrderDef>(ORDER_DEFS.map((d) => [d.id, d]));

function orderDefOrNull(id: string): OrderDef | null {
  return ORDER_BY_ID.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// 候補の分類（`targetPriority` の突き合わせ）
// ---------------------------------------------------------------------------

/** 候補の性質。`orders.json` の `targetPriorityKeys` に対応するビット。 */
export const Tag = {
  Unit: 1 << 0,
  Villager: 1 << 1,
  Building: 1 << 2,
  ResourceBuilding: 1 << 3,
  House: 1 << 4,
  WallGate: 1 << 5,
  Ship: 1 << 6,
  SiegeUnit: 1 << 7,
  /** 自分の射程内にいる（`in_range`）。呼び出し側が足す。 */
  InRange: 1 << 8,
} as const;

/** 敵候補の性質を求める（`in_range` は含まない）。 */
export function tagsOfTarget(e: Entities, i: number): number {
  const kind = e.kind[i]!;
  if (kind === EntityKind.Unit) {
    const d = unitDef(e.typeId[i]!);
    let t = Tag.Unit;
    if (d.roleIdx === VILLAGER_ROLE) t |= Tag.Villager;
    if (d.roleIdx === SIEGE_ROLE) t |= Tag.SiegeUnit;
    if (d.line === 'ship') t |= Tag.Ship;
    return t;
  }
  if (kind === EntityKind.Building || kind === EntityKind.Attachment) {
    const d = buildingDef(e.typeId[i]!);
    let t = Tag.Building;
    if (d.isWall || d.isGate) t |= Tag.WallGate;
    // 資源施設 = 搬入点（伐採所・採掘場・桟橋・町の中心）と農地。
    if (d.isDropOff || d.id === 'farm') t |= Tag.ResourceBuilding;
    if (d.popProvide > 0 && !d.isDropOff) t |= Tag.House;
    return t;
  }
  return 0;
}

/** `targetPriority` の 1 語 → タグ。`nearest` は「何にでも一致」なので 0 を返す。 */
function tagOfPriorityWord(word: string): number {
  switch (word) {
    case 'unit':
      return Tag.Unit;
    case 'villager':
      return Tag.Villager;
    case 'building':
      return Tag.Building;
    case 'resource_building':
      return Tag.ResourceBuilding;
    case 'house':
      return Tag.House;
    case 'wall_gate':
      return Tag.WallGate;
    case 'ship':
      return Tag.Ship;
    case 'siege_unit':
      return Tag.SiegeUnit;
    case 'in_range':
      return Tag.InRange;
    default:
      // 'nearest' とデータの追加語。どの候補にも一致する扱い。
      return 0;
  }
}

/**
 * `targetPriority` に一致した順位の加点（先頭ほど大きい）。
 *
 * 例: 略奪 `["villager", "resource_building", "house"]` は
 * 村人 1.0 / 資源施設 0.667 / 家 0.333 / それ以外 0。
 * 「略奪なら村人に大きく +」（手順書 §6.3）がこれで数値になる。
 */
export function targetPriorityBonus(priority: readonly string[], tags: number): Fx {
  const n = priority.length;
  if (n === 0) return 0;
  for (let k = 0; k < n; k++) {
    const need = tagOfPriorityWord(priority[k]!);
    if (need === 0 || (tags & need) !== 0) {
      return idiv(PRIORITY_BONUS_MAX * (n - k), n);
    }
  }
  return 0;
}

/**
 * 相性の加点（`counterBonus`）。有利 +0.5 / 不利 -0.3 / 等倍 0。
 * `config.counterMatrix` の倍率（1.5 / 0.7 / 1.0）から 1.0 を引いた値なので、
 * 相性表を触ればここも自動で追従する。
 */
export function counterBonus(attackerRole: number, defenderRole: number): Fx {
  return counterMul(attackerRole, defenderRole) - FX_ONE;
}

// ---------------------------------------------------------------------------
// スコアの部品（0..1 に正規化した Fx を返す純関数）
// ---------------------------------------------------------------------------

/** 近さ（距離 0 で 1.0、探索半径以上で 0）。 */
export function closenessFx(dist: Fx, radius: Fx): Fx {
  if (dist <= 0) return FX_ONE;
  if (dist >= radius) return 0;
  return fxDiv(radius - dist, radius);
}

/** 遠さ（距離 0 で 0、探索半径以上で 1.0）。 */
export function normDistFx(dist: Fx, radius: Fx): Fx {
  if (dist <= 0) return 0;
  if (dist >= radius) return FX_ONE;
  return fxDiv(dist, radius);
}

/** 敵の数 → 被弾リスク（0..1）。`RISK_NORM_COUNT` 体で 1.0。 */
export function riskFromCount(count: number): Fx {
  if (count <= 0) return 0;
  if (count >= RISK_NORM_COUNT) return FX_ONE;
  return idiv(FX_ONE * count, RISK_NORM_COUNT);
}

/** 「他ユニットが既にその目標を選んだ数」による減点。 */
export function crowdPenalty(claims: number): Fx {
  return CROWD_PENALTY * claims;
}

/** 重み × 項（両方 Fx）。 */
export function term(weight: Fx, value: Fx): Fx {
  return fxMul(weight, value);
}

/**
 * 点 `(px, py)` が線分 `(ax, ay)-(bx, by)` から `width` 以内にあるか（投石の射線判定）。
 * 除算を使わないよう、外積の平方と `width² * 長さ²` を比べる。
 */
export function nearSegment(
  px: Fx,
  py: Fx,
  ax: Fx,
  ay: Fx,
  bx: Fx,
  by: Fx,
  width: Fx
): boolean {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return apx * apx + apy * apy <= width * width;
  // 線分の外にはみ出していれば射線上ではない（内積で判定）。
  const dot = apx * abx + apy * aby;
  if (dot < 0 || dot > lenSq) return false;
  const cross = apx * aby - apy * abx;
  // |cross| / len <= width  ⇔  cross² <= width² * len²
  return cross * cross <= width * width * lenSq;
}

/** 目標へ寄るときに空ける間合い（Fx）。突撃は 0（射程の有利を捨てて詰める）。 */
export function standoffFor(advanceWeight: Fx, range: Fx): Fx {
  // 前進が最大（1.0 以上）の令は距離を詰めきる（`07§5` 突撃）。
  if (advanceWeight >= FX_ONE) return 0;
  return range;
}

/**
 * `(tx, ty)` に `standoff` だけ手前まで寄る地点。
 * `standoff` が距離以上なら今の場所のまま（もう十分近い）。
 */
export function approachPoint(
  sx: Fx,
  sy: Fx,
  tx: Fx,
  ty: Fx,
  standoff: Fx,
  out: { x: Fx; y: Fx }
): void {
  const dx = tx - sx;
  const dy = ty - sy;
  const d = isqrt(dx * dx + dy * dy);
  if (standoff <= 0 || d <= 0) {
    out.x = tx;
    out.y = ty;
    return;
  }
  if (d <= standoff) {
    out.x = sx;
    out.y = sy;
    return;
  }
  // 目標から standoff ぶん引き戻す。
  const keep = fxDiv(d - standoff, d);
  out.x = sx + fxMul(dx, keep);
  out.y = sy + fxMul(dy, keep);
}

/**
 * 線分 `(ax,ay)-(bx,by)`（投石手 → その目標 = 射線）から**横にずれた**護衛位置。
 *
 * `07§5`「投石系は射線に味方を置かない配置補正」の実体。
 * `(gx, gy)`（護衛対象の位置）を射線に垂直な向きへ `offset` だけずらす。
 * どちら側にずらすかは **今いる場所がある側**（外積の符号）で決める。乱数は使わない。
 */
export function sideStepPoint(
  gx: Fx,
  gy: Fx,
  ax: Fx,
  ay: Fx,
  bx: Fx,
  by: Fx,
  offset: Fx,
  selfX: Fx,
  selfY: Fx,
  out: { x: Fx; y: Fx }
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = isqrt(dx * dx + dy * dy);
  if (len <= 0) {
    out.x = gx;
    out.y = gy;
    return;
  }
  // 射線に垂直な向き（-dy, dx）を offset の長さに正規化する。
  const px = idiv(-dy * offset, len);
  const py = idiv(dx * offset, len);
  const cross = dx * (selfY - ay) - dy * (selfX - ax);
  const side = cross >= 0 ? 1 : -1;
  out.x = gx + side * px;
  out.y = gy + side * py;
}

/** その令が使える文明か（固有令の持ち主判定。UI と AI が使う）。 */
export function orderAllowedForCiv(d: OrderDef, civ: CivId): boolean {
  return d.civ === null || d.civ === civ;
}

/** 交易荷車か（判断エンジンの対象外）。 */
export function isTradeCartIndex(e: Entities, i: number): boolean {
  return e.typeId[i] === TRADE_CART_TYPE;
}

/** 村人か。 */
export function isVillagerRole(roleIdx: number): boolean {
  return roleIdx === VILLAGER_ROLE;
}

/** 攻城兵器か。 */
export function isSiegeRole(roleIdx: number): boolean {
  return roleIdx === SIEGE_ROLE;
}

/** 重みを 0 で下限クランプ（負の重みを「効果なし」にしたいとき）。 */
export function clampWeight(v: Fx): Fx {
  return fxClamp(v, -FX_ONE, FX_ONE);
}
