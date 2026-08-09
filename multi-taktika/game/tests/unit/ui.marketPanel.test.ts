/**
 * T-M12-07: 市場（資源交換・交易）パネル（`05§11`）
 *
 * DOM を触らない純関数だけを検証する:
 *  - 売買は 100 単位ずつ（`economy.marketPriceUnitStep` から引く）
 *  - 相場は**全プレイヤー共通**で、**一気に買うほど損**（まとめ買いの平均単価が上がる）
 *  - 相場の推移（値動き）から「買われている資源」が読める
 *  - 交易は**距離が遠いほど儲かる**。交易路が戦域に重なると狙われる
 *  - 送る Command は `marketTrade`（金を介した交換）だけ
 */

import { describe, expect, it } from 'vitest';
import type { CivId } from '@/shared/types';
import { RESOURCE_IDS, resourceIndex } from '@/shared/types';
import { techIndex } from '@/sim/core/defs';
import { markModifiersDirty } from '@/sim/core/effects';
import { FX_ONE, fx, fxFromInt } from '@/sim/core/fx';
import { GOLD_RESOURCE, marketBuy, marketPriceUnitStep } from '@/sim/core/market';
import { acquireFrontSlot, createWorld, getFront, type World } from '@/sim/core/world';
import { spawnBuilding } from '@/sim/systems/construction';
import {
  BULK_MULTIPLIER,
  buildMarketPanelModel,
  createPriceHistory,
  findOwnMarketIndex,
  marketBuildingId,
  pointSegmentDistanceTiles,
  routeCrossesFront,
  samplePrices,
  sparklinePoints,
  tradeRoutes,
  tradeStep,
  trendOf,
  trendTextOf,
} from '@/ui/hud/marketPanel';

function makeWorld(civs: CivId[], resources = 5000): World {
  const w = createWorld({
    seed: 5,
    playerCount: civs.length,
    mapWidthTiles: 128,
    mapHeightTiles: 128,
    civs,
  });
  for (const pl of w.players) {
    pl.age = 2;
    pl.popCap = 200;
    for (let r = 0; r < RESOURCE_IDS.length; r++) pl.resources[r] = fx(resources);
  }
  return w;
}

describe('T-M12-07 売買の単位と相場', () => {
  it('売買の単位は data から引く（100 単位ずつ）', () => {
    expect(tradeStep()).toBe(marketPriceUnitStep());
  });

  it('市場が無ければ売買できない', () => {
    const w = makeWorld(['yamato']);
    const model = buildMarketPanelModel(w, 0, createPriceHistory());
    expect(model.ownMarket).toBeNull();
    expect(model.rows.every((r) => !r.canBuy && !r.canSell)).toBe(true);
    expect(model.cartCommand).toBeNull();
  });

  it('行は食料・木材・石材の 3 つ（金は交換の基準なので行にしない）', () => {
    const w = makeWorld(['yamato']);
    spawnBuilding(w, 0, marketBuildingId(), fxFromInt(20), fxFromInt(20));
    markModifiersDirty(w, 0);
    const model = buildMarketPanelModel(w, 0, createPriceHistory());
    expect(model.rows.length).toBe(RESOURCE_IDS.length - 1);
    expect(model.rows.some((r) => r.resource === GOLD_RESOURCE)).toBe(false);
    expect(model.gold).toBeGreaterThan(0);
    expect(model.ownMarket).not.toBeNull();
    expect(findOwnMarketIndex(w, 0)).toBeGreaterThanOrEqual(0);
  });

  it('送る Command は金を介した marketTrade だけ', () => {
    const w = makeWorld(['yamato']);
    spawnBuilding(w, 0, marketBuildingId(), fxFromInt(20), fxFromInt(20));
    const row = buildMarketPanelModel(w, 0, createPriceHistory()).rows[0]!;
    expect(row.buyCommand).toMatchObject({ t: 'marketTrade', p: 0, sell: 'gold', buy: row.id });
    expect(row.sellCommand).toMatchObject({ t: 'marketTrade', p: 0, sell: row.id, buy: 'gold' });
    expect(row.buyCommand).toMatchObject({ amount: tradeStep() });
  });

  it('一気に買うほど損（まとめ買いの平均単価が上がる）', () => {
    const w = makeWorld(['yamato']);
    spawnBuilding(w, 0, marketBuildingId(), fxFromInt(20), fxFromInt(20));
    const row = buildMarketPanelModel(w, 0, createPriceHistory()).rows[0]!;
    expect(row.buyCostBulk).toBeGreaterThan(row.buyCost * BULK_MULTIPLIER);
    expect(row.bulkPenaltyPct).toBeGreaterThan(0);
  });

  it('相場は全プレイヤー共通（他人が買うと自分の表示価格も上がる）', () => {
    const w = makeWorld(['yamato', 'roma']);
    spawnBuilding(w, 0, marketBuildingId(), fxFromInt(20), fxFromInt(20));
    const wood = resourceIndex('wood');
    const before = buildMarketPanelModel(w, 0, createPriceHistory()).rows.find(
      (r) => r.resource === wood
    )!;
    // プレイヤー 1（他人）が木材を買う
    expect(marketBuy(w, 1, wood, tradeStep() * 4)).toBe(true);
    const after = buildMarketPanelModel(w, 0, createPriceHistory()).rows.find(
      (r) => r.resource === wood
    )!;
    expect(after.priceMul).toBeGreaterThan(before.priceMul);
    expect(after.unitPriceGold).toBeGreaterThan(before.unitPriceGold);
  });

  it('金が足りなければ買えず、在庫が足りなければ売れない', () => {
    const w = makeWorld(['yamato'], 0);
    spawnBuilding(w, 0, marketBuildingId(), fxFromInt(20), fxFromInt(20));
    const model = buildMarketPanelModel(w, 0, createPriceHistory());
    expect(model.rows.every((r) => !r.canBuy && !r.canSell)).toBe(true);

    const pl = w.players[0]!;
    pl.resources[GOLD_RESOURCE] = fx(100000);
    pl.resources[resourceIndex('wood')] = tradeStep() * FX_ONE;
    const m2 = buildMarketPanelModel(w, 0, createPriceHistory());
    const wood = m2.rows.find((r) => r.resource === resourceIndex('wood'))!;
    expect(wood.canBuy).toBe(true);
    expect(wood.canSell).toBe(true);
  });
});

