/**
 * ui/stats.ts — 試合統計の「観測」（T-M12-12 の土台）
 *
 * 結果画面（`05§13`）は「採集した 4 資源」「撃破・損失・建物破壊」「**令ごとの成績**」
 * 「資源推移グラフ」を出す。これらは **sim には無い**（sim は勝敗判定に必要な状態しか
 * 持たない）。そこで UI 層が毎 tick サンプリングして貯める。
 *
 * ■ なぜ sim に列を足さないのか（手順書 §3.1 / §4.5）
 *   統計は**観測であって状態ではない**。sim に足すと状態ハッシュの対象になり、
 *   「統計の数え方を直したら過去の golden ハッシュが全部無効」という事故が起きる。
 *   観測なら数え方を後から直しても決定論に影響しない。
 *
 * ■ リプレイで同じ統計が再現されることの保証
 *   1. **時刻を一切使わない。** サンプル間隔は `w.tick`（`SERIES_INTERVAL_TICKS`）で決める。
 *      `Date.now` / `performance.now` / フレーム数は入力にしない。
 *   2. **乱数を使わない。** 反復は必ず index 昇順、戦域は slot 昇順、同点は小さい番号を採る。
 *   3. **入力は連続する 2 tick の World だけ。** `sample(w)` は「前回の観測」と「今の World」の
 *      差分しか見ないので、同じコマンド列を再生すれば同じ観測列になる。
 *   4. 呼び忘れの検出: `sample` は **毎 tick 呼ばれる前提**（死亡した index は tick 末の
 *      `flushDead` で再利用されるため、1 tick 飛ばすと撃破を取り逃がす）。
 *      飛んだ場合は `hasGap` を立てて、結果画面が「統計は不完全」と表示できるようにする。
 *
 * ■ 撃破・損失の数え方（`Entities.lastDamagedBy` と死亡の突き合わせ）
 *   死亡は tick 末の `cleanup`（`flushDead`）でスロットが消去されるので、
 *   `stepWorld` の後から「今死んだもの」を直接読むことはできない。
 *   そこで **前 tick のスナップショット（census）** を持ち、
 *   「census では生きていた index が、今は死んでいる / 世代が変わった」を死亡とみなす。
 *   犯人は census に写しておいた `lastDamagedBy`（= 直前に殴った相手）を使う。
 *   **限界**: 「1 撃も食らっていない相手を 1 撃で倒した」場合だけ犯人が -1 になり、
 *   撃破が誰にも計上されない（損失は計上される）。申し送りに書いてある通り、
 *   sim 側に死亡ログ（被害者 / 加害者）が入れば置き換えられる。
 */

import { EntityKind, ORDER_IDS, RESOURCE_COUNT, type OrderId, type PlayerId } from '@/shared/types';
import { FX_ONE } from '@/sim/core/fx';
import { effectiveOrderOf } from '@/sim/core/front';
import { MAX_FRONTS, areAllies, frontIndex, type World } from '@/sim/core/world';

/** 令の総数（基本 6 + 固有 8）。 */
export const ORDER_COUNT = ORDER_IDS.length;

/**
 * 資源推移グラフの標本間隔（tick）。250 tick = 10 秒。
 * 45,000 tick（約 30 分）の試合で 180 点。線の形が読めて、DOM も軽い。
 * **tick で決めることが再現性の要**（フレーム数や実時間で決めてはいけない）。
 */
export const SERIES_INTERVAL_TICKS = 250;

/** 令 1 枚の成績（`05§13-5`「令ごとの成績も内訳で出ます」）。 */
export interface OrderPerf {
  /** `ORDER_IDS` の添字。 */
  readonly order: number;
  readonly orderId: OrderId;
  /** この令の下で挙げた撃破数。 */
  readonly kills: number;
  /** この令の下で出した損失数。 */
  readonly losses: number;
  /** この令の下で壊した建物数。 */
  readonly buildingsDestroyed: number;
  /** この令が戦域に効いていた tick の総和（戦域 × tick）。 */
  readonly ticksActive: number;
  /** この令をセットした回数。 */
  readonly issued: number;
}

/**
 * 令の履歴 1 件（`06§8` の `Y`。「試合後のリプレイと同じ形式」）。
 * **出した時刻と届いた時刻を分けて持つ**（令の遅延を UI で隠さないため。手順書 §16-4）。
 */
