/**
 * M9 の決定論（T-M9-05 の「乱数を使っていない」／§0.3）
 *
 * 見るもの:
 *  1. 令を配りながら 2 回回すと **ハッシュ列が完全一致**する
 *  2. `unitDecision` / `orderDelivery` が **rng を 1 度も消費しない**
 *  3. **判断が tick に対して分散している**（`entityIndex % 12`。乱数ではない）
 *  4. エンティティを**逆順に生成しても**（= 別の index 割り当てでも）
 *     令の遅延と目標選択の結果が「index の昇順」という規則だけで決まる
 *  5. 令の遅延が距離だけで決まる（同じ配置なら常に同じ tick に発効する）
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import type { Command } from '@/sim/command';
import { applyCommands } from '@/sim/command';
import { cfgNum } from '@/sim/core/config';
import { unitDefById } from '@/sim/core/defs';
import { entityIndex, spawnEntity } from '@/sim/core/entity';
import { fx, fxFromInt } from '@/sim/core/fx';
import { rebuildGrid } from '@/sim/core/grid';
import { allocateTerrain } from '@/sim/core/terrain';
import { orderDelayTicks } from '@/sim/core/order';
import { createWorld, getFront, type World } from '@/sim/core/world';
import { hashWorld } from '@/sim/hash';
import { HASH_CHECK_INTERVAL_TICKS, stepWorld } from '@/sim/index';
import { orderDelivery } from '@/sim/systems/orderDelivery';
import { DECISION_PERIOD_TICKS, unitDecision } from '@/sim/systems/unitDecision';

const MAP = 120;
const RUN_TICKS = 3000;

/** 令の効いた小競り合いを 1 つ作る（M8 が未完成なので戦域は手で立てる）。 */
function buildWorld(seed: number, reverse = false): World {
  const w = createWorld({
    seed,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 512,
  });
  allocateTerrain(w.map);
  w.map.starts[0] = fxFromInt(20);
  w.map.starts[1] = fxFromInt(20);
  w.map.starts[2] = fxFromInt(100);
  w.map.starts[3] = fxFromInt(100);

  for (const p of [0, 1]) {
    w.players[p]!.frontSlots = 6;
    const f = getFront(w, p, 1)!;
    f.active = true;
    f.x = fxFromInt(60);
    f.y = fxFromInt(60);
    f.radius = fx(cfgNum('front.growMaxRadiusTiles'));
  }

  const units: readonly [string, number, number, number][] = [
    ['y-ashigaru', 0, 50, 58],
    ['y-ashigaru', 0, 51, 60],
    ['y-yumiashigaru', 0, 49, 62],
    ['y-kiba', 0, 48, 60],
    ['herald', 0, 52, 60],
    ['r-hastati', 1, 70, 58],
    ['r-hastati', 1, 71, 60],
    ['r-slinger', 1, 72, 62],
    ['r-eq-light', 1, 73, 60],
    ['villager', 1, 74, 64],
  ];
  const order = reverse ? [...units].reverse() : units;
  for (const [id, owner, x, y] of order) {
    const d = unitDefById(id);
    const i = entityIndex(
      spawnEntity(w.entities, {
        kind: EntityKind.Unit,
        owner,
        typeId: d.index,
        x: fxFromInt(x),
        y: fxFromInt(y),
        hpMax: d.hp,
      })
    );
    w.entities.frontId[i] = 1;
  }
  return w;
}

