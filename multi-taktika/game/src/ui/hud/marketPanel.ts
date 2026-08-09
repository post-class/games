/**
 * ui/hud/marketPanel.ts — 市場（資源交換・交易）パネル（`05§11` の 7 項目。T-M12-07）
 *
 * ■ `05§11` の 7 項目との対応
 *   1 食料・木材・石材を売れば金に、金を払えば買える → `MarketRowView.buyCommand` / `sellCommand`
 *   2 金は交換の基準                                → `MarketPanelModel.gold`
 *   3 交換比率は**全プレイヤー共通の相場**。同じ資源を買い続けると値が上がる（一気に買うほど損）
 *                                                  → `priceMul` / `buyCostBulk` / `bulkPenaltyPct`
 *   4 相場の推移（直近の値動き）                     → `history` / `trend` / `trendText`
 *   5 売買ボタンは 100 単位ずつ。長押しで連続        → `TRADE_STEP`（= `economy.marketPriceUnitStep`）
 *   6 交易荷車（距離が遠いほど儲かる）               → `TradeRouteView.goldPerRoundTrip`
 *   7 交易先の選択（交易路が戦域に重なると狙われる） → `TradeRouteView.crossesFront`
 *
 * ■ 制約
 *   - World は**読むだけ**。売買は `marketTrade` Command を `emit` するだけ（手順書 §3.1）。
 *     相場は sim 側（`core/market.ts`）が全プレイヤー共通で動かす。UI は倍率を**表示するだけ**。
 *   - 価格・値上がり幅・交易収入の係数は `core/market.ts` から引く。UI に数値を書かない。
 *   - **このパネルを開いても試合は止まらない**（`05§1`）。
 *
 * ■ 申し送り
 *   交易先の割り当ては sim 側に `assignTradeRoute`（`systems/economy.ts`）があるが、
 *   **対応する `Command` がまだ無い**（`sim/command.ts` の 16 種に交易路が無い）。
 *   UI からは World を書き換えられないので、このパネルは選択結果を
 *   `MarketPanelContext.selectTradeRoute` に**通知するだけ**にしてある。
 *   `Command` に `assignTradeRoute` が入ったら、そこで emit するように差し替えること。
 */

import {
  RESOURCE_COUNT,
  RESOURCE_IDS,
  type EntityId,
  type PlayerId,
  type ResourceId,
} from '@/shared/types';
import { EntityKind } from '@/shared/types';
import type { Command } from '@/sim/command';
import { buildingDef, civDefById, unitDef } from '@/sim/core/defs';
import { getPlayerModifiers, isBuildingComplete, tradeIncomeMul } from '@/sim/core/effects';
import { idOfIndex } from '@/sim/core/entity';
import { ownFronts } from '@/sim/core/front';
import { FX_ONE, fxMul, fxToNumber } from '@/sim/core/fx';
import { TRADE_CART_TYPE, distanceFx } from '@/sim/core/gather';
import {
  GOLD_RESOURCE,
  marketPriceMulFx,
  marketPriceUnitStep,
  marketSellRatioFx,
  marketUnitPriceGoldFx,
  quoteBuy,
  tradeGoldPerRoundTripFx,
} from '@/sim/core/market';
import { getPlayer, type World } from '@/sim/core/world';
import { resourceColor, resourceGlyph } from '@/render/palette';

/** 売買の 1 クリックぶんの単位（`05§11-5`「100 単位ずつ」= `economy.marketPriceUnitStep`）。 */
export function tradeStep(): number {
  return marketPriceUnitStep();
}

/** 「一気に買うほど損」を見せるための比較用のまとめ買い倍数。 */
export const BULK_MULTIPLIER = 5;

/** 相場の推移を残す本数（UI ローカル。決定論の対象外）。 */
export const PRICE_HISTORY_LEN = 60;

/** 相場を標本化する間隔（ms。UI ローカル）。 */
export const PRICE_SAMPLE_INTERVAL_MS = 1000;

/** 長押しの連続売買の間隔（ms。`05§11-5`「長押しで連続」）。 */
export const REPEAT_INTERVAL_MS = 220;

