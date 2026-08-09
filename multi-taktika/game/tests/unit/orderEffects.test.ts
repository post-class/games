/**
 * 固有令のフラグとエリートの特性の適用（`01` の固有令の表 / `03§7` / `03§8` / `07§6`）
 *
 * `docs/ISSUES.md` の「[保留] 固有令のフラグが未適用（7 件）」に対応するテスト。
 * 段・重み・隊列は `order.behaviors.test.ts` が守っているので、ここでは
 * **「効果そのものが数値として出るか」** だけを見る。
 *
 * 期待値はすべて Fx（実数 × 256）の整数で書く。
 * 倍率は `fx()` で量子化されるので実数から丸め直すと一致しない（`damage.ts` の冒頭を参照）。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind, resourceIndex } from '@/shared/types';
import { createWorld, getFront, getPlayer, type World } from '@/sim/core/world';
import { UnitState, entityIndex, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fx, fxFromInt } from '@/sim/core/fx';
import { ORDER_DEFS, buildingDefById, orderIndex, unitDefById } from '@/sim/core/defs';
import { rebuildGrid } from '@/sim/core/grid';
import { Tile, allocateTerrain, setElevation, setTile } from '@/sim/core/terrain';
import { combat } from '@/sim/systems/combat';
import { morale } from '@/sim/systems/morale';
import { economy } from '@/sim/systems/economy';
import {
  NO_ORDERS,
  buildingDamageMulOf,
  damageTakenMulOf,
  hasMoraleBreakImmune,
  hasPushThrough,
  hasWaterAssault,
  holdIncomePerSec,
  killIncomeRatioOf,
  orderPairFor,
} from '@/sim/core/orderEffects';

const MAP = 64;
const FOOD = resourceIndex('food');
const GOLD = resourceIndex('gold');

function makeWorld(): World {
  const w = createWorld({
    seed: 9,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 256,
  });
  allocateTerrain(w.map);
  return w;
}

function putUnit(w: World, id: string, owner: number, tx: number, ty: number, frontId = 0): number {
  const d = unitDefById(id);
  const i = entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: d.index,
      x: fxFromInt(tx),
      y: fxFromInt(ty),
      hpMax: d.hp,
    })
  );
  w.entities.frontId[i] = frontId;
  return i;
}

function putBuilding(w: World, id: string, owner: number, tx: number, ty: number): number {
  const d = buildingDefById(id);
  return entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Building,
      owner,
      typeId: d.index,
      x: fxFromInt(tx),
      y: fxFromInt(ty),
      hpMax: d.hp,
    })
  );
}

/** 戦域を 1 つ立てて令を渡す。 */
function openFront(
  w: World,
  slot: number,
  owner: number,
  upper: string | null,
  lower: string | null = null
): void {
  const f = getFront(w, owner, slot)!;
  f.active = true;
  f.radius = fxFromInt(15);
  f.order = upper as never;
  f.orderLower = lower as never;
}

function tickCombat(w: World, times = 1): void {
  for (let k = 0; k < times; k++) {
    rebuildGrid(w.grid, w.entities, w.tick);
    combat(w);
    w.tick += 1;
  }
}

function tickMorale(w: World, times = 1): void {
  for (let k = 0; k < times; k++) {
    rebuildGrid(w.grid, w.entities, w.tick);
    morale(w);
    w.tick += 1;
  }
}

/** 1 撃で入ったダメージ（攻撃側と受け側を 1 組だけ置いて 1 tick 回す）。 */
function oneHit(w: World, victim: number): number {
  const hp0 = w.entities.hp[victim]!;
  tickCombat(w);
  return hp0 - w.entities.hp[victim]!;
}

// ============================================================ フラグの引き方

