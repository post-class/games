/**
 * T-M11-01〜04, 07: 忠誠と離反（`07§10` / `07§14`, 実装手順書 §6.8）
 *
 * 完了条件:
 *  - T-M11-01 自然回復 +1% / 30 秒。開始 100%、0..1 でクランプ
 *  - T-M11-02 掟破り 各 -25%。逃亡村人は 30 秒以内の攻撃のみ成立、放置ならマップ外へ消える
 *  - T-M11-03 町の中心 -5% / 戦域 3 つ以上の見捨て -10%。**後退で畳んだ戦域は対象外**
 *  - T-M11-04 80%（遅延 +2 秒）/ 50%（slot 最大の戦域が離反し令に反応しない）/ 0%（敗北）
 *  - T-M11-07 休戦の季・掟の適用 OFF が機能する
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { applyCommands } from '@/sim/command';
import { TICK_RATE, cfgNum } from '@/sim/core/config';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { PROGRESS_DONE, markModifiersDirty } from '@/sim/core/effects';
import { entityIndex, markDeadIndex, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fx, fxFromInt } from '@/sim/core/fx';
import { rebuildGrid } from '@/sim/core/grid';
import { configureMatchRules, resetMatchRules } from '@/sim/core/law';
import { orderDelayMs, orderDelayInputFor } from '@/sim/core/order';
import { createWorld, getFront, type Front, type World } from '@/sim/core/world';
import { cleanup } from '@/sim/systems/cleanup';
import { loyalty, fleeingVillagerTrackCount, resetLoyaltyState } from '@/sim/systems/loyalty';
import { orderDelivery } from '@/sim/systems/orderDelivery';

const MAP = 120;

function makeWorld(playerCount = 2): World {
  const w = createWorld({
    seed: 11,
    playerCount,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 512,
  });
  for (let p = 0; p < playerCount; p++) {
    w.map.starts[p * 2] = fxFromInt(10);
    w.map.starts[p * 2 + 1] = fxFromInt(10);
    w.players[p]!.frontSlots = 6;
  }
  return w;
}

/** M8 の代わりに戦域を手で立てる。 */
function makeFront(w: World, owner: number, slot: number, tileX = 50, tileY = 50): Front {
  const f = getFront(w, owner, slot)!;
  f.active = true;
  f.x = fxFromInt(tileX);
  f.y = fxFromInt(tileY);
  f.radius = fx(cfgNum('front.spawnRadiusTiles'));
  f.lastEngageTick = w.tick;
  return f;
}

function putUnit(w: World, id: string, owner: number, tileX: number, tileY: number): number {
  const d = unitDefById(id);
  const i = entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: d.index,
      x: fxFromInt(tileX),
      y: fxFromInt(tileY),
      hpMax: d.hp,
    })
  );
  rebuildGrid(w.grid, w.entities, w.tick);
  return i;
}

function putBuilding(w: World, id: string, owner: number, tileX: number, tileY: number): number {
  const d = buildingDefById(id);
  const i = entityIndex(
    spawnEntity(w.entities, {
      kind: id === 'well' || id === 'seed_store' ? EntityKind.Attachment : EntityKind.Building,
      owner,
      typeId: d.index,
      x: fxFromInt(tileX),
      y: fxFromInt(tileY),
      hpMax: d.hp,
    })
  );
  w.entities.buildProgress[i] = PROGRESS_DONE;
  markModifiersDirty(w, owner);
  rebuildGrid(w.grid, w.entities, w.tick);
  return i;
}

afterEach(() => {
  resetMatchRules();
});

// ---------------------------------------------------------------------------
// T-M11-01 自然回復
// ---------------------------------------------------------------------------

describe('T-M11-01: 忠誠度メーターと自然回復', () => {
  it('開始 100%', () => {
    const w = makeWorld();
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
  });

  it('+1% / 30 秒（周期の頭でまとめて足す）', () => {
    const w = makeWorld();
    w.players[0]!.loyalty = fx(0.5);
    const period = 30 * TICK_RATE;

    // 周期に届かないうちは動かない。
    for (w.tick = 1; w.tick < period; w.tick++) loyalty(w);
    expect(w.players[0]!.loyalty).toBe(fx(0.5));

    w.tick = period;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(fx(0.5) + fx(0.01));

    w.tick = period * 2;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(fx(0.5) + fx(0.01) * 2);
  });

  it('100% を超えて回復しない', () => {
    const w = makeWorld();
    w.tick = 30 * TICK_RATE;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
  });
});