// ---------------------------------------------------------------- 相場の推移

/** 相場の推移（資源ごとのリングバッファ。**端末ローカルの表示用**）。 */
export interface PriceHistory {
  /** `samples[resource]` = 古い順の相場倍率（実数）。 */
  readonly samples: number[][];
  /** 最後に標本を取った時刻（ms）。 */
  lastMs: number;
}

export function createPriceHistory(): PriceHistory {
  return {
    samples: Array.from({ length: RESOURCE_COUNT }, () => [] as number[]),
    lastMs: 0,
  };
}

/**
 * 相場の標本を 1 つ足す（World は読むだけ）。
 * `05§11-4`「相手が石材を買い漁っていれば城か壁を建てていると読める」ための値動き。
 */
export function samplePrices(h: PriceHistory, w: World, nowMs: number): boolean {
  if (h.lastMs !== 0 && nowMs - h.lastMs < PRICE_SAMPLE_INTERVAL_MS) return false;
  h.lastMs = nowMs;
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    const arr = h.samples[r];
    if (arr === undefined) continue;
    arr.push(fxToNumber(marketPriceMulFx(w, r)));
    if (arr.length > PRICE_HISTORY_LEN) arr.shift();
  }
  return true;
}

/** 直近の値動き（最後の値 − 最初の値）。正 = 買われて値上がりしている。 */
export function trendOf(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const first = values[0]!;
  const last = values[values.length - 1]!;
  return Math.round((last - first) * 1000) / 1000;
}

/** 値動きの読み（`05§11-4`）。 */
export function trendTextOf(label: string, trend: number): string {
  if (trend > 0) return `${label}が買われている（値上がり中）`;
  if (trend < 0) return `${label}の相場が戻っている`;
  return `${label}の相場は動いていない`;
}

/**
 * 折れ線の頂点列（`x,y` の空白区切り。SVG の `polyline` にそのまま渡せる）。
 * 値域は「1.0（基準）〜最大値」。相場は 1.0 より下がらない（`core/market.ts`）。
 */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number
): string {
  if (values.length === 0) return '';
  let max = 1;
  for (const v of values) if (v > max) max = v;
  const span = max - 1 <= 0 ? 1 : max - 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const pts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const x = Math.round(i * stepX * 10) / 10;
    const y = Math.round((height - ((values[i]! - 1) / span) * height) * 10) / 10;
    pts.push(`${x},${y}`);
  }
  return pts.join(' ');
}

// ---------------------------------------------------------------- 表示モデル

/** 交換に出す資源 1 行。 */
export interface MarketRowView {
  readonly resource: number;
  readonly id: ResourceId;
  readonly glyph: string;
  readonly color: string;
  /** 現在の相場倍率（**全プレイヤー共通**）。 */
  readonly priceMul: number;
  /** 現在の 1 単位あたりの購入価格（金）。 */
  readonly unitPriceGold: number;
  /** 100 単位買うときの総額（金）。 */
  readonly buyCost: number;
  /** まとめ買い（100 × `BULK_MULTIPLIER`）の総額（金）。 */
  readonly buyCostBulk: number;
  /** まとめ買いの平均単価が現在単価より何 % 高いか（`05§11-3`「一気に買うほど損」）。 */
  readonly bulkPenaltyPct: number;
  /** 100 単位売って入る金。 */
  readonly sellGain: number;
  /** 手持ち（表示用の整数）。 */
  readonly stock: number;
  readonly canBuy: boolean;
  readonly canSell: boolean;
  readonly trend: number;
  readonly trendText: string;
  readonly history: readonly number[];
  readonly buyCommand: Command;
  readonly sellCommand: Command;
}

/** 交易先 1 件（`05§11-6` / `05§11-7`）。 */
export interface TradeRouteView {
  /** 相手の市場。 */
  readonly partner: EntityId;
  readonly owner: PlayerId;
  readonly ownerName: string;
  /** 片道距離（マス）。**遠いほど儲かる**。 */
  readonly distanceTiles: number;
  /** 荷車 1 台の往復で入る金（研究「隊商」込み）。 */
  readonly goldPerRoundTrip: number;
  /** 交易路が自軍の戦域に重なっているか（狙われる）。 */
  readonly crossesFront: boolean;
}