describe('orderEffects: フラグは値の型で解釈される（令の名前で分岐しない）', () => {
  it('陣立て（数値）→ 被ダメージ倍率、火計（数値）→ 対建物倍率', () => {
    const w = makeWorld();
    openFront(w, 1, 0, 'jindate');
    const jindate = orderPairFor(w, 0, 1, 0);
    expect(damageTakenMulOf(jindate)).toBe(fx(0.85));
    expect(buildingDamageMulOf(jindate)).toBe(FX_ONE);

    openFront(w, 2, 0, null, 'kakei');
    const kakei = orderPairFor(w, 0, 2, 0);
    expect(buildingDamageMulOf(kakei)).toBe(fx(1.35));
    expect(damageTakenMulOf(kakei)).toBe(FX_ONE);
  });

  it('真偽値のフラグ（方陣・上陸・圧壊）', () => {
    const w = makeWorld();
    openFront(w, 1, 0, 'hojin');
    openFront(w, 2, 0, 'jouriku');
    openFront(w, 3, 0, 'assai');
    expect(hasMoraleBreakImmune(orderPairFor(w, 0, 1, 0))).toBe(true);
    expect(hasWaterAssault(orderPairFor(w, 0, 2, 0))).toBe(true);
    expect(hasPushThrough(orderPairFor(w, 0, 3, 0))).toBe(true);
    // 別の令には付かない
    expect(hasPushThrough(orderPairFor(w, 0, 1, 0))).toBe(false);
    expect(hasMoraleBreakImmune(NO_ORDERS)).toBe(false);
  });

  it('オブジェクトのフラグ（交易）→ 資源ごとの毎秒量', () => {
    const w = makeWorld();
    openFront(w, 1, 0, null, 'koeki');
    const buf = new Int32Array(4);
    expect(holdIncomePerSec(orderPairFor(w, 0, 1, 0), buf)).toBe(true);
    expect(buf[GOLD]).toBe(fx(1.5));
    expect(buf[FOOD]).toBe(0);
    // 収入を持たない令では false（バッファは触らない）
    openFront(w, 2, 0, 'charge');
    expect(holdIncomePerSec(orderPairFor(w, 0, 2, 0), buf)).toBe(false);
  });

  it('比率のフラグ（奉納）', () => {
    const w = makeWorld();
    openFront(w, 1, 0, null, 'hounou');
    expect(killIncomeRatioOf(orderPairFor(w, 0, 1, 0))).toBe(fx(0.5));
    expect(killIncomeRatioOf(NO_ORDERS)).toBe(0);
  });

  it('二重旗では上段と下段の両方のフラグが効く（07§4）', () => {
    const w = makeWorld();
    openFront(w, 1, 0, 'jindate', 'kakei');
    const pair = orderPairFor(w, 0, 1, 0);
    expect(damageTakenMulOf(pair)).toBe(fx(0.85)); // 上段
    expect(buildingDamageMulOf(pair)).toBe(fx(1.35)); // 下段
  });

  it('離反中（defected）の戦域では令が一切効かない（07§10）', () => {
    const w = makeWorld();
    openFront(w, 1, 0, 'jindate');
    getFront(w, 0, 1)!.defected = true;
    expect(orderPairFor(w, 0, 1, 0)).toBe(NO_ORDERS);
    expect(damageTakenMulOf(orderPairFor(w, 0, 1, 0))).toBe(FX_ONE);
  });

  it('戦域が閉じた後は lastOrder のフラグが残る（07§3）', () => {
    const w = makeWorld();
    // 戦域なし（frontId = 0）＋ lastOrder = 陣立て
    const pair = orderPairFor(w, 0, 0, orderIndex('jindate') + 1);
    expect(damageTakenMulOf(pair)).toBe(fx(0.85));
  });
  it('orders.json の flags は全部どこかで読まれている（読まれないキーを増やさない）', () => {
    // 「変えても効かないキー」を作らないための番人（`docs/ISSUES.md` の判断と同じ趣旨）。
    // フラグを足したら、このどちらかの配列にも足すこと。
    const consumedByOrderEffects = [
      'damageTakenMul',
      'buildingDamageMul',
      'killIncomeRatio',
      'moraleBreakImmune',
      'waterAssault',
      'pushThrough',
      'holdIncome',
    ];
    const consumedByUnitDecision = ['siegeLead', 'followSiege', 'avoidCombatUnits', 'crossFront'];
    // **まだ誰も読んでいないフラグ**（申し送り）。増やさないためにここに明記しておく。
    //  formationKeep      : 損耗しても隊列を保つ（movement / unitDecision の配置の担当）
    //  requiresWaterFront : 水辺の戦域にしか出せない（令を出す側の検査 = command / UI の担当）
    const notYetConsumed = ['formationKeep', 'requiresWaterFront'];
    const known = new Set([
      ...consumedByOrderEffects,
      ...consumedByUnitDecision,
      ...notYetConsumed,
    ]);
    const orphans: string[] = [];
    for (const d of ORDER_DEFS) {
      for (const key of Object.keys(d.flags)) {
        if (!known.has(key)) orphans.push(`${d.id}.${key}`);
      }
    }
    expect(orphans).toEqual([]);
  });

});