export interface OrderLogEntry {
  readonly slot: number;
  readonly order: number;
  readonly orderId: OrderId;
  readonly tier: 'upper' | 'lower';
  /** 令をセットした tick（`pendingOrder` が現れた tick）。 */
  readonly issuedTick: number;
  /** 戦域に届いた tick（-1 = 届く前に試合が終わった）。 */
  readonly deliveredTick: number;
}

/** プレイヤー 1 人の統計。 */
export interface PlayerStatsSnapshot {
  readonly player: PlayerId;
  /** 採集した 4 資源（`RESOURCE_IDS` 順、整数量）。 */
  readonly gathered: readonly number[];
  /** 撃破したユニット数。 */
  readonly kills: number;
  /** 失ったユニット数。 */
  readonly losses: number;
  /** 壊した建物数（付属物を含む）。 */
  readonly buildingsDestroyed: number;
  /** 失った建物数。 */
  readonly buildingsLost: number;
  /** 令ごとの成績（`ORDER_IDS` 順、常に全 14 件）。 */
  readonly perOrder: readonly OrderPerf[];
  /** 令の履歴（`issuedTick` 昇順）。 */
  readonly orderLog: readonly OrderLogEntry[];
  /** 累計採集量（4 資源合計）の推移。`ticks` と同じ長さ。 */
  readonly series: readonly number[];
}

/** 統計全体。 */
export interface MatchStatsSnapshot {
  /** 観測を始めてから最後に観測した tick。 */
  readonly lastTick: number;
  /** 標本の tick 列（`SERIES_INTERVAL_TICKS` ごと）。 */
  readonly ticks: readonly number[];
  readonly players: readonly PlayerStatsSnapshot[];
  /** `sample` の呼び忘れ（tick 飛び）があったか。true なら統計は不完全。 */
  readonly hasGap: boolean;
}

/** Fx（実数 × 256）→ 表示用の整数量。 */
export function fxToAmount(v: number): number {
  return Math.round(v / FX_ONE);
}

/**
 * 試合統計の収集器。**`stepWorld` の直後に毎 tick `sample(w)` を呼ぶ。**
 *
 * DOM に触らないので、テストからそのまま使える（jsdom 不要）。
 */
export class MatchStats {
  private readonly playerCount: number;

  // ---- 累積値 ----
  /** 採集量の累計（Fx）。`[p * RESOURCE_COUNT + r]`。 */
  private readonly gathered: Float64Array;
  /** 前 tick の資源保有量（Fx）。増えた分だけを採集とみなす。 */
  private readonly prevRes: Float64Array;
  private readonly kills: Int32Array;
  private readonly losses: Int32Array;
  private readonly buildingsDestroyed: Int32Array;
  private readonly buildingsLost: Int32Array;
  /** 令ごとの成績。`[p * ORDER_COUNT + o]`。 */
  private readonly orderKills: Int32Array;
  private readonly orderLosses: Int32Array;
  private readonly orderBuildings: Int32Array;
  private readonly orderTicks: Int32Array;
  private readonly orderIssued: Int32Array;

  // ---- census（前 tick のエンティティの写し） ----
  private censusCapacity = 0;
  private censusAlive = new Uint8Array(0);
  private censusKind = new Uint8Array(0);
  private censusOwner = new Uint8Array(0);
  private censusGen = new Uint16Array(0);
  private censusDamager = new Int32Array(0);
  private censusFront = new Uint8Array(0);
  private censusX = new Int32Array(0);
  private censusY = new Int32Array(0);

  // ---- 戦域の令の追跡 ----
  /** 前 tick の `order`（`ORDER_IDS` 添字 + 1。0 = なし）。添字は `frontIndex`。 */
  private readonly prevOrder: Int8Array;
  /** 前 tick の `pendingOrder.deliverAtTick`（-1 = なし）。 */
  private readonly prevPendingAt: Int32Array;
  /** 前 tick の `pendingOrder` の令（添字 + 1。0 = なし）。 */
  private readonly prevPendingOrder: Int8Array;
  /** 戦域ごとの「まだ届いていないログ行」の位置（-1 = なし）。 */
  private readonly pendingLogIdx: Int32Array;

  // ---- 履歴と推移 ----
  private readonly orderLog: OrderLogEntry[][] = [];
  private readonly ticks: number[] = [];
  private readonly series: number[][] = [];

  private started = false;
  private lastTick = -1;
  private gap = false;

