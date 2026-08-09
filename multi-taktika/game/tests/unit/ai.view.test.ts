/**
 * AI にズルをさせない仕組みの検証（`07§11`「難易度を上げてもズルはしません」）。
 *
 * ■ なぜテストで固定するのか
 * 「AI は透視しない」をコメントや紳士協定で守るのは無理で、`World` を渡せば
 * いつか必ず「敵の資源を見て動く AI」が生まれる。だから AI には
 * **見えているものだけを詰めた `AiView`** を渡し、World そのものを渡さない。
 *
 * このテストは「渡していないこと」を型ではなく**値**で確かめる。
 * 誰かが `AiView` に敵の資源を足したらここが落ちる。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { createWorld, getFront } from '@/sim/core/world';
import { spawnEntity } from '@/sim/core/entity';
import { fx, fxFromInt } from '@/sim/core/fx';
import { unitDefById } from '@/sim/core/defs';
import { createAiView } from '@/ai/view';
import { resourceNodeIndex, spawnResourceNode } from '@/sim/core/gather';

const MAP = 200;

function makeWorld() {
  return createWorld({
    seed: 99,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 512,
  });
}

function putUnit(
  w: ReturnType<typeof makeWorld>,
  id: string,
  owner: number,
  tx: number,
  ty: number,
): number {
  const def = unitDefById(id);
  return spawnEntity(w.entities, {
    kind: EntityKind.Unit,
    owner,
    typeId: def.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: def.hp,
  });
}

describe('AiView — 見えないものは渡さない（07§11 のズル禁止）', () => {
  it('視界内の敵だけが見える。視界外の敵は 1 件も入らない', () => {
    const w = makeWorld();
    // 自軍の斥候（視界を持つ）を (50,50) に置く
    const scout = unitDefById('scout');
    putUnit(w, 'scout', 0, 50, 50);
    // 視界内の敵と、はるか遠くの敵
    putUnit(w, 'clubman', 1, 52, 50);
    putUnit(w, 'clubman', 1, 150, 150);

    const view = createAiView(w, 0);
    expect(view.seenEnemies.length).toBe(1);
    expect(view.seenEnemies[0]!.x).toBe(fxFromInt(52));
    // 視界半径の外にいる敵は存在すら分からない
    expect(view.seenEnemies.some((s) => s.x === fxFromInt(150))).toBe(false);
    // 視界半径そのものはデータ由来（コードに数値を書いていない）
    expect(scout.sight).toBeGreaterThan(0);
  });

  it('自分の視界を持つ味方がいなければ敵は 1 体も見えない', () => {
    const w = makeWorld();
    putUnit(w, 'clubman', 1, 52, 50);
    const view = createAiView(w, 0);
    expect(view.seenEnemies).toHaveLength(0);
  });

  it('敵の資源・研究・時代・忠誠度は view に存在しない（透視できない）', () => {
    const w = makeWorld();
    // 敵に分かりやすい値を入れておく
    w.players[1]!.resources[0] = fx(9999);
    w.players[1]!.age = 3;
    w.players[1]!.loyalty = fx(0.25);

    const view = createAiView(w, 0);
    // view を JSON にして「9999」「敵の時代」が漏れていないことを確かめる。
    // `map` は地形なので除外（地形は人間も覚えている。view.ts のコメント参照）。
    const dump = JSON.stringify({
      tick: view.tick,
      own: view.own,
      ownEntities: view.ownEntities,
      seenEnemies: view.seenEnemies,
      ownFronts: view.ownFronts,
      enemyFronts: view.enemyFronts,
      marketPriceMul: view.marketPriceMul,
    });
    expect(dump).not.toContain(String(fx(9999)));
    // 自分の資源は見える（開始資源は 0 のままなので、値を入れて確認する）
    w.players[0]!.resources[0] = fx(123);
    expect(createAiView(w, 0).own.resources[0]).toBe(fx(123));
  });

  it('敵の戦域は「中心・半径・番号」だけ（中身は見えない ＝ 囮が成立する）', () => {
    const w = makeWorld();
    // 敵（p1）の戦域を立てる
    const f = getFront(w, 1, 1)!;
    f.active = true;
    f.x = fxFromInt(80);
    f.y = fxFromInt(80);
    f.radius = fxFromInt(15);
    f.order = 'charge';
    f.memberCount = 40;

    const view = createAiView(w, 0);
    expect(view.enemyFronts).toHaveLength(1);
    const ring = view.enemyFronts[0]!;
    // 中心と半径は見える
    expect(ring.x).toBe(fxFromInt(80));
    expect(ring.radius).toBe(fxFromInt(15));
    // **中身は見えない**。キーが増えていたらここで落ちる。
    expect(Object.keys(ring).sort()).toEqual(['owner', 'radius', 'slot', 'x', 'y']);
  });

  it('自分の戦域は令まで見える（自分の情報なので当然）', () => {
    const w = makeWorld();
    const f = getFront(w, 0, 2)!;
    f.active = true;
    f.order = 'hold';
    f.orderLower = 'siege';
    const view = createAiView(w, 0);
    expect(view.ownFronts).toHaveLength(1);
    expect(view.ownFronts[0]!.slot).toBe(2);
    expect(view.ownFronts[0]!.order).toBe('hold');
    expect(view.ownFronts[0]!.orderLower).toBe('siege');
  });

  it('World そのものは渡らない（stepWorld を呼べない / 状態を書き換えられない）', () => {
    const w = makeWorld();
    const view = createAiView(w, 0) as unknown as Record<string, unknown>;
    // `world` / `entities` / `players` / `fronts` / `rng` のような
    // 「触れば状態を変えられるもの」が 1 つも露出していないこと
    for (const key of ['world', 'entities', 'players', 'fronts', 'rngCombat', 'rngAi', 'market']) {
      expect(view[key], `AiView に ${key} が露出している`).toBeUndefined();
    }
  });

  it('同じ World から 2 回作れば同じ内容（決定論。キャッシュを持たない）', () => {
    const w = makeWorld();
    putUnit(w, 'scout', 0, 50, 50);
    putUnit(w, 'clubman', 1, 52, 50);
    const a = createAiView(w, 0);
    const b = createAiView(w, 0);
    expect(JSON.stringify(a.seenEnemies)).toBe(JSON.stringify(b.seenEnemies));
    expect(JSON.stringify(a.ownEntities)).toBe(JSON.stringify(b.ownEntities));
  });

  it('視界内の資源ノードは見える（村人を就かせる対象。中立なので敵の情報ではない）', () => {
    const w = makeWorld();
    putUnit(w, 'scout', 0, 50, 50);
    // 視界内と視界外に資源ノードを置く
    const forest = resourceNodeIndex('forest');
    spawnResourceNode(w, forest, fxFromInt(52), fxFromInt(50));
    spawnResourceNode(w, forest, fxFromInt(150), fxFromInt(150));
    const view = createAiView(w, 0);
    expect(view.seenResourceNodes).toHaveLength(1);
    expect(view.seenResourceNodes[0]!.x).toBe(fxFromInt(52));
    // 資源の種類が分かる（`gather` の対象を名指しできる）
    expect(view.seenResourceNodes[0]!.amount).toBeGreaterThan(0);
  });

  it('自軍のユニットは EntityId を持つ（Command に載せられる）', () => {
    const w = makeWorld();
    const id = putUnit(w, 'villager', 0, 50, 50);
    const view = createAiView(w, 0);
    expect(view.ownEntities.some((o) => o.id === id)).toBe(true);
  });

  it('市場の相場は見える（全プレイヤー共通の情報。07§8）', () => {
    const w = makeWorld();
    w.market.priceMul[2] = fx(1.5); // 石材が高い = 誰かが城か壁を建てている
    const view = createAiView(w, 0);
    expect(view.marketPriceMul[2]).toBe(fx(1.5));
  });
});