/** 市場パネル全体。 */
export interface MarketPanelModel {
  /** 自分の市場（無ければ `null`。市場が無ければ売買できない）。 */
  readonly ownMarket: EntityId | null;
  readonly ownMarketName: string;
  /** 金（交換の基準。`05§11-2`）。 */
  readonly gold: number;
  /** 食料・木材・石材の行（金は行にしない）。 */
  readonly rows: readonly MarketRowView[];
  readonly routes: readonly TradeRouteView[];
  /** 交易荷車を作る Command（自分の市場がある時だけ）。 */
  readonly cartCommand: Command | null;
  readonly cartCostText: string;
  /** 売買の単位（100）。 */
  readonly step: number;
}

/** 市場の建物 ID（`units.json:trade_cart.producedAt` から引く。ID を書き写さない）。 */
export function marketBuildingId(): string {
  return unitDef(TRADE_CART_TYPE).producedAt;
}

/** 自分の完成済みの市場（無ければ -1）。 */
export function findOwnMarketIndex(w: World, p: PlayerId): number {
  const e = w.entities;
  const marketId = marketBuildingId();
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    const def = buildingDef(e.typeId[i]!);
    if (def.id !== marketId && def.replaces !== marketId) continue;
    if (!isBuildingComplete(w, i)) continue;
    return i;
  }
  return -1;
}

/** 点と線分の距離（マス単位の実数。表示用なので固定小数点でなくてよい）。 */
export function pointSegmentDistanceTiles(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = x0 + t * dx;
  const cy = y0 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * 交易路が自軍の戦域に重なるか（`05§11-7`「交易路が戦域に重なると荷車が狙われます」）。
 * 戦域は自分が見えているものだけで判定する（敵の戦域の中身は見えない）。
 */
export function routeCrossesFront(
  w: World,
  viewer: PlayerId,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): boolean {
  for (const f of ownFronts(w, viewer)) {
    const d = pointSegmentDistanceTiles(
      fxToNumber(f.x),
      fxToNumber(f.y),
      x0,
      y0,
      x1,
      y1
    );
    if (d <= fxToNumber(f.radius)) return true;
  }
  return false;
}

/** 交易先の候補（他プレイヤーの市場）。距離が遠いほど儲かる。 */
export function tradeRoutes(
  w: World,
  viewer: PlayerId,
  isVisible?: (xFx: number, yFx: number) => boolean
): TradeRouteView[] {
  const own = findOwnMarketIndex(w, viewer);
  if (own < 0) return [];
  const e = w.entities;
  const marketId = marketBuildingId();
  const m = getPlayerModifiers(w, viewer);
  const ox = e.x[own]!;
  const oy = e.y[own]!;
  const out: TradeRouteView[] = [];
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    const owner = e.owner[i]!;
    if (owner === viewer || owner >= w.playerCount) continue;
    const def = buildingDef(e.typeId[i]!);
    if (def.id !== marketId && def.replaces !== marketId) continue;
    if (!isBuildingComplete(w, i)) continue;
    if (isVisible !== undefined && !isVisible(e.x[i]!, e.y[i]!)) continue;
    const oneWay = distanceFx(ox, oy, e.x[i]!, e.y[i]!);
    const gold = fxMul(tradeGoldPerRoundTripFx(oneWay), tradeIncomeMul(m));
    const pl = getPlayer(w, owner);
    out.push({
      partner: idOfIndex(e, i),
      owner,
      ownerName: pl === undefined ? `P${owner + 1}` : `P${owner + 1} ${civDefById(pl.civ).name}`,
      distanceTiles: Math.round(fxToNumber(oneWay)),
      goldPerRoundTrip: Math.round(fxToNumber(gold)),
      crossesFront: routeCrossesFront(
        w,
        viewer,
        fxToNumber(ox),
        fxToNumber(oy),
        fxToNumber(e.x[i]!),
        fxToNumber(e.y[i]!)
      ),
    });
  }
  // 遠いほど儲かるので、儲かる順（同額は index 順）に並べる。
  out.sort((a, b) => b.goldPerRoundTrip - a.goldPerRoundTrip || a.partner - b.partner);
  return out;
}

