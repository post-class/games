/**
 * T-M9-01〜04: 令の発信点・遅延式・切り替え間隔・伝令（`07§4` / 実装手順書 §6.2）
 *
 * 完了条件:
 *  - T-M9-01「城を前に出すと遅延が縮む」
 *  - T-M9-02「**dist=200 + 伝令 + 復唱 = 2.25 秒**」「距離 20/100/200/325 で 1.9/3.5/5.5/8.0 秒」
 *  - T-M9-03「連打しても 6 秒より速くならない」（早馬で 4.2 秒）
 *  - T-M9-04「伝令が 2 体いても −1.0 秒のまま」
 *
 * ---------------------------------------------------------------------------
 * M8（戦域システム）が未完成なので、戦域は手で立てる（`makeFront`）。
 * `frontLifecycle` が実装されたら、このヘルパは「発生条件を満たした直後の状態」と
 * 同じものになるはず（`active` / `radius` / 中心座標だけを使っている）。
 * ---------------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import type { CivId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import { applyCommands } from '@/sim/command';
import { TICK_RATE, cfgNum } from '@/sim/core/config';
import { buildingDefById, techIndex, unitDefById } from '@/sim/core/defs';
import { PROGRESS_DONE, markModifiersDirty } from '@/sim/core/effects';
import { entityIndex, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fx, fxFromInt } from '@/sim/core/fx';
import {
  hasHeraldInFront,
  msToTicks,
  nearestOrderSourceDistFx,
  orderDelayInputFor,
  orderDelayMs,
  orderDelayTicks,
} from '@/sim/core/order';
import { createWorld, getFront, type Front, type World } from '@/sim/core/world';
import { orderDelivery } from '@/sim/systems/orderDelivery';

const MAP = 400;

function makeWorld(civ: CivId = 'yamato'): World {
  const w = createWorld({
    seed: 9,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 512,
    civs: [civ, 'roma'],
  });
  // 本陣（`map.starts`）を左上に固定する。mapgen を通さないので手で入れる。
  w.map.starts[0] = fxFromInt(10);
  w.map.starts[1] = fxFromInt(10);
  w.map.starts[2] = fxFromInt(390);
  w.map.starts[3] = fxFromInt(390);
  w.players[0]!.frontSlots = 6;
  w.players[1]!.frontSlots = 6;
  return w;
}

/** M8 の代わりに戦域を手で立てる。 */
function makeFront(w: World, owner: number, slot: number, tileX: number, tileY: number): Front {
  const f = getFront(w, owner, slot)!;
  f.active = true;
  f.x = fxFromInt(tileX);
  f.y = fxFromInt(tileY);
  f.radius = fx(cfgNum('front.spawnRadiusTiles'));
  return f;
}

function putUnit(w: World, id: string, owner: number, tileX: number, tileY: number): number {
  const d = unitDefById(id);
  return entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: d.index,
      x: fxFromInt(tileX),
      y: fxFromInt(tileY),
      hpMax: d.hp,
    })
  );
}

function putBuilding(w: World, id: string, owner: number, tileX: number, tileY: number): number {
  const d = buildingDefById(id);
  const i = entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Building,
      owner,
      typeId: d.index,
      x: fxFromInt(tileX),
      y: fxFromInt(tileY),
      hpMax: d.hp,
    })
  );
  w.entities.buildProgress[i] = PROGRESS_DONE;
  markModifiersDirty(w, owner);
  return i;
}

function research(w: World, p: number, techId: string): void {
  w.players[p]!.researched[techIndex(techId)] = 1;
  markModifiersDirty(w, p);
}

// ---------------------------------------------------------------------------
// T-M9-02 遅延式（式そのものの検算。上流資料の数値を直書きする）
// ---------------------------------------------------------------------------