  constructor(playerCount: number) {
    if (!Number.isInteger(playerCount) || playerCount < 1) {
      throw new Error(`MatchStats: playerCount が不正 (${playerCount})`);
    }
    this.playerCount = playerCount;
    const pr = playerCount * RESOURCE_COUNT;
    const po = playerCount * ORDER_COUNT;
    this.gathered = new Float64Array(pr);
    this.prevRes = new Float64Array(pr);
    this.kills = new Int32Array(playerCount);
    this.losses = new Int32Array(playerCount);
    this.buildingsDestroyed = new Int32Array(playerCount);
    this.buildingsLost = new Int32Array(playerCount);
    this.orderKills = new Int32Array(po);
    this.orderLosses = new Int32Array(po);
    this.orderBuildings = new Int32Array(po);
    this.orderTicks = new Int32Array(po);
    this.orderIssued = new Int32Array(po);

    const fn = playerCount * MAX_FRONTS;
    this.prevOrder = new Int8Array(fn);
    this.prevPendingAt = new Int32Array(fn).fill(-1);
    this.prevPendingOrder = new Int8Array(fn);
    this.pendingLogIdx = new Int32Array(fn).fill(-1);

    for (let p = 0; p < playerCount; p++) {
      this.orderLog.push([]);
      this.series.push([]);
    }
  }

  /** `sample` を 1 度も呼んでいないか。 */
  isEmpty(): boolean {
    return !this.started;
  }

  /** tick 飛びを検出したか（統計が不完全）。 */
  hasGap(): boolean {
    return this.gap;
  }

  /**
   * 1 tick 分を観測する。**`stepWorld` の直後に毎 tick 呼ぶ。**
   *
   * 同じ tick で 2 回呼ばれた場合は 2 回目を無視する（フレーム内で複数 tick 進める
   * ループから呼ばれても二重計上しない）。
   */
  sample(w: World): void {
    const tick = w.tick;
    if (this.started && tick === this.lastTick) return;
    if (this.started && tick !== this.lastTick + 1) this.gap = true;

    if (!this.started) {
      // 初回は基準を置くだけ（差分の相手がいないので何も数えない）。
      this.snapResources(w);
      this.snapCensus(w);
      this.snapFronts(w, false);
      this.started = true;
      this.lastTick = tick;
      this.pushSeries(tick);
      return;
    }

    this.accumulateResources(w);
    this.diffCensus(w);
    this.snapFronts(w, true);

    this.snapResources(w);
    this.snapCensus(w);
    this.lastTick = tick;

    if (tick % SERIES_INTERVAL_TICKS === 0) this.pushSeries(tick);
  }

  /** 結果画面に渡す不変の写し。 */
  snapshot(): MatchStatsSnapshot {
    const players: PlayerStatsSnapshot[] = [];
    for (let p = 0; p < this.playerCount; p++) {
      const gathered: number[] = [];
      for (let r = 0; r < RESOURCE_COUNT; r++) {
        gathered.push(fxToAmount(this.gathered[p * RESOURCE_COUNT + r]!));
      }
      const perOrder: OrderPerf[] = [];
      for (let o = 0; o < ORDER_COUNT; o++) {
        const k = p * ORDER_COUNT + o;
        perOrder.push({
          order: o,
          orderId: ORDER_IDS[o]!,
          kills: this.orderKills[k]!,
          losses: this.orderLosses[k]!,
          buildingsDestroyed: this.orderBuildings[k]!,
          ticksActive: this.orderTicks[k]!,
          issued: this.orderIssued[k]!,
        });
      }
      players.push({
        player: p as PlayerId,
        gathered,
        kills: this.kills[p]!,
        losses: this.losses[p]!,
        buildingsDestroyed: this.buildingsDestroyed[p]!,
        buildingsLost: this.buildingsLost[p]!,
        perOrder,
        orderLog: [...this.orderLog[p]!],
        series: [...this.series[p]!],
      });
    }
    return { lastTick: this.lastTick, ticks: [...this.ticks], players, hasGap: this.gap };
  }

  // ------------------------------------------------------------------ 資源

  private snapResources(w: World): void {
    for (let p = 0; p < this.playerCount; p++) {
      const pl = w.players[p];
      if (pl === undefined) continue;
      for (let r = 0; r < RESOURCE_COUNT; r++) {
        this.prevRes[p * RESOURCE_COUNT + r] = pl.resources[r]!;
      }
    }
  }