/** 市場パネルの表示モデルを作る（DOM を触らない）。 */
export function buildMarketPanelModel(
  w: World,
  viewer: PlayerId,
  history: PriceHistory,
  isVisible?: (xFx: number, yFx: number) => boolean
): MarketPanelModel {
  const pl = getPlayer(w, viewer);
  const ownIdx = findOwnMarketIndex(w, viewer);
  const ownMarket = ownIdx < 0 ? null : idOfIndex(w.entities, ownIdx);
  const step = tradeStep();
  const rows: MarketRowView[] = [];

  for (let r = 0; r < RESOURCE_COUNT; r++) {
    if (r === GOLD_RESOURCE) continue; // 金は「交換の基準」なので行にしない
    const id = RESOURCE_IDS[r]!;
    const unit = fxToNumber(marketUnitPriceGoldFx(w, r));
    const quote = quoteBuy(w, r, step);
    const bulk = quoteBuy(w, r, step * BULK_MULTIPLIER);
    const buyCost = fxToNumber(quote.costGoldFx);
    const buyCostBulk = fxToNumber(bulk.costGoldFx);
    const avgBulk = buyCostBulk / (step * BULK_MULTIPLIER);
    const sellGain = fxToNumber(
      fxMul(step * marketUnitPriceGoldFx(w, r), marketSellRatioFx())
    );
    const stockFx = pl?.resources[r] ?? 0;
    const goldFx = pl?.resources[GOLD_RESOURCE] ?? 0;
    const hist = history.samples[r] ?? [];
    const trend = trendOf(hist);
    rows.push({
      resource: r,
      id,
      glyph: resourceGlyph(r),
      color: resourceColor(r),
      priceMul: Math.round(fxToNumber(marketPriceMulFx(w, r)) * 1000) / 1000,
      unitPriceGold: Math.round(unit * 1000) / 1000,
      buyCost: Math.round(buyCost),
      buyCostBulk: Math.round(buyCostBulk),
      bulkPenaltyPct: unit > 0 ? Math.round((avgBulk / unit - 1) * 100) : 0,
      sellGain: Math.round(sellGain),
      stock: Math.round(fxToNumber(stockFx)),
      canBuy: ownMarket !== null && goldFx >= quote.costGoldFx,
      canSell: ownMarket !== null && stockFx >= step * FX_ONE,
      trend,
      trendText: trendTextOf(resourceGlyph(r), trend),
      history: hist,
      // 買い = 金を売って資源を買う / 売り = 資源を売って金を買う（`sim/command.ts` の規則）
      buyCommand: { t: 'marketTrade', p: viewer, sell: 'gold', buy: id, amount: step },
      sellCommand: { t: 'marketTrade', p: viewer, sell: id, buy: 'gold', amount: step },
    });
  }

  const cartDef = unitDef(TRADE_CART_TYPE);
  return {
    ownMarket,
    ownMarketName: ownIdx < 0 ? '' : buildingDef(w.entities.typeId[ownIdx]!).name,
    gold: Math.round(fxToNumber(pl?.resources[GOLD_RESOURCE] ?? 0)),
    rows,
    routes: tradeRoutes(w, viewer, isVisible),
    cartCommand:
      ownMarket === null
        ? null
        : { t: 'produce', p: viewer, building: ownMarket, unit: cartDef.id, count: 1 },
    cartCostText: costTextOfCart(),
    step,
  };
}

/** 交易荷車のコスト表示（`units.json` から引く）。 */
function costTextOfCart(): string {
  const def = unitDef(TRADE_CART_TYPE);
  const parts: string[] = [];
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    const v = def.cost[r] ?? 0;
    if (v <= 0) continue;
    parts.push(`${resourceGlyph(r)}${Math.round(fxToNumber(v))}`);
  }
  return parts.join(' / ');
}

// ---------------------------------------------------------------- DOM（部品）