// ============================================================ 1. 陣立て（ヤマト）

describe('陣立て: 防御隊形で被害を軽減（damageTakenMul）', () => {
  it('令を受けている側の被ダメージが ×0.85 になる', () => {
    // 素の値: 長柄組 → 騎兵 = 3456（combat.test.ts / damage.test.ts と同じ組み合わせ）
    const bare = makeWorld();
    putUnit(bare, 'y-nagae', 0, 10, 10);
    const b0 = putUnit(bare, 'r-eq', 1, 11, 10);
    const plain = oneHit(bare, b0);
    expect(plain).toBe(3456);

    // 受け側が陣立ての戦域に属している場合
    const w = makeWorld();
    openFront(w, 1, 1, 'jindate');
    putUnit(w, 'y-nagae', 0, 10, 10);
    const b = putUnit(w, 'r-eq', 1, 11, 10, 1);
    const guarded = oneHit(w, b);
    // 0.85 は fx で 218/256 に量子化される（0.85 × 256 = 217.6 → 218）。
    // 3456 × 218 / 256 = 2943（fxMul は 0 方向切り捨て）
    expect(guarded).toBe(2943);
    expect(guarded).toBeLessThan(plain);
  });

  it('攻撃側が陣立てでも自分の与ダメージは変わらない（受け側の補正である）', () => {
    const w = makeWorld();
    openFront(w, 1, 0, 'jindate');
    putUnit(w, 'y-nagae', 0, 10, 10, 1);
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    expect(oneHit(w, b)).toBe(3456);
  });
});

// ============================================================ 2. 方陣（ローマ）

describe('方陣: 損耗しても隊列が崩れない（moraleBreakImmune）', () => {
  it('士気 0 でも退却しない', () => {
    const w = makeWorld();
    openFront(w, 1, 0, 'hojin');
    const i = putUnit(w, 'r-hastati', 0, 30, 30, 1);
    w.entities.morale[i] = 0;
    tickMorale(w, 12);
    expect(w.entities.state[i]).not.toBe(UnitState.Routed);
  });

  it('令が無ければ同じ条件で退却する（比較）', () => {
    const w = makeWorld();
    // 士気は**危険なときだけ**効く（`07§6` は戦闘の仕組み）。
    // 戦域に入れて「危険」にしてから比較する。方陣ありの側も同じ条件にしている。
    openFront(w, 1, 0, null);
    const i = putUnit(w, 'r-hastati', 0, 30, 30, 1);
    w.entities.morale[i] = 0;
    tickMorale(w, 12);
    expect(w.entities.state[i]).toBe(UnitState.Routed);
  });

  it('体力 0 では死ぬ（方陣は全滅を防がない）', () => {
    const w = makeWorld();
    openFront(w, 1, 1, 'hojin');
    putUnit(w, 'y-nagae', 0, 10, 10);
    const b = putUnit(w, 'r-eq', 1, 11, 10, 1);
    w.entities.hp[b] = fx(1);
    w.entities.morale[b] = 0;
    tickCombat(w);
    expect(w.entities.alive[b]).toBe(0);
  });
});