// ---------------------------------------------------------------------------
// T-M11-02 掟の違反判定 4 種
// ---------------------------------------------------------------------------

describe('T-M11-02: 掟一 碑の島で戦うと -25%', () => {
  it('島内で交戦した戦域の持ち主が -25%。同じ戦域では二重に課さない', () => {
    const w = makeWorld();
    w.map.lawZones = new Int32Array([fxFromInt(50), fxFromInt(50), fxFromInt(10), 1]);
    const f = makeFront(w, 0, 1, 50, 50);
    w.tick = 100;
    f.lastEngageTick = w.tick;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE + fx(-0.25));

    // 交戦が続いても 1 回だけ。
    w.tick = 101;
    f.lastEngageTick = w.tick;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE + fx(-0.25));
  });

  it('島の外での交戦は掟一にならない', () => {
    const w = makeWorld();
    w.map.lawZones = new Int32Array([fxFromInt(50), fxFromInt(50), fxFromInt(10), 1]);
    const f = makeFront(w, 0, 1, 80, 80);
    w.tick = 100;
    f.lastEngageTick = w.tick;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
  });
});

describe('T-M11-02: 掟二・三 井戸と種籾蔵を壊すと -25%', () => {
  it('井戸を壊した側（近くの敵の攻撃者）が -25%', () => {
    const w = makeWorld();
    const well = putBuilding(w, 'well', 0, 50, 50);
    putUnit(w, 'clubman', 1, 51, 50);
    w.tick = 10;
    markDeadIndex(w.entities, well);
    loyalty(w);
    expect(w.players[1]!.loyalty).toBe(FX_ONE + fx(-0.25));
    // 壊された側は罰を受けない。
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
  });

  it('種籾蔵を壊した側が -25%', () => {
    const w = makeWorld();
    const store = putBuilding(w, 'seed_store', 0, 50, 50);
    putUnit(w, 'clubman', 1, 51, 50);
    w.tick = 10;
    markDeadIndex(w.entities, store);
    loyalty(w);
    expect(w.players[1]!.loyalty).toBe(FX_ONE + fx(-0.25));
  });

  it('近くに敵の攻撃者がいなければ誰も罰されない（自壊・味方の巻き込み）', () => {
    const w = makeWorld();
    const well = putBuilding(w, 'well', 0, 50, 50);
    w.tick = 10;
    markDeadIndex(w.entities, well);
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
    expect(w.players[1]!.loyalty).toBe(FX_ONE);
  });

  it('普通の建物（家）を壊しても忠誠度は動かない', () => {
    const w = makeWorld();
    const house = putBuilding(w, 'house', 0, 50, 50);
    putUnit(w, 'clubman', 1, 51, 50);
    w.tick = 10;
    markDeadIndex(w.entities, house);
    loyalty(w);
    expect(w.players[1]!.loyalty).toBe(FX_ONE);
  });
});