/** パネルが外に触るための窓口。 */
export interface MarketPanelContext {
  world(): World;
  readonly viewer: PlayerId;
  emit(cmd: Command): void;
  /** 視界の判定（省略時は全部見えている扱い）。 */
  isVisible?: (xFx: number, yFx: number) => boolean;
  /**
   * 交易先が選ばれた（`Command` がまだ無いので通知だけ。上の「申し送り」参照）。
   * 受け取った側が `systems/economy.ts:assignTradeRoute` を呼ぶか、
   * `Command` が入ったらそこで emit する。
   */
  selectTradeRoute?: (partnerMarket: EntityId) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPARK_W = 160;
const SPARK_H = 34;

/**
 * 市場（資源交換・交易）パネル。**開いても試合は止まらない**。
 *
 * ```ts
 * const market = new MarketPanel(overlayEl, { world: () => w, viewer: 0, emit });
 * market.toggle();        // `T` キー
 * market.update(nowMs);   // 毎フレーム（中で相場を標本化する）
 * ```
 */
export class MarketPanel {
  readonly root: HTMLElement;
  private readonly ctx: MarketPanelContext;
  private readonly goldEl: HTMLElement;
  private readonly rowsEl: HTMLElement;
  private readonly tradeEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly history: PriceHistory = createPriceHistory();
  private open = false;
  private repeatTimer: ReturnType<typeof setInterval> | null = null;
  private selectedRoute: EntityId | null = null;

  constructor(parent: HTMLElement, ctx: MarketPanelContext) {
    this.ctx = ctx;
    this.root = el('div', 'mt-panel mt-market mt-panel-hidden');

    const head = el('div', 'mt-panel-head');
    head.append(el('span', 'mt-panel-title', '市場（資源交換・交易）'));
    this.goldEl = el('span', 'mt-market-gold', '金 0');
    const close = el('button', 'mt-panel-close', '閉じる (T)');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(this.goldEl, close);

    this.rowsEl = el('div', 'mt-market-rows');
    this.tradeEl = el('div', 'mt-market-trade');
    this.noteEl = el('div', 'mt-market-note', '');

    this.root.append(head, this.rowsEl, this.tradeEl, this.noteEl);
    parent.appendChild(this.root);
  }

  get visible(): boolean {
    return this.open;
  }

  /** `T` キー / 市場のボタンから。 */
  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.root.classList.remove('mt-panel-hidden');
    this.update(0);
  }

  close(): void {
    this.open = false;
    this.stopRepeat();
    this.root.classList.add('mt-panel-hidden');
  }