// ============================================================ 3. 火計（唐）

describe('火計: 建物へのダメージが増える（buildingDamageMul）', () => {
  it('建物への与ダメージが ×1.35 になる', () => {
    const bare = makeWorld();
    putUnit(bare, 'y-nagae', 0, 10, 10);
    const h0 = putBuilding(bare, 'house', 1, 11, 10);
    const plain = oneHit(bare, h0);

    const w = makeWorld();
    openFront(w, 1, 0, null, 'kakei');
    putUnit(w, 'y-nagae', 0, 10, 10, 1);
    const h = putBuilding(w, 'house', 1, 11, 10);
    const burned = oneHit(w, h);
    expect(burned).toBe(Math.trunc((plain * fx(1.35)) / FX_ONE));
    expect(burned).toBeGreaterThan(plain);
  });

  it('ユニットには効かない（対建物だけの倍率）', () => {
    const w = makeWorld();
    openFront(w, 1, 0, null, 'kakei');
    putUnit(w, 'y-nagae', 0, 10, 10, 1);
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    expect(oneHit(w, b)).toBe(3456);
  });
});

// ============================================================ 4. 上陸（ヴァイキング）

describe('上陸: 水辺の戦域に強襲をかける（waterAssault）', () => {
  it('浅瀬に立って攻めると与ダメージが ×1.2 になる', () => {
    const w = makeWorld();
    openFront(w, 1, 0, 'jouriku');
    setTile(w.map, 10, 10, Tile.Shallow);
    putUnit(w, 'y-nagae', 0, 10, 10, 1);
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    // 3456 × fx(1.2)/256 = 4147
    expect(oneHit(w, b)).toBe(Math.trunc((3456 * fx(1.2)) / FX_ONE));
  });

  it('陸に立っている間は何も変わらない（水際の令である）', () => {
    const w = makeWorld();
    openFront(w, 1, 0, 'jouriku');
    putUnit(w, 'y-nagae', 0, 10, 10, 1);
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    expect(oneHit(w, b)).toBe(3456);
  });

  it('岸へ攻め上がる不利（低所 → 高所 = 0.9）を打ち消す', () => {
    // 比較: 令なしで低所 → 高所
    const bare = makeWorld();
    setTile(bare.map, 10, 10, Tile.Shallow);
    setElevation(bare.map, 11, 10, 1);
    putUnit(bare, 'y-nagae', 0, 10, 10);
    const b0 = putUnit(bare, 'r-eq', 1, 11, 10);
    const uphill = oneHit(bare, b0);
    expect(uphill).toBeLessThan(3456);

    const w = makeWorld();
    openFront(w, 1, 0, 'jouriku');
    setTile(w.map, 10, 10, Tile.Shallow);
    setElevation(w.map, 11, 10, 1);
    putUnit(w, 'y-nagae', 0, 10, 10, 1);
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    const assault = oneHit(w, b);
    // 地形の不利が消えた上に強襲が乗るので、平地の素の値より大きい
    expect(assault).toBe(Math.trunc((3456 * fx(1.2)) / FX_ONE));
    expect(assault).toBeGreaterThan(uphill);
  });
});

// ============================================================ 5. 交易（マリ）

