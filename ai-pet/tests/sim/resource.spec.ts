/**
 * resource.ts（資源の回復・荒廃度・収穫・水やり）のテスト
 * 既定の世界は全面 grass（TERRAINS[0]）なので worldgen には依存しない。
 */
import { describe, expect, it } from 'vitest';
import {
  RESOURCE,
  Rng,
  SEASON_TABLE,
  TICKS_PER_ISLAND_DAY,
  TICKS_PER_ISLAND_HOUR,
  type ResourceNode,
  type ResourceType,
} from '@ai-pet/shared';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { WorldClock } from '../../packages/server/src/sim/clock.ts';
import { harvest, isAvailable, updateResources, water } from '../../packages/server/src/sim/resource.ts';

function newWorld(): IslandWorld {
  return new IslandWorld(new Rng('res'));
}

function newClock(season: 'spring' | 'summer' | 'autumn' | 'winter' = 'spring'): WorldClock {
  const c = new WorldClock(new Rng('res'));
  c.restore({ islandDay: 1, season, weather: 'clear' });
  return c;
}

function addNode(
  world: IslandWorld,
  opts: { x: number; y: number; amount: number; max?: number; regen?: number; type?: ResourceType },
): ResourceNode {
  return world.addResource({
    id: world.allocId(),
    type: opts.type ?? 'berry_tree',
    pos: { x: opts.x + 0.5, y: opts.y + 0.5 },
    amount: opts.amount,
    max: opts.max ?? 100,
    regenPerIslandHour: opts.regen ?? 1,
  });
}

function run(world: IslandWorld, clock: WorldClock, ticks: number, from = 0): void {
  for (let t = from + 1; t <= from + ticks; t++) updateResources(world, t, clock);
}

describe('資源の回復', () => {
  it('1島時間で「回復量 × 季節倍率」だけ回復する', () => {
    const w = newWorld();
    const node = addNode(w, { x: 10, y: 10, amount: 0, regen: 2 });
    run(w, newClock('spring'), TICKS_PER_ISLAND_HOUR);
    expect(node.amount).toBeCloseTo(2 * SEASON_TABLE.spring.regen, 6);
  });

  it('冬は回復が遅く、秋は速い', () => {
    const winterWorld = newWorld();
    const winter = addNode(winterWorld, { x: 10, y: 10, amount: 0, regen: 2 });
    run(winterWorld, newClock('winter'), TICKS_PER_ISLAND_HOUR);

    const autumnWorld = newWorld();
    const autumn = addNode(autumnWorld, { x: 10, y: 10, amount: 0, regen: 2 });
    run(autumnWorld, newClock('autumn'), TICKS_PER_ISLAND_HOUR);

    expect(winter.amount).toBeLessThan(autumn.amount);
    expect(winter.amount).toBeCloseTo(2 * SEASON_TABLE.winter.regen, 6);
    expect(autumn.amount / winter.amount).toBeCloseTo(SEASON_TABLE.autumn.regen / SEASON_TABLE.winter.regen, 5);
  });

  it('max を超えない', () => {
    const w = newWorld();
    const node = addNode(w, { x: 10, y: 10, amount: 5, max: 6, regen: 10 });
    run(w, newClock(), TICKS_PER_ISLAND_HOUR * 5);
    expect(node.amount).toBe(6);
  });

  it('荒廃度が高いタイルの資源は回復が遅い', () => {
    const w = newWorld();
    const clean = addNode(w, { x: 10, y: 10, amount: 0, regen: 2 });
    const ruined = addNode(w, { x: 20, y: 20, amount: 0, regen: 2 });
    w.addDecay(20, 20, RESOURCE.maxDecay);

    run(w, newClock(), TICKS_PER_ISLAND_HOUR);

    expect(ruined.amount).toBeLessThan(clean.amount);
    // 1島時間のあいだに荒廃度自体も少し減るので、倍率はほぼ (1 - penalty)
    expect(ruined.amount / clean.amount).toBeCloseTo(1 - RESOURCE.decayRegenPenalty, 2);
  });
});

describe('harvest', () => {
  it('欲しい量だけ採れ、在庫を超えては採れない', () => {
    const w = newWorld();
    const node = addNode(w, { x: 10, y: 10, amount: 3, max: 6 });
    expect(harvest(w, node, 2, 1)).toBeCloseTo(2, 6);
    expect(node.amount).toBeCloseTo(1, 6);
    expect(harvest(w, node, 5, 2)).toBeCloseTo(1, 6);
    expect(node.amount).toBe(0);
    expect(harvest(w, node, 5, 3)).toBe(0);
  });

  it('0以下の要求では何も採らない', () => {
    const w = newWorld();
    const node = addNode(w, { x: 10, y: 10, amount: 3 });
    expect(harvest(w, node, 0, 1)).toBe(0);
    expect(harvest(w, node, -1, 1)).toBe(0);
    expect(node.amount).toBe(3);
  });

  it('採ると資源のタイルの荒廃度が上がる（上限は maxDecay）', () => {
    const w = newWorld();
    const node = addNode(w, { x: 10, y: 10, amount: 100 });
    expect(w.decayAt(10, 10)).toBe(0);
    harvest(w, node, 1, 1);
    expect(w.decayAt(10, 10)).toBe(RESOURCE.decayPerHarvest);
    harvest(w, node, 1, 2);
    expect(w.decayAt(10, 10)).toBe(RESOURCE.decayPerHarvest * 2);

    for (let i = 0; i < 100; i++) harvest(w, node, 1, 3 + i);
    expect(w.decayAt(10, 10)).toBe(RESOURCE.maxDecay);
  });

  it('在庫が無いときは荒廃度も上がらない', () => {
    const w = newWorld();
    const node = addNode(w, { x: 10, y: 10, amount: 0 });
    harvest(w, node, 1, 1);
    expect(w.decayAt(10, 10)).toBe(0);
  });

  it('isAvailable は在庫の有無を返す', () => {
    const w = newWorld();
    const node = addNode(w, { x: 10, y: 10, amount: 1 });
    expect(isAvailable(node)).toBe(true);
    harvest(w, node, 1, 1);
    expect(isAvailable(node)).toBe(false);
  });
});