describe('T-M9-02: 遅延式（`07§4` の検算値）', () => {
  const base = { herald: false, delayMul: FX_ONE, distanceZero: false, lowLoyalty: false };

  it('dist=200 + 伝令 + 復唱 = 2.25 秒（= 2250ms / 56 tick）', () => {
    const ms = orderDelayMs({
      ...base,
      distFx: fxFromInt(200),
      herald: true,
      delayMul: fx(0.5),
    });
    // (1.5 + 200*0.02 - 1.0) * 0.5 = (1.5 + 4.0 - 1.0) * 0.5 = 2.25
    expect(ms).toBe(2250);
    expect(msToTicks(ms)).toBe(56); // 2.25 秒 × 25 tick/秒 = 56.25 → 56
  });

  it('距離 20 / 100 / 200 / 325 で 1.9 / 3.5 / 5.5 / 8.0 秒', () => {
    const table: readonly [number, number][] = [
      [20, 1900],
      [100, 3500],
      [200, 5500],
      [325, 8000],
    ];
    for (const [tiles, expected] of table) {
      expect(orderDelayMs({ ...base, distFx: fxFromInt(tiles) }), `dist=${tiles}`).toBe(expected);
    }
  });

  it('上限 8.0 秒 / 下限 0.5 秒でクランプされる', () => {
    // 325 マスで既に上限。それ以上いくら離れても 8 秒。
    expect(orderDelayMs({ ...base, distFx: fxFromInt(1000) })).toBe(8000);
    // 距離 0 + 伝令 + 復唱 = (1.5 - 1.0) * 0.5 = 0.25 秒 → 下限 0.5 秒
    expect(orderDelayMs({ ...base, distFx: 0, herald: true, delayMul: fx(0.5) })).toBe(500);
  });

  it('忠誠度 80% 未満は +2.0 秒（乗算ではなく加算。丸め前に足す）', () => {
    // dist=100: 3.5 秒。復唱ありなら 1.75 秒。そこに +2.0 秒 = 3.75 秒。
    // 乗算だったら (3.5 + 2.0) * 0.5 = 2.75 秒になるので、順序の違いが数値で出る。
    const withPenalty = orderDelayMs({
      ...base,
      distFx: fxFromInt(100),
      delayMul: fx(0.5),
      lowLoyalty: true,
    });
    expect(withPenalty).toBe(1750 + 2000);
  });

  it('モンゴル「駅伝」は距離の項を 0 にする（常に 1.5 秒、復唱併用で 0.75 秒）', () => {
    expect(orderDelayMs({ ...base, distFx: fxFromInt(300), distanceZero: true })).toBe(1500);
    expect(
      orderDelayMs({ ...base, distFx: fxFromInt(300), distanceZero: true, delayMul: fx(0.5) })
    ).toBe(750);
  });

  it('計算順（伝令 → 復唱 → 忠誠度）が入れ替わっていない', () => {
    // 伝令が復唱の**前**に効くこと: dist=200 で (5.5 - 1.0) * 0.5 = 2.25
    // 後に効いていたら 5.5*0.5 - 1.0 = 1.75 になる。
    expect(
      orderDelayMs({ ...base, distFx: fxFromInt(200), herald: true, delayMul: fx(0.5) })
    ).toBe(2250);
  });
});

// ---------------------------------------------------------------------------
// T-M9-01 発信点と距離
// ---------------------------------------------------------------------------