describe('交易: 戦域を維持すると金が入る（holdIncome）', () => {
  it('毎秒 金 1.5 が入る（25 tick で 1.5、50 tick で 3.0）', () => {
    const w = makeWorld();
    openFront(w, 1, 0, null, 'koeki');
    const pl = getPlayer(w, 0)!;
    const gold0 = pl.resources[GOLD]!;
    for (let t = 0; t < 25; t++) {
      economy(w);
      w.tick += 1;
    }
    expect(pl.resources[GOLD]! - gold0).toBe(fx(1.5));
    for (let t = 0; t < 25; t++) {
      economy(w);
      w.tick += 1;
    }
    expect(pl.resources[GOLD]! - gold0).toBe(fx(3.0));
  });

  it('戦域が閉じている / 令が違う / 離反中は入らない', () => {
    const w = makeWorld();
    openFront(w, 1, 0, null, 'raid'); // 別の令
    openFront(w, 2, 0, null, 'koeki');
    getFront(w, 0, 2)!.defected = true; // 離反中
    const pl = getPlayer(w, 0)!;
    const gold0 = pl.resources[GOLD]!;
    for (let t = 0; t < 50; t++) {
      economy(w);
      w.tick += 1;
    }
    expect(pl.resources[GOLD]!).toBe(gold0);
  });
});

// ============================================================ 6. 奉納（アステカ）

describe('奉納: 撃破数が資源に変わる（killIncomeRatio）', () => {
  it('撃破したユニットのコストの 50% が入る', () => {
    const w = makeWorld();
    openFront(w, 1, 0, null, 'hounou');
    putUnit(w, 'y-nagae', 0, 10, 10, 1);
    const victimDef = unitDefById('r-eq');
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    w.entities.hp[b] = fx(1); // 1 撃で落ちる
    const pl = getPlayer(w, 0)!;
    const food0 = pl.resources[FOOD]!;
    tickCombat(w);
    expect(w.entities.alive[b]).toBe(0);
    const gained = pl.resources[FOOD]! - food0;
    expect(gained).toBe(Math.trunc((victimDef.cost[FOOD]! * fx(0.5)) / FX_ONE));
    expect(gained).toBeGreaterThan(0);
  });

  it('令が無ければ入らない / 建物は既定で対象外', () => {
    const w = makeWorld();
    putUnit(w, 'y-nagae', 0, 10, 10);
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    w.entities.hp[b] = fx(1);
    const pl = getPlayer(w, 0)!;
    const food0 = pl.resources[FOOD]!;
    tickCombat(w);
    expect(pl.resources[FOOD]!).toBe(food0);

    const w2 = makeWorld();
    openFront(w2, 1, 0, null, 'hounou');
    putUnit(w2, 'y-nagae', 0, 10, 10, 1);
    const h = putBuilding(w2, 'house', 1, 11, 10);
    w2.entities.hp[h] = fx(1);
    const pl2 = getPlayer(w2, 0)!;
    const wood0 = pl2.resources[resourceIndex('wood')]!;
    tickCombat(w2);
    expect(w2.entities.alive[h]).toBe(0);
    expect(pl2.resources[resourceIndex('wood')]!).toBe(wood0);
  });
});

// ============================================================ 7. 圧壊（ペルシア）

describe('圧壊: 正面の敵陣を押し崩す（pushThrough）', () => {
  it('攻撃側の相性の不利（0.7）が等倍に戻る', () => {
    // 騎兵 → 槍: 相性不利。素の値は 895（combat.test.ts と同じ組み合わせ）
    const bare = makeWorld();
    putUnit(bare, 'r-eq', 0, 10, 10);
    const b0 = putUnit(bare, 'y-nagae', 1, 11, 10);
    expect(oneHit(bare, b0)).toBe(895);

    const w = makeWorld();
    openFront(w, 1, 0, 'assai');
    putUnit(w, 'r-eq', 0, 10, 10, 1);
    const b = putUnit(w, 'y-nagae', 1, 11, 10);
    const pushed = oneHit(w, b);
    // 0.7 が 1.0 になるので 895 / 0.699… ≒ 1280
    expect(pushed).toBe(1280);
    expect(pushed).toBeGreaterThan(895);
  });

  it('受け側が圧壊だと、槍の相性の有利（1.5）が等倍に落ちる（槍に止められない）', () => {
    const w = makeWorld();
    openFront(w, 1, 1, 'assai');
    putUnit(w, 'y-nagae', 0, 10, 10);
    const b = putUnit(w, 'r-eq', 1, 11, 10, 1);
    const blunted = oneHit(w, b);
    // 3456 は 1.5 倍込みの値。等倍になるので 2304
    expect(blunted).toBe(2304);
    expect(blunted).toBeLessThan(3456);
  });

  it('有利は伸びない（等倍に寄せるだけ）', () => {
    const w = makeWorld();
    openFront(w, 1, 0, 'assai');
    putUnit(w, 'y-nagae', 0, 10, 10, 1);
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    expect(oneHit(w, b)).toBe(3456);
  });
});

