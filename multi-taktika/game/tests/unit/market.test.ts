/**
 * T-M4-05〜07: 市場の相場・交易荷車・貢納（`07§8` / 手順書 §6.6, §14.2）
 *
 * 検証する数値:
 *  - 100 単位買うごとに +3%、30 秒ごとに 1% ずつ戻る（相場は全プレイヤー共通）
 *  - 1000 単位の一括購入が 10 回分割より高くつく（T-M4-05 の完了条件）
 *  - 交易金 = 片道距離 × 0.5（片道 100 マスで 50。`§14.2` の検算値）
 *  - 貢納は手数料 10%（100 送ると 90 入る）
 */

import { describe, expect, it } from 'vitest';

import { resourceIndex } from '@/shared/types';
import { FX_ONE, fx, fxFromInt, fxToNumber } from '@/sim/core/fx';
import { createWorld, type World } from '@/sim/core/world';
import {
  GOLD_RESOURCE,
  applyMarketDecay,
  marketBuy,
  marketDecayIntervalTicks,
  marketDecayStepFx,
  marketPriceMulFx,
  marketPriceUnitStep,
  marketSell,
  marketUnitPriceGoldFx,
  quoteBuy,
  tradeGoldPerRoundTripFx,
  tribute,
  tributeFeeRatioFx,
  tributeSplit,
} from '@/sim/core/market';

const FOOD = resourceIndex('food');
const WOOD = resourceIndex('wood');

function makeWorld(teams?: readonly number[]): World {
  return createWorld({
    seed: 7,
    playerCount: 3,
    mapWidthTiles: 200,
    mapHeightTiles: 200,
    ...(teams !== undefined ? { teams } : {}),
  });
}

describe('相場の基本（T-M4-05）', () => {
  it('開始時の倍率は 1.0、全資源共通の配列に入っている', () => {
    const w = makeWorld();
    for (let r = 0; r < w.market.priceMul.length; r++) {
      expect(w.market.priceMul[r]).toBe(FX_ONE);
    }
    expect(marketPriceMulFx(w, FOOD)).toBe(FX_ONE);
  });

  it('100 単位買うと約 +3%、200 単位で約 +6%', () => {
    const w = makeWorld();
    const q1 = quoteBuy(w, FOOD, 100);
    expect(fxToNumber(q1.nextPriceMulFx)).toBeCloseTo(1.03, 2);
    const q2 = quoteBuy(w, FOOD, 200);
    expect(fxToNumber(q2.nextPriceMulFx)).toBeCloseTo(1.06, 2);
    // 端数（50 単位）は比例配分される → 「99 単位ずつ買えば値上がりしない」抜け道を作らない
    const q3 = quoteBuy(w, FOOD, 50);
    expect(q3.nextPriceMulFx).toBeGreaterThan(FX_ONE);
    expect(q3.nextPriceMulFx).toBeLessThan(q1.nextPriceMulFx);
    expect(marketPriceUnitStep()).toBe(100);
  });

  it('相場は全プレイヤー共通（誰が買っても同じ値が動く）', () => {
    const w = makeWorld();
    w.players[1]!.resources[GOLD_RESOURCE] = fx(100000);
    expect(marketBuy(w, 1, WOOD, 300)).toBe(true);
    // 買っていないプレイヤー 0 から見た価格も上がっている
    expect(marketPriceMulFx(w, WOOD)).toBeGreaterThan(FX_ONE);
    expect(marketUnitPriceGoldFx(w, WOOD)).toBeGreaterThan(FX_ONE);
    // 別資源は動かない
    expect(marketPriceMulFx(w, FOOD)).toBe(FX_ONE);
  });

  it('30 秒ごとに 1% ずつ戻り、1.0 より下には行かない', () => {
    const w = makeWorld();
    w.players[0]!.resources[GOLD_RESOURCE] = fx(100000);
    marketBuy(w, 0, FOOD, 1000);
    const peak = marketPriceMulFx(w, FOOD);
    const interval = marketDecayIntervalTicks();
    expect(interval).toBe(750); // 30 秒 × 25 tick

    w.tick = interval;
    applyMarketDecay(w);
    const after1 = marketPriceMulFx(w, FOOD);
    expect(after1).toBeLessThan(peak);
    expect(fxToNumber(peak - after1)).toBeCloseTo(0.01, 2);

    // 溜まった分はまとめて戻る（取りこぼさない）。
    // 相場は Fx なので 1% は 3/256（= 1.17%）に丸まる。4 回分ちょうど戻ることを見る。
    w.tick = interval * 5;
    applyMarketDecay(w);
    expect(after1 - marketPriceMulFx(w, FOOD)).toBe(marketDecayStepFx() * 4);

    // 十分な時間が経てば 1.0 で止まる
    w.tick = interval * 1000;
    applyMarketDecay(w);
    expect(marketPriceMulFx(w, FOOD)).toBe(FX_ONE);
  });

  it('1000 単位の一括購入は、30 秒ずつ空けた 10 回分割より高くつく', () => {
    // --- 一括 ---
    const bulk = makeWorld();
    bulk.players[0]!.resources[GOLD_RESOURCE] = fx(100000);
    const goldBefore = bulk.players[0]!.resources[GOLD_RESOURCE]!;
    expect(marketBuy(bulk, 0, FOOD, 1000)).toBe(true);
    const bulkCost = goldBefore - bulk.players[0]!.resources[GOLD_RESOURCE]!;

    // --- 100 単位 × 10 回（間に 30 秒ずつ相場が戻る）---
    const split = makeWorld();
    split.players[0]!.resources[GOLD_RESOURCE] = fx(100000);
    const goldBefore2 = split.players[0]!.resources[GOLD_RESOURCE]!;
    const interval = marketDecayIntervalTicks();
    for (let k = 0; k < 10; k++) {
      expect(marketBuy(split, 0, FOOD, 100)).toBe(true);
      split.tick += interval;
      applyMarketDecay(split);
    }
    const splitCost = goldBefore2 - split.players[0]!.resources[GOLD_RESOURCE]!;

    expect(bulkCost).toBeGreaterThan(splitCost);
    // 実測値（基準価格 1 金/単位）: 一括 1140.6 金 / 分割 1087.9 金
    expect(fxToNumber(bulkCost)).toBeCloseTo(1140.63, 1);
    expect(fxToNumber(splitCost)).toBeCloseTo(1087.89, 1);
    // どちらも同じ 1000 単位が手に入っている
    expect(bulk.players[0]!.resources[FOOD]).toBe(fx(1000));
    expect(split.players[0]!.resources[FOOD]).toBe(fx(1000));
  });

  it('金が足りなければ買えない（資源も相場も動かない）', () => {
    const w = makeWorld();
    w.players[0]!.resources[GOLD_RESOURCE] = fx(10);
    expect(marketBuy(w, 0, FOOD, 1000)).toBe(false);
    expect(w.players[0]!.resources[FOOD]).toBe(0);
    expect(marketPriceMulFx(w, FOOD)).toBe(FX_ONE);
  });

  it('売却は金に変わる（相場は動かさない）', () => {
    const w = makeWorld();
    w.players[0]!.resources[WOOD] = fx(100);
    expect(marketSell(w, 0, WOOD, 100)).toBe(true);
    expect(w.players[0]!.resources[WOOD]).toBe(0);
    expect(fxToNumber(w.players[0]!.resources[GOLD_RESOURCE]!)).toBeCloseTo(100, 5);
    expect(marketPriceMulFx(w, WOOD)).toBe(FX_ONE);
    // 在庫が足りなければ失敗
    expect(marketSell(w, 0, WOOD, 100)).toBe(false);
  });
});

