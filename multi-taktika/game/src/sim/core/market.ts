/**
 * sim/core/market.ts — 相場・資源交換・交易・貢納（`07§8`, 実装手順書 §6.6。M4 / T-M4-05〜07）
 *
 * `07§8` の規則:
 *  - 市場の相場: ある資源を **100 単位買うごとに +3%**、**30 秒ごとに 1% ずつ元に戻る**。
 *    相場は **全プレイヤー共通**（`World.market.priceMul`）なので、値動きが相手の行動を漏らす。
 *  - 交易収入: 金 = **片道距離 × 0.5**。荷車 1 台の**往復ごと**に入る。
 *  - 貢納（チーム戦）: **手数料 10%**（100 送ると相手に 90）。
 *
 * 決定論について:
 *  - 相場は Fx（実数 × 256）。倍率の上げ下げは **加算**で行う（0.03 の複利にすると
 *    Fx の丸めが指数的に効いてしまうため。`07§8` の「+3%」も基準価格に対する加算として扱う）。
 *  - 「30 秒ごと」は `World.market.lastDecayTick` と `World.tick` の差で判定する。
 *    `Date.now()` は使わない（§0.3）。
 *
 * **申し送り（config.json に足したいキー）**:
 *  | キー | 用途 | 暫定既定値 |
 *  |---|---|---|
 *  | `economy.marketBasePriceGold` | 資源 1 単位の基準価格（金） | 1.0 |
 *  | `economy.marketPriceUnitStep` | 価格が上がる購入単位（「100 単位ごと」の 100） | 100 |
 *  | `economy.marketDecayIntervalSec` | 相場が戻る間隔（「30 秒ごと」の 30） | 30 |
 *  | `economy.marketSellRatio` | 売却時の受取率（資料に規定なし） | 1.0 |
 *  キーを追加すればコード変更なしでそのまま効く（`cfgNumOrDefault` 経由）。
 */

import type { PlayerId } from '@/shared/types';
import { RESOURCE_IDS, resourceIndex } from '@/shared/types';

import { TICK_RATE, cfgFx, cfgNum } from './config';
import { BP, bpToFx, cfgBp } from './gather';
import type { Fx } from './fx';
import { FX_ONE, fx, fxMul, idiv } from './fx';
import type { World } from './world';
import { areAllies, getPlayer } from './world';

/** 金の資源 index（交易・貢納の受け皿）。 */
export const GOLD_RESOURCE = resourceIndex('gold');

// ---------------------------------------------------------------- 設定値

/** 価格が 1 段上がる購入単位（既定 100 単位）。 */
export function marketPriceUnitStep(): number {
  return cfgNum('economy.marketPriceUnitStep');
}

/** 100 単位あたりの値上がり幅（Fx 比率。既定 +3%）。 */
export function marketPriceUpStepFx(): Fx {
  return cfgFx('economy.marketPriceUpPer100');
}

/** 相場が戻る間隔（tick。既定 30 秒）。 */
export function marketDecayIntervalTicks(): number {
  return Math.round(cfgNum('economy.marketDecayIntervalSec') * TICK_RATE);
}

/** 1 回の戻しで下がる幅（Fx 比率。既定 1%）。 */
export function marketDecayStepFx(): Fx {
  return cfgFx('economy.marketDecayPer30s');
}

/** 資源 1 単位の基準価格（金、Fx）。相場倍率を掛ける前の値。 */
export function marketBasePriceGoldFx(_resource: number): Fx {
  return fx(cfgNum('economy.marketBasePriceGold'));
}

/** 売却時の受取率（Fx）。 */
export function marketSellRatioFx(): Fx {
  return fx(cfgNum('economy.marketSellRatio'));
}

// ---------------------------------------------------------------- 相場

/** 現在の相場倍率（Fx。開始 1.0 = FX_ONE）。 */
export function marketPriceMulFx(w: World, resource: number): Fx {
  const v = w.market.priceMul[resource];
  if (v === undefined) throw new Error(`market: 範囲外の資源 index ${resource}`);
  return v;
}

/** 現在の 1 単位あたりの購入価格（金、Fx）。 */
export function marketUnitPriceGoldFx(w: World, resource: number): Fx {
  return fxMul(marketBasePriceGoldFx(resource), marketPriceMulFx(w, resource));
}

/** 購入見積りの結果。 */
export interface BuyQuote {
  /** 支払う金の総額（Fx）。 */
  readonly costGoldFx: Fx;
  /** 購入後の相場倍率（Fx）。 */
  readonly nextPriceMulFx: Fx;
}

/**
 * `units` 単位を買うときの総額と購入後の相場を求める（World は書き換えない）。
 *
 * 価格は購入の途中でも上がっていく。`marketPriceUnitStep`（100）単位ごとに
 * `marketPriceUpStepFx`（+3%）だけ倍率が上がり、**残りの端数は比例配分**する。
 * こうしないと「99 単位ずつ買えば永遠に値上がりしない」抜け道ができる。
 *
 * 一括購入が分割購入より高くつくのは、**分割の間に相場が戻る**（30 秒ごとに 1%）ため。
 * `07§8`「一気に買うほど損」の正体はこの戻しである（T-M4-05 のテストで数値検証）。
 */
export function quoteBuy(w: World, resource: number, units: number): BuyQuote {
  const base = marketBasePriceGoldFx(resource);
  const step = marketPriceUnitStep();
  const up = marketPriceUpStepFx();
  let mul = marketPriceMulFx(w, resource);
  let remaining = Math.trunc(units);
  let cost = 0;
  while (remaining > 0) {
    const chunk = remaining < step ? remaining : step;
    cost += chunk * fxMul(base, mul);
    mul += idiv(chunk * up, step);
    remaining -= chunk;
  }
  return { costGoldFx: cost, nextPriceMulFx: mul };
}