  /**
   * 採集量の累計。**保有量の「増えた分」だけを足す**。
   *
   * sim は「これまでに採集した総量」を持たない（持つ必要がない）ので、
   * 保有量の正の差分で代用する。市場での購入と生産の払い戻しも
   * 正の差分に見えるが、`05§13-4` の目的は「内政偏重か早い攻めか」の形を出すことなので
   * この近似で足りる。
   */
  private accumulateResources(w: World): void {
    for (let p = 0; p < this.playerCount; p++) {
      const pl = w.players[p];
      if (pl === undefined) continue;
      for (let r = 0; r < RESOURCE_COUNT; r++) {
        const k = p * RESOURCE_COUNT + r;
        const d = pl.resources[r]! - this.prevRes[k]!;
        if (d > 0) this.gathered[k] = this.gathered[k]! + d;
      }
    }
  }

  private pushSeries(tick: number): void {
    this.ticks.push(tick);
    for (let p = 0; p < this.playerCount; p++) {
      let total = 0;
      for (let r = 0; r < RESOURCE_COUNT; r++) total += this.gathered[p * RESOURCE_COUNT + r]!;
      this.series[p]!.push(fxToAmount(total));
    }
  }

  // ------------------------------------------------------------------ census

  private ensureCensus(capacity: number): void {
    if (this.censusCapacity >= capacity) return;
    const grow = <T extends Uint8Array | Uint16Array | Int32Array>(
      old: T,
      make: (n: number) => T,
    ): T => {
      const next = make(capacity);
      next.set(old);
      return next;
    };
    this.censusAlive = grow(this.censusAlive, (n) => new Uint8Array(n));
    this.censusKind = grow(this.censusKind, (n) => new Uint8Array(n));
    this.censusOwner = grow(this.censusOwner, (n) => new Uint8Array(n));
    this.censusGen = grow(this.censusGen, (n) => new Uint16Array(n));
    this.censusDamager = grow(this.censusDamager, (n) => new Int32Array(n));
    this.censusFront = grow(this.censusFront, (n) => new Uint8Array(n));
    this.censusX = grow(this.censusX, (n) => new Int32Array(n));
    this.censusY = grow(this.censusY, (n) => new Int32Array(n));
    this.censusCapacity = capacity;
  }

  private snapCensus(w: World): void {
    const e = w.entities;
    this.ensureCensus(e.highWater > 0 ? e.highWater : 1);
    for (let i = 0; i < e.highWater; i++) {
      const alive = e.alive[i]! === 1 ? 1 : 0;
      this.censusAlive[i] = alive;
      if (alive === 0) continue;
      this.censusKind[i] = e.kind[i]!;
      this.censusOwner[i] = e.owner[i]!;
      this.censusGen[i] = e.generation[i]!;
      this.censusDamager[i] = e.lastDamagedBy[i]!;
      this.censusFront[i] = e.frontId[i]!;
      this.censusX[i] = e.x[i]!;
      this.censusY[i] = e.y[i]!;
    }
  }

  /**
   * census と今の World を突き合わせて、この tick に死んだものを数える。
   * 反復は index 昇順（`Map` を使わない。手順書 §0.3）。
   */
  private diffCensus(w: World): void {
    const e = w.entities;
    const upTo = this.censusCapacity < e.highWater ? this.censusCapacity : e.highWater;
    for (let i = 0; i < upTo; i++) {
      if (this.censusAlive[i] !== 1) continue;
      const stillThere = e.alive[i] === 1 && e.generation[i] === this.censusGen[i];
      if (stillThere) continue;
      this.countDeath(w, i);
    }
  }