describe('T-M12-07 相場の推移', () => {
  it('標本は間隔をあけて積まれ、上限で古いものが落ちる', () => {
    const w = makeWorld(['yamato']);
    const h = createPriceHistory();
    expect(samplePrices(h, w, 1000)).toBe(true);
    // 同じ ms のうちは増えない（間隔を守る）
    expect(samplePrices(h, w, 1000)).toBe(false);
    expect(samplePrices(h, w, 2000)).toBe(true);
    expect(h.samples[0]!.length).toBe(2);
  });

  it('買われた資源は値動きが上向きになり、文言で読める', () => {
    const w = makeWorld(['yamato']);
    const h = createPriceHistory();
    const stone = resourceIndex('stone');
    samplePrices(h, w, 1000);
    marketBuy(w, 0, stone, tradeStep() * 5); // 相手が石材を買い漁った
    samplePrices(h, w, 2000);
    expect(trendOf(h.samples[stone]!)).toBeGreaterThan(0);
    expect(trendTextOf('石', trendOf(h.samples[stone]!))).toContain('買われている');
    // 買われていない資源は動かない
    expect(trendOf(h.samples[resourceIndex('food')]!)).toBe(0);
  });

  it('折れ線の頂点列は幅・高さに収まる', () => {
    expect(sparklinePoints([], 100, 20)).toBe('');
    const pts = sparklinePoints([1, 1.1, 1.2], 100, 20).split(' ');
    expect(pts.length).toBe(3);
    expect(pts[0]).toBe('0,20'); // 基準（1.0）は下端
    expect(pts[2]).toBe('100,0'); // 最大値は上端
  });
});