  /**
   * 表示を作り直す。相場の推移は**閉じていても**標本を取る
   * （開いた瞬間にグラフが空だと「値動きから相手を読む」が成立しないため）。
   */
  update(nowMs: number): void {
    samplePrices(this.history, this.ctx.world(), nowMs);
    if (!this.open) return;
    const model = buildMarketPanelModel(
      this.ctx.world(),
      this.ctx.viewer,
      this.history,
      this.ctx.isVisible
    );

    this.goldEl.textContent = `金 ${model.gold}（交換の基準）`;

    // ---- 1/3/4/5 資源の行 ----
    this.rowsEl.textContent = '';
    for (const row of model.rows) {
      const line = el('div', 'mt-market-row');
      const name = el('div', 'mt-market-rname', `${row.glyph} ${row.stock}`);
      name.style.color = row.color;
      const price = el(
        'div',
        'mt-market-price',
        `相場 ×${row.priceMul}（1 単位 ${row.unitPriceGold} 金）`
      );
      const spark = this.sparkline(row.history, row.color);
      const trend = el('div', 'mt-market-trend', row.trendText);
      trend.classList.toggle('mt-market-up', row.trend > 0);
      trend.classList.toggle('mt-market-down', row.trend < 0);

      const buttons = el('div', 'mt-market-buttons');
      const sell = el('button', 'mt-market-sell', `売る ${model.step} → 金 ${row.sellGain}`);
      sell.type = 'button';
      sell.disabled = !row.canSell;
      sell.title = `${row.glyph} ${model.step} 単位を売って ${row.sellGain} 金`;
      this.bindRepeat(sell, row.sellCommand, () => row.canSell);

      const buy = el('button', 'mt-market-buy', `買う ${model.step} ← 金 ${row.buyCost}`);
      buy.type = 'button';
      buy.disabled = !row.canBuy;
      // 3 一気に買うほど損（まとめ買いの平均単価が上がることを数字で見せる）
      buy.title =
        `${row.glyph} ${model.step} 単位 = ${row.buyCost} 金\n` +
        `${model.step * BULK_MULTIPLIER} 単位まとめ買い = ${row.buyCostBulk} 金（平均単価 +${row.bulkPenaltyPct}%）\n` +
        '相場は全プレイヤー共通で、買うほど上がります';
      this.bindRepeat(buy, row.buyCommand, () => row.canBuy);
      buttons.append(sell, buy);

      line.append(name, price, spark, trend, buttons);
      this.rowsEl.appendChild(line);
    }

    // ---- 6/7 交易荷車と交易先 ----
    this.tradeEl.textContent = '';
    const tradeHead = el('div', 'mt-market-tradehead', '交易（距離が遠いほど儲かる）');
    this.tradeEl.appendChild(tradeHead);
    if (model.ownMarket === null) {
      this.tradeEl.appendChild(el('div', 'mt-market-empty', '市場を建てると売買と交易ができます。'));
    } else {
      const cart = el('button', 'mt-market-cart', `交易荷車を作る（${model.cartCostText}）`);
      cart.type = 'button';
      cart.addEventListener('click', () => {
        if (model.cartCommand !== null) this.ctx.emit(model.cartCommand);
      });
      this.tradeEl.appendChild(cart);
      if (model.routes.length === 0) {
        this.tradeEl.appendChild(el('div', 'mt-market-empty', '交易できる相手の市場が見つかりません。'));
      }
      for (const r of model.routes) {
        const b = el(
          'button',
          'mt-market-route',
          `${r.ownerName} — ${r.distanceTiles} マス / 往復 ${r.goldPerRoundTrip} 金${r.crossesFront ? '（戦域に重なる）' : ''}`
        );
        b.type = 'button';
        b.classList.toggle('mt-market-route-risky', r.crossesFront);
        b.classList.toggle('mt-market-route-active', this.selectedRoute === r.partner);
        b.title = r.crossesFront
          ? '交易路が戦域に重なっています。荷車が狙われます。'
          : '遠い相手と繋ぐほど 1 往復の金が増えます。';
        b.addEventListener('click', () => {
          this.selectedRoute = r.partner;
          this.ctx.selectTradeRoute?.(r.partner);
          this.update(nowMs);
        });
        this.tradeEl.appendChild(b);
      }
    }

    this.noteEl.textContent =
      '相場は全プレイヤー共通です。同じ資源を買い続けると値が上がり、時間で少しずつ戻ります。';
  }

  destroy(): void {
    this.stopRepeat();
    this.root.remove();
  }

  /** 折れ線（相場の推移）。 */
  private sparkline(values: readonly number[], color: string): HTMLElement {
    const wrap = el('div', 'mt-market-spark');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', sparklinePoints(values, SPARK_W, SPARK_H));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '2');
    svg.appendChild(line);
    wrap.appendChild(svg);
    return wrap;
  }

  /** クリックで 1 回、長押しで連続（`05§11-5`）。 */
  private bindRepeat(node: HTMLElement, cmd: Command, allowed: () => boolean): void {
    const fire = (): void => {
      if (!allowed()) return;
      this.ctx.emit(cmd);
    };
    node.addEventListener('mousedown', (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      fire();
      this.stopRepeat();
      this.repeatTimer = setInterval(fire, REPEAT_INTERVAL_MS);
    });
    node.addEventListener('mouseup', () => this.stopRepeat());
    node.addEventListener('mouseleave', () => this.stopRepeat());
  }

  private stopRepeat(): void {
    if (this.repeatTimer === null) return;
    clearInterval(this.repeatTimer);
    this.repeatTimer = null;
  }
}