  private countDeath(w: World, i: number): void {
    const kind = this.censusKind[i]!;
    const isUnit = kind === EntityKind.Unit;
    const isBuilding = kind === EntityKind.Building || kind === EntityKind.Attachment;
    if (!isUnit && !isBuilding) return; // 資源ノードと投射物は数えない

    const victim = this.censusOwner[i]!;
    const killer = this.censusDamager[i]!;
    const vx = this.censusX[i]!;
    const vy = this.censusY[i]!;

    // ---- 損失（被害者側）----
    if (victim < this.playerCount) {
      if (isUnit) {
        this.losses[victim] = this.losses[victim]! + 1;
        const vo = this.orderAtFront(w, victim as PlayerId, this.censusFront[i]!);
        if (vo >= 0) {
          const k = victim * ORDER_COUNT + vo;
          this.orderLosses[k] = this.orderLosses[k]! + 1;
        }
      } else {
        this.buildingsLost[victim] = this.buildingsLost[victim]! + 1;
      }
    }

    // ---- 撃破（加害者側）----
    // 友軍被害（同チーム）は撃破に数えない。損失だけが増える。
    if (killer < 0 || killer >= this.playerCount) return;
    if (victim < this.playerCount && areAllies(w, killer as PlayerId, victim as PlayerId)) return;
    if (isUnit) this.kills[killer] = this.kills[killer]! + 1;
    else this.buildingsDestroyed[killer] = this.buildingsDestroyed[killer]! + 1;

    // 令ごとの成績: **倒した場所を含む加害者の戦域**の令に付ける。
    // 「どのカードで勝ったか」を出すのが目的なので、令が効いている輪の中で
    // 起きた撃破をその令の成果とみなす（輪の外＝手動操作はどの令にも付かない）。
    const oi = this.orderAtPoint(w, killer as PlayerId, vx, vy);
    if (oi < 0) return;
    const k = killer * ORDER_COUNT + oi;
    if (isUnit) this.orderKills[k] = this.orderKills[k]! + 1;
    else this.orderBuildings[k] = this.orderBuildings[k]! + 1;
  }

  /** そのプレイヤーの slot 番の戦域に効いている令（`ORDER_IDS` 添字。無ければ -1）。 */
  private orderAtFront(w: World, p: PlayerId, slot: number): number {
    if (slot < 1 || slot > MAX_FRONTS) return -1;
    const f = w.fronts[frontIndex(p, slot)];
    if (f === undefined || !f.active) return -1;
    return orderIndexOf(effectiveOrderOf(f));
  }

  /**
   * 点 (x, y) を含む、そのプレイヤーの戦域の令（`ORDER_IDS` 添字。無ければ -1）。
   * **slot 昇順の最初の 1 つ**を採る（同点を乱数で選ばない）。
   */
  private orderAtPoint(w: World, p: PlayerId, x: number, y: number): number {
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      const f = w.fronts[frontIndex(p, slot)];
      if (f === undefined || !f.active) continue;
      const dx = f.x - x;
      const dy = f.y - y;
      if (dx * dx + dy * dy > f.radius * f.radius) continue;
      return orderIndexOf(effectiveOrderOf(f));
    }
    return -1;
  }

  // ------------------------------------------------------------------ 戦域と令

  /**
   * 戦域の令を観測する。
   *  - `pendingOrder` が現れた → 「令を出した」（履歴に行を足す）
   *  - `order` が変わった → 「令が届いた」（履歴の行に届いた tick を書く）
   *  - 効いている令の tick を数える（`ticksActive`）
   *
   * @param count false = 初回（基準を置くだけで数えない）
   */
  private snapFronts(w: World, count: boolean): void {
    for (let p = 0; p < this.playerCount; p++) {
      for (let slot = 1; slot <= MAX_FRONTS; slot++) {
        const fi = frontIndex(p as PlayerId, slot);
        const f = w.fronts[fi];
        if (f === undefined) continue;
        const li = p * MAX_FRONTS + (slot - 1);

        // ---- 令をセットした（配達中の令が新しく現れた）----
        const pend = f.pendingOrder;
        const pendOrder = pend === null ? 0 : orderIndexOf(pend.id) + 1;
        const pendAt = pend === null ? -1 : pend.deliverAtTick;
        const isNewPending =
          pend !== null &&
          (this.prevPendingOrder[li] !== pendOrder || this.prevPendingAt[li] !== pendAt);
        if (count && isNewPending && pend !== null) {
          const o = pendOrder - 1;
          const log = this.orderLog[p]!;
          this.pendingLogIdx[li] = log.length;
          log.push({
            slot,
            order: o,
            orderId: ORDER_IDS[o]!,
            tier: pend.tier,
            issuedTick: w.tick,
            deliveredTick: -1,
          });
          const k = p * ORDER_COUNT + o;
          this.orderIssued[k] = this.orderIssued[k]! + 1;
        }
        this.prevPendingOrder[li] = pendOrder;
        this.prevPendingAt[li] = pendAt;

        // ---- 令が届いた（`order` が変わった）----
        const cur = f.order === null ? 0 : orderIndexOf(f.order) + 1;
        if (count && cur !== this.prevOrder[li] && cur !== 0) {
          const idx = this.pendingLogIdx[li]!;
          const log = this.orderLog[p]!;
          const row = idx >= 0 ? log[idx] : undefined;
          if (row !== undefined && row.order === cur - 1 && row.deliveredTick < 0) {
            log[idx] = { ...row, deliveredTick: w.tick };
            this.pendingLogIdx[li] = -1;
          }
        }
        this.prevOrder[li] = cur;

        // ---- 効いている令の tick ----
        if (count && f.active) {
          const o = orderIndexOf(effectiveOrderOf(f));
          if (o >= 0) {
            const k = p * ORDER_COUNT + o;
            this.orderTicks[k] = this.orderTicks[k]! + 1;
          }
        }
      }
    }
  }
}