describe('水やり', () => {
  it('水やり中は回復が速くなり、期限が切れると元に戻る', () => {
    const w = newWorld();
    const watered = addNode(w, { x: 10, y: 10, amount: 0, regen: 2 });
    const plain = addNode(w, { x: 20, y: 20, amount: 0, regen: 2 });
    const clock = newClock();

    water(watered, 0);
    run(w, clock, TICKS_PER_ISLAND_HOUR);
    expect(watered.amount / plain.amount).toBeCloseTo(RESOURCE.wateredRegenMultiplier, 5);

    // 期限（wateredIslandHours）を過ぎたら差が広がらない
    const from = RESOURCE.wateredIslandHours * TICKS_PER_ISLAND_HOUR;
    run(w, clock, TICKS_PER_ISLAND_HOUR, from);
    const gapAfter = watered.amount - plain.amount;
    run(w, clock, TICKS_PER_ISLAND_HOUR, from + TICKS_PER_ISLAND_HOUR);
    expect(watered.amount - plain.amount).toBeCloseTo(gapAfter, 6);
  });

  it('期限は wateredIslandHours ぶん先になる', () => {
    const w = newWorld();
    const node = addNode(w, { x: 10, y: 10, amount: 0 });
    water(node, 1000);
    expect(node.wateredUntilTick).toBe(1000 + RESOURCE.wateredIslandHours * TICKS_PER_ISLAND_HOUR);
    // 期限切れ後に触ると片付けられる
    harvest(w, node, 1, node.wateredUntilTick as number);
    expect(node.wateredUntilTick).toBeUndefined();
  });
});

describe('荒廃度の自然減衰（分割走査）', () => {
  it('1島日で「島時間あたりの減衰量 × 24」ぶん減る（全タイル走査しない実装でも整合する）', () => {
    const w = newWorld();
    const tiles: [number, number][] = [
      [1, 0],
      [37, 42],
      [64, 64],
      [127, 127],
    ];
    for (const [x, y] of tiles) w.addDecay(x, y, RESOURCE.maxDecay);

    run(w, newClock(), TICKS_PER_ISLAND_DAY);

    const expected = RESOURCE.maxDecay - RESOURCE.decayRecoverPerIslandHour * 24;
    for (const [x, y] of tiles) {
      // 走査の位相と整数化のため 1周ぶん（±2）の誤差を許容する
      expect(w.decayAt(x, y)).toBeGreaterThanOrEqual(expected - 2);
      expect(w.decayAt(x, y)).toBeLessThanOrEqual(expected + 2);
    }
  });

  it('マップのどの位置でも同じだけ減る（スライスの偏りがない）', () => {
    const w = newWorld();
    for (let i = 0; i < 128; i++) w.addDecay(i, i, RESOURCE.maxDecay);
    run(w, newClock(), TICKS_PER_ISLAND_HOUR * 6);

    const values: number[] = [];
    for (let i = 0; i < 128; i++) values.push(w.decayAt(i, i));
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(2);
  });

  it('0未満にはならない', () => {
    const w = newWorld();
    w.addDecay(50, 50, 5);
    run(w, newClock(), TICKS_PER_ISLAND_DAY);
    expect(w.decayAt(50, 50)).toBe(0);
  });

  it('荒廃度が減ると回復の遅さも解消していく', () => {
    const w = newWorld();
    const node = addNode(w, { x: 10, y: 10, amount: 0, regen: 2 });
    w.addDecay(10, 10, RESOURCE.maxDecay);
    const clock = newClock();

    run(w, clock, TICKS_PER_ISLAND_HOUR);
    const firstHour = node.amount;
    expect(w.decayAt(10, 10)).toBeLessThan(RESOURCE.maxDecay);

    node.amount = 0;
    run(w, clock, TICKS_PER_ISLAND_HOUR * 10, TICKS_PER_ISLAND_HOUR);
    // 10島時間ぶんなので単純比較はできないが、1時間あたりの伸びが良くなっていること
    expect(node.amount / 10).toBeGreaterThan(firstHour);
  });
});