describe('T-M9-01: 発信点（本陣 ∪ 城 ∪ 大天幕）からの距離', () => {
  it('本陣しかなければ本陣からの距離になる', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 110, 10); // 本陣 (10,10) から 100 マス
    const d = nearestOrderSourceDistFx(w, 0, f.x, f.y);
    expect(d).toBe(fxFromInt(100));
    expect(orderDelayMs(orderDelayInputFor(w, f))).toBe(3500);
  });

  it('**城を前に出すと遅延が縮む**（完了条件）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 210, 10); // 本陣から 200 マス
    const before = orderDelayMs(orderDelayInputFor(w, f));
    expect(before).toBe(5500);

    // 戦域の 50 マス手前に城を建てる → 距離が 200 → 50 に縮む
    putBuilding(w, 'castle', 0, 160, 10);
    const after = orderDelayMs(orderDelayInputFor(w, f));
    expect(nearestOrderSourceDistFx(w, 0, f.x, f.y)).toBe(fxFromInt(50));
    expect(after).toBe(1500 + 50 * 20);
    expect(after).toBeLessThan(before);
  });

  it('町の中心も発信点（`buildings.json` の isOrderSource）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 210, 10);
    putBuilding(w, 'town_center', 0, 200, 10);
    expect(nearestOrderSourceDistFx(w, 0, f.x, f.y)).toBe(fxFromInt(10));
  });

  it('建設中の城は発信点にならない（完成してはじめて令を出せる）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 210, 10);
    const i = putBuilding(w, 'castle', 0, 160, 10);
    w.entities.buildProgress[i] = 0; // 着工直後に戻す
    expect(nearestOrderSourceDistFx(w, 0, f.x, f.y)).toBe(fxFromInt(200));
  });

  it('敵の城は自分の発信点にならない', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 210, 10);
    putBuilding(w, 'castle', 1, 205, 10);
    expect(nearestOrderSourceDistFx(w, 0, f.x, f.y)).toBe(fxFromInt(200));
  });

  it('モンゴルの大天幕は発信点（畳んで前に出せる = movable）', () => {
    const w = makeWorld('mongol');
    const f = makeFront(w, 0, 1, 210, 10);
    const i = putBuilding(w, 'great_tent', 0, 190, 10);
    expect(nearestOrderSourceDistFx(w, 0, f.x, f.y)).toBe(fxFromInt(20));
    // 畳んで 10 マス前に出す（発信点ごと動く）
    w.entities.x[i] = fxFromInt(200);
    expect(nearestOrderSourceDistFx(w, 0, f.x, f.y)).toBe(fxFromInt(10));
  });
});

// ---------------------------------------------------------------------------
// T-M9-04 伝令ユニット
// ---------------------------------------------------------------------------

describe('T-M9-04: 伝令ユニット（戦域内 1 体で −1.0 秒、重複なし）', () => {
  it('1 体で −1.0 秒', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 110, 10);
    expect(orderDelayMs(orderDelayInputFor(w, f))).toBe(3500);
    const h = putUnit(w, 'herald', 0, 110, 10);
    w.entities.frontId[h] = 1;
    expect(hasHeraldInFront(w, f)).toBe(true);
    expect(orderDelayMs(orderDelayInputFor(w, f))).toBe(2500);
  });

  it('**2 体いても −1.0 秒のまま**（完了条件）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 110, 10);
    const a = putUnit(w, 'herald', 0, 110, 10);
    const b = putUnit(w, 'herald', 0, 111, 10);
    w.entities.frontId[a] = 1;
    w.entities.frontId[b] = 1;
    expect(orderDelayMs(orderDelayInputFor(w, f))).toBe(2500);
  });

  it('戦域の外の伝令・敵の伝令は効かない', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 110, 10);
    putUnit(w, 'herald', 0, 300, 300); // 半径外
    putUnit(w, 'herald', 1, 110, 10); // 敵の伝令
    expect(hasHeraldInFront(w, f)).toBe(false);
    expect(orderDelayMs(orderDelayInputFor(w, f))).toBe(3500);
  });

  it('半径内にいれば編入前（frontId = 0）でも効く', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 110, 10);
    putUnit(w, 'herald', 0, 112, 10);
    expect(w.entities.frontId[0]).toBe(0);
    expect(hasHeraldInFront(w, f)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 遅延の結線（setOrder → orderDelivery）
// ---------------------------------------------------------------------------

describe('遅延の結線: setOrder が本計算の tick を積み、orderDelivery が発効させる', () => {
  it('距離ぶん待たされてから発効する（押した瞬間には効かない。§16-4）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 110, 10); // 100 マス → 3.5 秒 = 88 tick
    const expected = msToTicks(3500);
    expect(expected).toBe(Math.round(3.5 * TICK_RATE));

    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' }]);
    expect(f.pendingOrder!.deliverAtTick).toBe(expected);
    expect(f.order).toBeNull();

    // 1 tick 手前ではまだ届かない
    for (w.tick = 0; w.tick < expected; w.tick++) orderDelivery(w);
    expect(f.order).toBeNull();
    orderDelivery(w); // w.tick === expected
    expect(f.order).toBe('charge');
    expect(f.pendingOrder).toBeNull();
    expect(f.lastSwitchTick).toBe(expected);
  });

  it('復唱を取ると遅延が半分になる', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 110, 10);
    research(w, 0, 'fukusho');
    expect(orderDelayTicks(w, f)).toBe(msToTicks(1750));
  });

  it('忠誠度 80% 未満で +2.0 秒（境界: 80% ちょうどは掛からない）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 110, 10);
    w.players[0]!.loyalty = fx(0.8);
    expect(orderDelayMs(orderDelayInputFor(w, f))).toBe(3500);
    w.players[0]!.loyalty = fx(0.79);
    expect(orderDelayMs(orderDelayInputFor(w, f))).toBe(5500);
  });

  it('離反した戦域に届いた令は捨てられる（`07§10`）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 20, 10);
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' }]);
    f.defected = true;
    w.tick = f.pendingOrder!.deliverAtTick;
    orderDelivery(w);
    expect(f.order).toBeNull();
    expect(f.pendingOrder).toBeNull();
  });

  it('閉じた戦域に配達中だった令は捨てられる', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 20, 10);
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' }]);
    f.active = false;
    orderDelivery(w);
    expect(f.pendingOrder).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T-M9-03 切り替え間隔