describe('T-M11-02: 掟五 降った城の民（逃亡村人）', () => {
  it('落城で逃亡村人が出て、マップ端へ向かって歩く', () => {
    const w = makeWorld();
    const tc = putBuilding(w, 'town_center', 0, 20, 60);
    w.tick = 50;
    markDeadIndex(w.entities, tc);
    cleanup(w); // 建物破壊フック → 逃亡村人の生成
    expect(fleeingVillagerTrackCount(w)).toBe(3);

    // マップ左端（x = 20 がいちばん近い）へ向かっている。
    const e = w.entities;
    let found = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1) continue;
      if (e.kind[i] !== EntityKind.Unit) continue;
      if (e.manual[i] !== 1) continue;
      found += 1;
      expect(e.destX[i]).toBe(0);
    }
    expect(found).toBe(3);
  });

  it('30 秒以内に攻撃すると掟五が成立して攻撃側が -25%', () => {
    const w = makeWorld();
    const tc = putBuilding(w, 'town_center', 0, 20, 60);
    w.tick = 50;
    markDeadIndex(w.entities, tc);
    cleanup(w);

    // 逃亡村人を 1 体探して、敵の兵を横に置いてから HP を削る。
    const e = w.entities;
    let vi = -1;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] === 1 && e.kind[i] === EntityKind.Unit && e.manual[i] === 1) {
        vi = i;
        break;
      }
    }
    expect(vi).toBeGreaterThanOrEqual(0);
    spawnEntity(e, {
      kind: EntityKind.Unit,
      owner: 1,
      typeId: unitDefById('clubman').index,
      x: e.x[vi]! + FX_ONE,
      y: e.y[vi]!,
      hpMax: unitDefById('clubman').hp,
    });
    rebuildGrid(w.grid, w.entities, w.tick);

    w.tick = 60; // 落城から 10 tick（30 秒以内）
    e.hp[vi] = e.hp[vi]! - fx(5);
    loyalty(w);
    expect(w.players[1]!.loyalty).toBe(FX_ONE + fx(-0.25));
    // 成立した村人は追跡から外れる（同じ村人で二重に課さない）。
    expect(fleeingVillagerTrackCount(w)).toBe(2);
  });

  it('30 秒放置するとマップ外へ消える（罰は発生しない）', () => {
    const w = makeWorld();
    const tc = putBuilding(w, 'town_center', 0, 20, 60);
    w.tick = 50;
    markDeadIndex(w.entities, tc);
    cleanup(w);
    expect(fleeingVillagerTrackCount(w)).toBe(3);

    w.tick = 50 + 30 * TICK_RATE;
    loyalty(w);
    expect(fleeingVillagerTrackCount(w)).toBe(0);
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
    expect(w.players[1]!.loyalty).toBe(FX_ONE);

    // 死亡予約されている（cleanup が free list へ返す）。
    cleanup(w);
    const e = w.entities;
    let alive = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] === 1 && e.kind[i] === EntityKind.Unit) alive += 1;
    }
    expect(alive).toBe(0);
  });

  it('30 秒を過ぎてから攻撃しても掟五は成立しない', () => {
    const w = makeWorld();
    const tc = putBuilding(w, 'town_center', 0, 20, 60);
    w.tick = 50;
    markDeadIndex(w.entities, tc);
    cleanup(w);
    const e = w.entities;
    let vi = -1;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] === 1 && e.kind[i] === EntityKind.Unit && e.manual[i] === 1) {
        vi = i;
        break;
      }
    }
    spawnEntity(e, {
      kind: EntityKind.Unit,
      owner: 1,
      typeId: unitDefById('clubman').index,
      x: e.x[vi]! + FX_ONE,
      y: e.y[vi]!,
      hpMax: unitDefById('clubman').hp,
    });
    rebuildGrid(w.grid, w.entities, w.tick);

    // 期限を 1 tick 過ぎたところで殴る（同 tick に期限切れの掃除も走る）。
    w.tick = 50 + 30 * TICK_RATE + 1;
    e.hp[vi] = e.hp[vi]! - fx(5);
    loyalty(w);
    expect(w.players[1]!.loyalty).toBe(FX_ONE);
  });

  it('家を壊しても逃亡村人は出ない（城・町の中心だけ）', () => {
    const w = makeWorld();
    const house = putBuilding(w, 'house', 0, 20, 60);
    w.tick = 50;
    markDeadIndex(w.entities, house);
    cleanup(w);
    expect(fleeingVillagerTrackCount(w)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-M11-03 その他の減算
// ---------------------------------------------------------------------------

describe('T-M11-03: 町の中心を失うと -5% / 1 つ', () => {
  it('1 つ失うと -5%、2 つ同時なら -10%', () => {
    const w = makeWorld();
    const a = putBuilding(w, 'town_center', 0, 20, 20);
    const b = putBuilding(w, 'town_center', 0, 40, 40);
    w.tick = 10;
    loyalty(w); // 前 tick の数（2）を覚える
    expect(w.players[0]!.loyalty).toBe(FX_ONE);

    markDeadIndex(w.entities, a);
    cleanup(w);
    w.tick = 11;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE + fx(-0.05));

    markDeadIndex(w.entities, b);
    cleanup(w);
    w.tick = 12;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE + fx(-0.05) * 2);
  });
});

describe('T-M11-03: 戦域を 3 つ以上同時に見捨てると -10%', () => {
  const idle = 60 * TICK_RATE;

  /** 令が無く劣勢の戦域を n 本立てる。 */
  function makeAbandonedFronts(w: World, n: number): Front[] {
    const out: Front[] = [];
    for (let slot = 1; slot <= n; slot++) {
      const f = makeFront(w, 0, slot, 50 + slot, 50);
      f.advantage = fx(-0.5); // 劣勢（警告）
      out.push(f);
    }
    return out;
  }

  it('3 本を令なしで 60 秒放置し、その間に劣勢へ落ちたら -10%', () => {
    const w = makeWorld();
    makeAbandonedFronts(w, 3);
    w.tick = 100;
    loyalty(w); // 令が無い期間の開始を記録
    expect(w.players[0]!.loyalty).toBe(FX_ONE);

    w.tick = 100 + idle - 1;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE);

    w.tick = 100 + idle;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE + fx(-0.1));

    // 時計を巻き直すので、次の 60 秒までは再度課さない。
    w.tick += 1;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE + fx(-0.1));
  });

  it('2 本だけなら課されない（閾値 3）', () => {
    const w = makeWorld();
    makeAbandonedFronts(w, 2);
    w.tick = 100;
    loyalty(w);
    w.tick = 100 + idle;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
  });

  it('劣勢に落ちていない（優勢な）戦域は「見捨てた」に数えない', () => {
    const w = makeWorld();
    const fs = makeAbandonedFronts(w, 3);
    fs[2]!.advantage = fx(0.5); // 3 本目は優勢
    w.tick = 100;
    loyalty(w);
    w.tick = 100 + idle;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
  });

  it('**後退の令で畳んだ戦域は対象外**（令を渡してあるので数えない）', () => {
    const w = makeWorld();
    const fs = makeAbandonedFronts(w, 3);
    fs[2]!.order = 'retreat';
    w.tick = 100;
    loyalty(w);
    w.tick = 100 + idle;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE);

    // 3 本とも後退で畳んでも当然課されない。
    fs[0]!.order = 'retreat';
    fs[1]!.order = 'retreat';
    w.tick += idle;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
  });

  it('途中で令が届いたら時計がリセットされる', () => {
    const w = makeWorld();
    const fs = makeAbandonedFronts(w, 3);
    w.tick = 100;
    loyalty(w);
    w.tick = 100 + idle - 10;
    fs[0]!.order = 'hold';
    loyalty(w);
    fs[0]!.order = null;
    w.tick = 100 + idle;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
  });
});