// ============================================================ エリートの特性（03§8）

describe('特性: エリート 8 種（03§8「輪をどう破るか」）', () => {
  it('anti_elite（武士）: 相手がエリートのときだけ攻撃が上がる', () => {
    const vsElite = makeWorld();
    putUnit(vsElite, 'y-bushi', 0, 10, 10);
    const b = putUnit(vsElite, 'r-legion', 1, 11, 10);
    const boosted = oneHit(vsElite, b);

    const vsLine = makeWorld();
    putUnit(vsLine, 'y-bushi', 0, 10, 10);
    const b2 = putUnit(vsLine, 'r-hastati', 1, 11, 10);
    const normal = oneHit(vsLine, b2);
    // 相手の装甲が違うので絶対値は比べられない。倍率が乗っているかを別に確かめる。
    expect(boosted).toBeGreaterThan(0);
    expect(normal).toBeGreaterThan(0);

    // 同じ相手（レギオン）を、特性を持たない同 role の兵で叩いた場合と比べる。
    const control = makeWorld();
    putUnit(control, 'r-legion', 0, 10, 10);
    const b3 = putUnit(control, 'r-legion', 1, 11, 10);
    const plain = oneHit(control, b3);
    // 武士 atk 13 / レギオン atk 12。1.75 倍が乗るので 1.75 倍以上の開きが出る。
    expect(boosted).toBeGreaterThan(plain * 1.5);
  });

  it('anti_infantry（ジャガー戦士）: 近接歩兵 role に対して攻撃が上がる', () => {
    const w = makeWorld();
    putUnit(w, 'a-jaguar', 0, 10, 10);
    const b = putUnit(w, 'y-nagae', 1, 11, 10); // spear
    const boosted = oneHit(w, b);

    const w2 = makeWorld();
    putUnit(w2, 'a-jaguar', 0, 10, 10);
    const b2 = putUnit(w2, 'r-eq', 1, 11, 10); // cavalry（対象外の role）
    const plain = oneHit(w2, b2);
    // 装甲の差はあるが、対 spear には 1.6 倍 + 相性 1.5 倍が乗るので明確に大きい
    expect(boosted).toBeGreaterThan(plain);
  });

  it('formation_defense（レギオン）: 同種が隣に並ぶと硬くなる', () => {
    // 近接で叩く（遠隔だと投射物が飛ぶので同じ tick に damage が出ない）。
    const alone = makeWorld();
    putUnit(alone, 'y-nagae', 0, 11, 10);
    const b0 = putUnit(alone, 'r-legion', 1, 12, 10);
    const soloDmg = oneHit(alone, b0);
    expect(soloDmg).toBeGreaterThan(0);

    const packed = makeWorld();
    putUnit(packed, 'y-nagae', 0, 11, 10);
    const b1 = putUnit(packed, 'r-legion', 1, 12, 10);
    // 半径 2 マス内に同種の味方を 4 体並べる（上限 = traits.formationDefenseMaxAllies）
    putUnit(packed, 'r-legion', 1, 13, 10);
    putUnit(packed, 'r-legion', 1, 12, 11);
    putUnit(packed, 'r-legion', 1, 13, 11);
    putUnit(packed, 'r-legion', 1, 12, 9);
    const packedDmg = oneHit(packed, b1);
    expect(packedDmg).toBeLessThan(soloDmg);
  });

  it('multi_shot（連弩兵）: 敵が複数いると同時に複数の矢が飛ぶ', () => {
    const w = makeWorld();
    putUnit(w, 't-renkyu', 0, 10, 10);
    putUnit(w, 'r-hastati', 1, 12, 10);
    putUnit(w, 'r-hastati', 1, 13, 10);
    putUnit(w, 'r-hastati', 1, 14, 10);
    tickCombat(w);
    let projectiles = 0;
    const e = w.entities;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] === 1 && e.kind[i] === EntityKind.Projectile) projectiles += 1;
    }
    expect(projectiles).toBe(3);
  });

  it('multi_shot: 敵が 1 体なら矢は 1 本（同じ敵に重ねない）', () => {
    const w = makeWorld();
    putUnit(w, 't-renkyu', 0, 10, 10);
    putUnit(w, 'r-hastati', 1, 12, 10);
    tickCombat(w);
    let projectiles = 0;
    const e = w.entities;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] === 1 && e.kind[i] === EntityKind.Projectile) projectiles += 1;
    }
    expect(projectiles).toBe(1);
  });

  it('self_heal（ベルセルク）: 時間とともに回復し、最大値を超えない', () => {
    const w = makeWorld();
    const i = putUnit(w, 'v-berserk', 0, 30, 30);
    const e = w.entities;
    e.hp[i] = e.hpMax[i]! - fx(10);
    tickCombat(w, 25); // 1 秒
    expect(e.hp[i]! - (e.hpMax[i]! - fx(10))).toBe(fx(1.5));
    tickCombat(w, 25 * 20); // 十分な時間
    expect(e.hp[i]).toBe(e.hpMax[i]);
  });

  it('self_heal を持たない兵は回復しない', () => {
    const w = makeWorld();
    const i = putUnit(w, 'r-hastati', 0, 30, 30);
    const e = w.entities;
    e.hp[i] = e.hpMax[i]! - fx(10);
    const hp = e.hp[i]!;
    tickCombat(w, 25);
    expect(e.hp[i]).toBe(hp);
  });

  it('knockback（戦象）: 当たった敵が押し出される', () => {
    const w = makeWorld();
    putUnit(w, 'p-elephant', 0, 20, 20);
    const b = putUnit(w, 'r-hastati', 1, 21, 20);
    const x0 = w.entities.x[b]!;
    tickCombat(w);
    expect(w.entities.x[b]!).toBeGreaterThan(x0);
  });

  it('knockback を持たない兵では動かない', () => {
    const w = makeWorld();
    putUnit(w, 'y-nagae', 0, 20, 20);
    const b = putUnit(w, 'r-hastati', 1, 21, 20);
    const x0 = w.entities.x[b]!;
    tickCombat(w);
    expect(w.entities.x[b]).toBe(x0);
  });

  it('move_and_shoot（親衛弓騎兵）: 移動しながら撃っても次弾が遅れない', () => {
    // 比較対象: 同じ「移動しながら撃つ」状況の普通の弓兵
    const slow = makeWorld();
    const a0 = putUnit(slow, 'y-daikyu', 0, 10, 10);
    putUnit(slow, 'r-hastati', 1, 12, 10);
    slow.entities.vx[a0] = fx(0.05); // movement が動かしたことにする
    tickCombat(slow);
    const slowCd = slow.entities.cooldown[a0]!;
    expect(slowCd).toBeGreaterThan(unitDefById('y-daikyu').attackTicks);

    const fast = makeWorld();
    const a1 = putUnit(fast, 'g-guard-horsearcher', 0, 10, 10);
    putUnit(fast, 'r-hastati', 1, 12, 10);
    fast.entities.vx[a1] = fx(0.05);
    tickCombat(fast);
    expect(fast.entities.cooldown[a1]).toBe(unitDefById('g-guard-horsearcher').attackTicks);
  });
});