// ---------------------------------------------------------------------------

describe('T-M9-03: 切り替え間隔 6 秒（早馬で 4.2 秒）', () => {
  const SWITCH_TICKS = Math.round(cfgNum('order.switchIntervalSec') * TICK_RATE);

  /** 令をセットして発効させ、発効 tick を返す。 */
  function setAndDeliver(w: World, f: Front, order: 'charge' | 'hold'): number {
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order, tier: 'upper' }]);
    if (f.pendingOrder === null) return -1;
    const at = f.pendingOrder.deliverAtTick;
    while (w.tick < at) {
      w.tick++;
      orderDelivery(w);
    }
    return at;
  }

  it('**連打しても 6 秒より速くならない**（完了条件）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 20, 10); // 本陣のすぐ隣（遅延は最小）
    const first = setAndDeliver(w, f, 'charge');
    expect(f.order).toBe('charge');

    // 100 tick（4 秒）のあいだ毎 tick 連打する。1 件も通ってはいけない。
    for (let k = 0; k < 100; k++) {
      applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'hold', tier: 'upper' }]);
      expect(f.pendingOrder, `tick ${w.tick} で受け付けてしまった`).toBeNull();
      w.tick++;
      orderDelivery(w);
    }
    expect(f.order).toBe('charge');

    // 6 秒（150 tick）を過ぎたら通る
    w.tick = first + SWITCH_TICKS;
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'hold', tier: 'upper' }]);
    expect(f.pendingOrder).not.toBeNull();
    // 次の令が発効するのは「前の発効 + 6 秒 + 遅延」以降
    expect(f.pendingOrder!.deliverAtTick).toBeGreaterThanOrEqual(first + SWITCH_TICKS);
  });

  it('研究「早馬」で間隔が 6.0 → 4.2 秒に縮む', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 20, 10);
    research(w, 0, 'hayaba');
    const first = setAndDeliver(w, f, 'charge');
    // 6.0 秒 × 0.7 = 4.2 秒 = **105 tick**。
    // 資料に秒で書かれている数字なので、tick への変換は四捨五入する
    // （切り捨てだと 104 tick = 4.16 秒になり 1 tick ずれる）。
    const hayabaTicks = 105;
    expect(hayabaTicks).toBe(Math.round(4.2 * TICK_RATE));

    // 4.2 秒の 1 tick 手前は通らない
    w.tick = first + hayabaTicks - 1;
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'hold', tier: 'upper' }]);
    expect(f.pendingOrder).toBeNull();
    // 4.2 秒で通る（6 秒より速い）
    w.tick = first + hayabaTicks;
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'hold', tier: 'upper' }]);
    expect(f.pendingOrder).not.toBeNull();
    expect(hayabaTicks).toBeLessThan(SWITCH_TICKS);
  });

  it('配達中の入力はキューに積まれず捨てられる（連打対策。`06§4`）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 210, 10); // 遠い戦線（遅延 5.5 秒）
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' }]);
    const pending = f.pendingOrder!;
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'hold', tier: 'upper' }]);
    expect(f.pendingOrder).toBe(pending); // 差し替わっていない = 積まれていない
    w.tick = pending.deliverAtTick;
    orderDelivery(w);
    expect(f.order).toBe('charge');
  });
});