/** tick だけを入力にした令の配り方（同じ plan なら同じ入力列になる）。 */
function plan(tick: number): readonly Command[] {
  if (tick === 10) {
    return [
      { t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' },
      { t: 'setOrder', p: 1, front: 1, order: 'hold', tier: 'upper' },
    ];
  }
  if (tick === 400) return [{ t: 'setOrder', p: 0, front: 1, order: 'retreat', tier: 'upper' }];
  if (tick === 800) return [{ t: 'setOrder', p: 1, front: 1, order: 'charge', tier: 'upper' }];
  if (tick === 1200) return [{ t: 'setOrder', p: 0, front: 1, order: 'hold', tier: 'upper' }];
  return [];
}

function runMatch(seed: number): { hashes: number[]; final: number } {
  const w = buildWorld(seed);
  const hashes: number[] = [];
  for (let t = 0; t < RUN_TICKS; t++) {
    stepWorld(w, plan(w.tick));
    if (w.tick % HASH_CHECK_INTERVAL_TICKS === 0) hashes.push(hashWorld(w));
  }
  return { hashes, final: hashWorld(w) };
}

describe('M9 決定論: 令を配った試合の再現', () => {
  it('同じシード・同じ令の配り方ならハッシュ列が完全一致する', () => {
    const a = runMatch(4242);
    const b = runMatch(4242);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.final).toBe(b.final);
    // 令が実際に効いて状態が動いていること（全部同じ値なら試験になっていない）
    expect(new Set(a.hashes).size).toBeGreaterThan(1);
  });

  it('unitDecision / orderDelivery が rng を消費しない', () => {
    const w = buildWorld(7);
    rebuildGrid(w.grid, w.entities, 0);
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' }]);
    const before = [w.rngCombat.state, w.rngAi.state, w.rngMap.state];
    for (let t = 0; t < 200; t++) {
      w.tick = t;
      orderDelivery(w);
      unitDecision(w);
    }
    expect([w.rngCombat.state, w.rngAi.state, w.rngMap.state]).toEqual(before);
  });

  it('判断は `entityIndex % 12` で分散する（12 tick で全員がちょうど 1 回）', () => {
    const w = buildWorld(8);
    getFront(w, 0, 1)!.order = 'charge';
    rebuildGrid(w.grid, w.entities, 0);
    const e = w.entities;

    // 各ユニットが「どの tick で目標を書き換えられたか」を数える。
    const touched = new Int32Array(e.highWater);
    for (let t = 0; t < DECISION_PERIOD_TICKS; t++) {
      const snapshot = Array.from({ length: e.highWater }, (_, i) => e.destX[i]!);
      // 位相を判別するため、毎 tick 前に目標を潰しておく
      for (let i = 0; i < e.highWater; i++) e.destX[i] = -1;
      w.tick = t;
      unitDecision(w);
      for (let i = 0; i < e.highWater; i++) {
        if (e.destX[i] !== -1) {
          touched[i] = touched[i]! + 1;
          expect(i % DECISION_PERIOD_TICKS, `index ${i} が tick ${t} に判断した`).toBe(t);
        }
        e.destX[i] = snapshot[i]!;
      }
    }
    // 判断エンジンが扱う兵は全員ちょうど 1 回だけ判断している。
    // 村人は経済（M4）の担当で、建設の令が無いときは判断しない（0 回）。
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1) continue;
      const isVillager = e.typeId[i] === unitDefById('villager').index;
      expect(touched[i], `index ${i}`).toBe(isVillager ? 0 : 1);
    }
  });

  it('生成順（index の割り当て）が変わっても遅延の計算は変わらない', () => {
    const a = buildWorld(11, false);
    const b = buildWorld(11, true);
    const fa = getFront(a, 0, 1)!;
    const fb = getFront(b, 0, 1)!;
    // 伝令の index は違うが「戦域内に伝令がいる」判定は同じ → 同じ遅延
    expect(orderDelayTicks(a, fa)).toBe(orderDelayTicks(b, fb));
  });

  it('同じ配置なら同じ tick に発効する（遅延は距離だけで決まる）', () => {
    for (const seed of [1, 2, 3]) {
      const w = buildWorld(seed);
      const f = getFront(w, 0, 1)!;
      applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' }]);
      // 本陣 (20,20) → 戦域 (60,60) = 56 マス、伝令あり → (1.5 + 1.12 - 1.0) = 1.62 秒
      expect(f.pendingOrder!.deliverAtTick).toBe(41);
    }
  });

  it('目標の集中（claims）が周期をまたいで積まれても決定論が保たれる', () => {
    const a = buildWorld(21);
    const b = buildWorld(21);
    getFront(a, 0, 1)!.order = 'charge';
    getFront(b, 0, 1)!.order = 'charge';
    for (const w of [a, b]) {
      for (let t = 0; t < DECISION_PERIOD_TICKS * 3; t++) {
        rebuildGrid(w.grid, w.entities, t);
        w.tick = t;
        unitDecision(w);
      }
    }
    const snap = (w: World): string =>
      Array.from({ length: w.entities.highWater }, (_, i) =>
        [w.entities.target[i], w.entities.destX[i], w.entities.destY[i]].join(',')
      ).join('|');
    expect(snap(a)).toBe(snap(b));
    // 目標が実際に割り振られていること
    expect(snap(a)).not.toBe(
      Array.from({ length: a.entities.highWater }, () => '-1,0,0').join('|')
    );
  });
});