// ---------------------------------------------------------------------------
// T-M11-04 閾値
// ---------------------------------------------------------------------------

describe('T-M11-04: 閾値 80% で令の遅延 +2 秒', () => {
  it('80% ちょうどでは掛からず、80% を割ると +2,000ms される', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 110, 10);
    const at = (ratio: number): number => {
      w.players[0]!.loyalty = fx(ratio);
      return orderDelayMs(orderDelayInputFor(w, f));
    };
    const base = at(0.8);
    expect(at(0.79) - base).toBe(2000);
  });

  it('忠誠度を掟破りで下げると自動的に遅延が伸びる（`core/order.ts` 経由）', () => {
    const w = makeWorld();
    w.map.lawZones = new Int32Array([fxFromInt(50), fxFromInt(50), fxFromInt(10), 1]);
    const f = makeFront(w, 0, 1, 50, 50);
    const before = orderDelayMs(orderDelayInputFor(w, f));
    w.tick = 100;
    f.lastEngageTick = w.tick;
    loyalty(w); // 掟一で -25% → 75%
    expect(w.players[0]!.loyalty).toBe(fx(0.75));
    expect(orderDelayMs(orderDelayInputFor(w, f)) - before).toBe(2000);
  });
});

describe('T-M11-04: 閾値 50% で戦域 1 つが離反する', () => {
  it('slot 番号が最大の戦域が離反し、令に反応しなくなる', () => {
    const w = makeWorld();
    makeFront(w, 0, 1, 50, 50);
    makeFront(w, 0, 2, 55, 50);
    const f3 = makeFront(w, 0, 3, 60, 50);
    w.players[0]!.loyalty = fx(0.49);
    w.tick = 10;
    loyalty(w);
    expect(f3.defected).toBe(true);
    expect(getFront(w, 0, 1)!.defected).toBe(false);
    expect(getFront(w, 0, 2)!.defected).toBe(false);

    // 離反した戦域はカードを差し替えても反応しない（届いた令が捨てられる）。
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 3, order: 'charge', tier: 'upper' }]);
    if (f3.pendingOrder !== null) w.tick = f3.pendingOrder.deliverAtTick;
    orderDelivery(w);
    expect(f3.order).toBeNull();
  });

  it('離反するのは 1 つだけ（2 つ目は増えない）', () => {
    const w = makeWorld();
    makeFront(w, 0, 1);
    makeFront(w, 0, 2);
    w.players[0]!.loyalty = fx(0.1);
    for (w.tick = 10; w.tick < 20; w.tick++) loyalty(w);
    let defected = 0;
    for (let slot = 1; slot <= 6; slot++) if (getFront(w, 0, slot)!.defected) defected += 1;
    expect(defected).toBe(1);
  });

  it('忠誠度が 50% まで戻れば旗も戻る', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1);
    w.players[0]!.loyalty = fx(0.4);
    w.tick = 10;
    loyalty(w);
    expect(f.defected).toBe(true);
    w.players[0]!.loyalty = fx(0.5);
    w.tick = 11;
    loyalty(w);
    expect(f.defected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-M11-07 掟の適用 OFF / 休戦の季
// ---------------------------------------------------------------------------

describe('T-M11-07: 掟の適用 OFF で忠誠度の仕組みごと止まる', () => {
  it('掟破りも自然回復も起きない', () => {
    const w = makeWorld();
    configureMatchRules({ lawsEnabled: false });
    w.map.lawZones = new Int32Array([fxFromInt(50), fxFromInt(50), fxFromInt(10), 1]);
    const f = makeFront(w, 0, 1, 50, 50);
    w.players[0]!.loyalty = fx(0.5);
    w.tick = 30 * TICK_RATE;
    f.lastEngageTick = w.tick;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(fx(0.5)); // 掟一の -25% も +1% も無い
    expect(f.defected).toBe(false); // 離反もしない
  });

  it('井戸を自由に壊せる（罰が無い）', () => {
    const w = makeWorld();
    configureMatchRules({ lawsEnabled: false });
    const well = putBuilding(w, 'well', 0, 50, 50);
    putUnit(w, 'clubman', 1, 51, 50);
    w.tick = 10;
    markDeadIndex(w.entities, well);
    loyalty(w);
    expect(w.players[1]!.loyalty).toBe(FX_ONE);
  });

  it('落城しても逃亡村人が出ない', () => {
    const w = makeWorld();
    configureMatchRules({ lawsEnabled: false });
    const tc = putBuilding(w, 'town_center', 0, 20, 60);
    w.tick = 10;
    markDeadIndex(w.entities, tc);
    cleanup(w);
    expect(fleeingVillagerTrackCount(w)).toBe(0);
  });
});

describe('T-M11-07: 休戦の季', () => {
  it('休戦中は新しい戦域が発生しない（孵化が進まない）', () => {
    const w = makeWorld();
    configureMatchRules({ truceSeason: true, truceStartSec: 4, truceDurationSec: 4 });
    const cand = getFront(w, 0, 1)!;
    cand.candidateTicks = 40; // 孵化中（あと少しで戦域化）
    w.tick = 4 * TICK_RATE;
    loyalty(w);
    expect(cand.candidateTicks).toBe(0);
    expect(cand.active).toBe(false);
  });

  it('休戦中は交戦をやめる（攻撃のクールダウンが立つ）が令は消えない', () => {
    const w = makeWorld();
    configureMatchRules({ truceSeason: true, truceStartSec: 4, truceDurationSec: 4 });
    const f = makeFront(w, 0, 1);
    f.order = 'hold';
    const u = putUnit(w, 'clubman', 0, 50, 50);
    w.tick = 4 * TICK_RATE;
    loyalty(w);
    expect(w.entities.cooldown[u]).toBeGreaterThanOrEqual(2);
    expect(f.order).toBe('hold'); // 令は維持される（睨み合い）
  });

  it('守り切ると +15%、破ると貰えない', () => {
    const w = makeWorld(2);
    configureMatchRules({ truceSeason: true, truceStartSec: 4, truceDurationSec: 4 });
    w.players[0]!.loyalty = fx(0.5);
    w.players[1]!.loyalty = fx(0.5);
    // p1 は休戦中に交戦する。
    const f = makeFront(w, 1, 1);
    for (w.tick = 4 * TICK_RATE; w.tick < 8 * TICK_RATE; w.tick++) {
      f.lastEngageTick = w.tick;
      loyalty(w);
    }
    w.tick = 8 * TICK_RATE;
    loyalty(w);
    expect(w.players[0]!.loyalty).toBe(fx(0.5) + fx(0.15));
    expect(w.players[1]!.loyalty).toBe(fx(0.5));
  });

  it('休戦の季が無効なら +15% は配られない', () => {
    const w = makeWorld();
    w.players[0]!.loyalty = fx(0.5);
    w.tick = 960 * TICK_RATE;
    resetLoyaltyState(w);
    loyalty(w);
    // 自然回復 (+1%) しか起きない。
    expect(w.players[0]!.loyalty).toBe(fx(0.5) + fx(0.01));
  });
});

describe('T-M11-07: 戦域スロット上限', () => {
  it('上限 3 にすると frontSlots が 3 に抑えられる', () => {
    const w = makeWorld();
    configureMatchRules({ frontSlotCap: 3 });
    w.players[0]!.frontSlots = 6;
    w.tick = 10;
    loyalty(w);
    expect(w.players[0]!.frontSlots).toBe(3);
  });
});