/** `OrderId | null` → `ORDER_IDS` の添字（null は -1）。 */
export function orderIndexOf(id: OrderId | null): number {
  if (id === null) return -1;
  const i = ORDER_IDS.indexOf(id);
  return i;
}

// ---------------------------------------------------------------------------
// 表示のための純関数（DOM を触らない = jsdom が無くてもテストできる）
// ---------------------------------------------------------------------------

/** グラフの描画枠（px）。 */
export interface GraphBox {
  readonly width: number;
  readonly height: number;
  /** 左右の内側余白。 */
  readonly padX: number;
  /** 上下の内側余白。 */
  readonly padY: number;
}

/**
 * 積み上げバーの各区間の幅（px）。
 *
 * `05§13-4`「採集した 4 資源の量を積み上げバーで。緑が長いほど内政偏重」。
 * **合計が `totalPx` にぴったり一致する**ように、丸め誤差は最後の区間に寄せる
 * （区間ごとに `Math.round` すると 1px の隙間ができて縞に見える）。
 */
export function stackedSegments(values: readonly number[], totalPx: number): number[] {
  const sum = values.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const out = new Array<number>(values.length).fill(0);
  if (sum <= 0 || totalPx <= 0) return out;
  let used = 0;
  let last = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]! > 0 ? values[i]! : 0;
    if (v <= 0) continue;
    last = i;
  }
  for (let i = 0; i < values.length; i++) {
    const v = values[i]! > 0 ? values[i]! : 0;
    if (v <= 0) continue;
    if (i === last) {
      out[i] = totalPx - used;
      break;
    }
    const px = Math.floor((v / sum) * totalPx);
    out[i] = px;
    used += px;
  }
  return out;
}

/**
 * 折れ線の点列（SVG の `points` 属性の形）。
 *
 * y は「上が大きい」向きに反転する。`maxValue` が 0 のときは全点を下端に置く
 * （0 除算で NaN を混ぜると SVG が丸ごと描かれない）。
 */
export function seriesPolyline(
  values: readonly number[],
  ticks: readonly number[],
  maxValue: number,
  maxTick: number,
  box: GraphBox,
): string {
  const n = values.length < ticks.length ? values.length : ticks.length;
  if (n === 0) return '';
  const w = box.width - box.padX * 2;
  const h = box.height - box.padY * 2;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const tx = maxTick > 0 ? ticks[i]! / maxTick : n > 1 ? i / (n - 1) : 0;
    const ty = maxValue > 0 ? values[i]! / maxValue : 0;
    const x = box.padX + tx * w;
    const y = box.padY + (1 - ty) * h;
    parts.push(`${round1(x)},${round1(y)}`);
  }
  return parts.join(' ');
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * 「線が離れた瞬間」の標本番号（`05§13-6`）。
 *
 * 全プレイヤーの系列から、**1 区間で最大・最小の差（gap）が最も大きく開いた区間**の
 * 終端を返す。ここがリプレイの頭出し位置になる。
 * 同じ増加量が複数あれば**早い方**を採る（乱数を使わない）。
 * 標本が 2 点未満、または一度も開かなかったときは -1。
 */
export function divergenceSampleIndex(series: readonly (readonly number[])[]): number {
  if (series.length < 2) return -1;
  let n = Number.MAX_SAFE_INTEGER;
  for (const s of series) if (s.length < n) n = s.length;
  if (n < 2) return -1;

  const gapAt = (i: number): number => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const s of series) {
      const v = s[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  };

  let best = -1;
  let bestGrowth = 0;
  for (let i = 1; i < n; i++) {
    const growth = gapAt(i) - gapAt(i - 1);
    if (growth > bestGrowth) {
      bestGrowth = growth;
      best = i;
    }
  }
  return best;
}

/** tick → `mm:ss`（25 tick/秒）。結果画面とリプレイの頭出し表示で共通。 */
export function tickToClock(tick: number, tickRate = 25): string {
  const sec = Math.floor(tick / tickRate);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