describe('交易荷車（T-M4-06）', () => {
  it('金 = 片道距離 × 0.5。片道 100 マスで 50（§14.2 の検算値）', () => {
    expect(tradeGoldPerRoundTripFx(fxFromInt(100))).toBe(fx(50));
    expect(fxToNumber(tradeGoldPerRoundTripFx(fxFromInt(100)))).toBe(50);
  });

  it('遠い相手と繋ぐほど 1 往復の収入が増える（単調増加）', () => {
    let prev = -1;
    for (const tiles of [10, 20, 50, 100, 150, 200, 300]) {
      const g = tradeGoldPerRoundTripFx(fxFromInt(tiles));
      expect(g).toBeGreaterThan(prev);
      expect(fxToNumber(g)).toBe(tiles / 2);
      prev = g;
    }
  });

  it('距離 0 以下では収入なし', () => {
    expect(tradeGoldPerRoundTripFx(0)).toBe(0);
    expect(tradeGoldPerRoundTripFx(-fx(5))).toBe(0);
  });
});

describe('貢納（T-M4-07）', () => {
  it('100 送ると相手に 90 入る（手数料 10%）', () => {
    const w = makeWorld([0, 0, 1]);
    w.players[0]!.resources[FOOD] = fx(500);
    expect(tribute(w, 0, 1, FOOD, fx(100))).toBe(true);
    expect(w.players[0]!.resources[FOOD]).toBe(fx(400)); // 送り主は 100 減る
    expect(w.players[1]!.resources[FOOD]).toBe(fx(90)); // 相手には 90
    expect(fxToNumber(tributeFeeRatioFx())).toBeCloseTo(0.1, 2);
    const split = tributeSplit(fx(100));
    expect(split.feeFx).toBe(fx(10));
    expect(split.receivedFx).toBe(fx(90));
  });

  it('敵には送れない。自分自身にも送れない', () => {
    const w = makeWorld([0, 0, 1]);
    w.players[0]!.resources[FOOD] = fx(500);
    expect(tribute(w, 0, 2, FOOD, fx(100))).toBe(false); // 別チーム
    expect(tribute(w, 0, 0, FOOD, fx(100))).toBe(false); // 自分
    expect(w.players[0]!.resources[FOOD]).toBe(fx(500));
    expect(w.players[2]!.resources[FOOD]).toBe(0);
  });

  it('資源が足りなければ送れない', () => {
    const w = makeWorld([0, 0, 1]);
    w.players[0]!.resources[FOOD] = fx(50);
    expect(tribute(w, 0, 1, FOOD, fx(100))).toBe(false);
    expect(w.players[1]!.resources[FOOD]).toBe(0);
  });
});