/**
 * 資源を買う（金 → 資源）。金が足りなければ何もせず false。
 * 相場は**全プレイヤー共通**なので、誰が買っても `World.market` が動く。
 */
export function marketBuy(w: World, p: PlayerId, resource: number, units: number): boolean {
  const pl = getPlayer(w, p);
  if (pl === undefined) return false;
  if (resource < 0 || resource >= RESOURCE_IDS.length) return false;
  const n = Math.trunc(units);
  if (n <= 0) return false;
  const quote = quoteBuy(w, resource, n);
  if (pl.resources[GOLD_RESOURCE]! < quote.costGoldFx) return false;
  pl.resources[GOLD_RESOURCE] = pl.resources[GOLD_RESOURCE]! - quote.costGoldFx;
  pl.resources[resource] = pl.resources[resource]! + n * FX_ONE;
  w.market.priceMul[resource] = quote.nextPriceMulFx;
  return true;
}

/**
 * 資源を売る（資源 → 金）。
 *
 * `07§8` は買いの値上がりだけを規定しているので、**売却は相場を動かさない**。
 * 売却で相場が下がる仕様にするなら `marketSell` の中で `priceMul` を下げること
 * （申し送り: `economy.marketSellRatio` と合わせて要検討）。
 */
export function marketSell(w: World, p: PlayerId, resource: number, units: number): boolean {
  const pl = getPlayer(w, p);
  if (pl === undefined) return false;
  if (resource < 0 || resource >= RESOURCE_IDS.length) return false;
  const n = Math.trunc(units);
  if (n <= 0) return false;
  const have = n * FX_ONE;
  if (pl.resources[resource]! < have) return false;
  const gain = fxMul(n * marketUnitPriceGoldFx(w, resource), marketSellRatioFx());
  pl.resources[resource] = pl.resources[resource]! - have;
  pl.resources[GOLD_RESOURCE] = pl.resources[GOLD_RESOURCE]! + gain;
  return true;
}

/**
 * 相場を元に戻す（30 秒ごとに 1%）。`economy` システムが毎 tick 呼ぶ。
 * 経過が 30 秒の何倍でも取りこぼさないよう、溜まった回数だけまとめて戻す。
 * 1.0 より下には戻らない（買いでしか上がらないため）。
 */
export function applyMarketDecay(w: World): void {
  const interval = marketDecayIntervalTicks();
  if (interval <= 0) return;
  const elapsed = w.tick - w.market.lastDecayTick;
  if (elapsed < interval) return;
  const steps = idiv(elapsed, interval);
  const down = marketDecayStepFx() * steps;
  for (let r = 0; r < w.market.priceMul.length; r++) {
    const next = w.market.priceMul[r]! - down;
    w.market.priceMul[r] = next < FX_ONE ? FX_ONE : next;
  }
  w.market.lastDecayTick += steps * interval;
}

// ---------------------------------------------------------------- 交易（T-M4-06）

/**
 * 荷車 1 台の往復で入る金（Fx）。**金 = 片道距離 × 0.5**（`07§8`）。
 * 片道 100 マス → 50（`§14.2` の検算値）。遠い相手と繋ぐほど収入が増える。
 */
export function tradeGoldPerRoundTripFx(oneWayDistFx: Fx): Fx {
  if (oneWayDistFx <= 0) return 0;
  return fxMul(oneWayDistFx, cfgFx('economy.tradeGoldPerTile'));
}

// ---------------------------------------------------------------- 貢納（T-M4-07）

/** 貢納の内訳。 */
export interface TributeSplit {
  /** 手数料（Fx）。 */
  readonly feeFx: Fx;
  /** 相手に届く量（Fx）。 */
  readonly receivedFx: Fx;
}

/**
 * 貢納の手数料計算（手数料 10%）。100 送ると 90 届く。
 * 端数は手数料側を切り捨て、届く側に寄せない（送り主の損を過大にしないため）。
 */
export function tributeSplit(amountFx: Fx): TributeSplit {
  if (amountFx <= 0) return { feeFx: 0, receivedFx: 0 };
  const feeBp = cfgBp('economy.tributeFeeRatio');
  const fee = idiv(amountFx * feeBp, BP);
  return { feeFx: fee, receivedFx: amountFx - fee };
}

/** 手数料率（Fx。表示用）。 */
export function tributeFeeRatioFx(): Fx {
  return bpToFx(cfgBp('economy.tributeFeeRatio'));
}

/**
 * 味方へ資源を送る（チーム戦。手数料 10%）。
 *  - 送り主から `amountFx` 全額を引き、受取側には手数料を差し引いた分だけ入る。
 *  - `areAllies` が false（敵）なら何もせず false。自分自身への貢納も不可。
 *  - 資源が足りなければ false。
 */
export function tribute(
  w: World,
  from: PlayerId,
  to: PlayerId,
  resource: number,
  amountFx: Fx
): boolean {
  if (from === to) return false;
  if (!areAllies(w, from, to)) return false;
  if (resource < 0 || resource >= RESOURCE_IDS.length) return false;
  if (amountFx <= 0) return false;
  const src = getPlayer(w, from);
  const dst = getPlayer(w, to);
  if (src === undefined || dst === undefined) return false;
  if (src.resources[resource]! < amountFx) return false;
  const split = tributeSplit(amountFx);
  src.resources[resource] = src.resources[resource]! - amountFx;
  dst.resources[resource] = dst.resources[resource]! + split.receivedFx;
  return true;
}