describe('T-M12-07 交易', () => {
  it('距離が遠いほど 1 往復の金が増える', () => {
    const w = makeWorld(['yamato', 'roma', 'tou']);
    spawnBuilding(w, 0, marketBuildingId(), fxFromInt(10), fxFromInt(10));
    spawnBuilding(w, 1, marketBuildingId(), fxFromInt(40), fxFromInt(10)); // 30 マス
    spawnBuilding(w, 2, marketBuildingId(), fxFromInt(110), fxFromInt(10)); // 100 マス
    const routes = tradeRoutes(w, 0);
    expect(routes.length).toBe(2);
    // 儲かる順に並ぶ = 遠い順
    expect(routes[0]!.distanceTiles).toBeGreaterThan(routes[1]!.distanceTiles);
    expect(routes[0]!.goldPerRoundTrip).toBeGreaterThan(routes[1]!.goldPerRoundTrip);
    // 片道 100 マス → 50 金（`07§8` / 手順書 §14.2 の検算値）
    expect(routes[0]!.goldPerRoundTrip).toBe(50);
  });

  it('研究「隊商」で交易収入が増える', () => {
    const w = makeWorld(['yamato', 'roma']);
    spawnBuilding(w, 0, marketBuildingId(), fxFromInt(10), fxFromInt(10));
    spawnBuilding(w, 1, marketBuildingId(), fxFromInt(110), fxFromInt(10));
    const before = tradeRoutes(w, 0)[0]!.goldPerRoundTrip;
    w.players[0]!.researched[techIndex('taisho')] = 1; // 隊商（交易の収入 +30%）
    markModifiersDirty(w, 0);
    expect(tradeRoutes(w, 0)[0]!.goldPerRoundTrip).toBeGreaterThan(before);
  });

  it('自分の市場が無ければ交易先は出ない', () => {
    const w = makeWorld(['yamato', 'roma']);
    spawnBuilding(w, 1, marketBuildingId(), fxFromInt(40), fxFromInt(40));
    expect(tradeRoutes(w, 0).length).toBe(0);
  });

  it('見えていない相手の市場は候補にしない', () => {
    const w = makeWorld(['yamato', 'roma']);
    spawnBuilding(w, 0, marketBuildingId(), fxFromInt(10), fxFromInt(10));
    spawnBuilding(w, 1, marketBuildingId(), fxFromInt(60), fxFromInt(10));
    expect(tradeRoutes(w, 0, () => false).length).toBe(0);
    expect(tradeRoutes(w, 0, () => true).length).toBe(1);
  });

  it('交易路が戦域に重なると狙われる（重なりを検出する）', () => {
    const w = makeWorld(['yamato', 'roma']);
    spawnBuilding(w, 0, marketBuildingId(), fxFromInt(10), fxFromInt(10));
    spawnBuilding(w, 1, marketBuildingId(), fxFromInt(110), fxFromInt(10));
    expect(routeCrossesFront(w, 0, 10, 10, 110, 10)).toBe(false);

    const slot = acquireFrontSlot(w, 0);
    const f = getFront(w, 0, slot)!;
    f.active = true;
    f.x = fxFromInt(60);
    f.y = fxFromInt(12);
    f.radius = fxFromInt(8);
    expect(routeCrossesFront(w, 0, 10, 10, 110, 10)).toBe(true);
    expect(tradeRoutes(w, 0)[0]!.crossesFront).toBe(true);
  });

  it('点と線分の距離（交易路の判定に使う）', () => {
    expect(pointSegmentDistanceTiles(5, 5, 0, 0, 10, 0)).toBeCloseTo(5);
    expect(pointSegmentDistanceTiles(-5, 0, 0, 0, 10, 0)).toBeCloseTo(5);
    expect(pointSegmentDistanceTiles(3, 0, 0, 0, 10, 0)).toBeCloseTo(0);
  });

  it('交易荷車は市場で作る（コストは data から）', () => {
    const w = makeWorld(['yamato']);
    spawnBuilding(w, 0, marketBuildingId(), fxFromInt(20), fxFromInt(20));
    const model = buildMarketPanelModel(w, 0, createPriceHistory());
    expect(model.cartCommand).toMatchObject({ t: 'produce', p: 0, unit: 'trade_cart', count: 1 });
    expect(model.cartCostText).toContain('木');
  });
});

describe('T-M12-07 sim を書き換えない', () => {
  it('モデルを何度作っても資源も相場も動かない', () => {
    const w = makeWorld(['yamato', 'roma']);
    spawnBuilding(w, 0, marketBuildingId(), fxFromInt(20), fxFromInt(20));
    spawnBuilding(w, 1, marketBuildingId(), fxFromInt(60), fxFromInt(60));
    const res = Array.from(w.players[0]!.resources);
    const price = Array.from(w.market.priceMul);
    const h = createPriceHistory();
    for (let k = 1; k <= 5; k++) buildMarketPanelModel(w, 0, h);
    samplePrices(h, w, 1000);
    expect(Array.from(w.players[0]!.resources)).toEqual(res);
    expect(Array.from(w.market.priceMul)).toEqual(price);
  });
});
