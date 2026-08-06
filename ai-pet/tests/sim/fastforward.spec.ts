/**
 * 圧縮シミュレーションのテスト（docs 09章 M3 の完了条件「fastForward(24島時間)が破綻しない」）
 *
 * 単位: 実時間1分 = 240tick / 島の1時間 = 600tick / 島の1日 = 14400tick（60実分）
 */
import { describe, expect, test } from 'vitest';
import {
  MAX_CRITTERS,
  MIN_CRITTERS,
  TICKS_PER_ISLAND_DAY,
  TICKS_PER_ISLAND_HOUR,
  TICK_MS,
} from '@ai-pet/shared';
import { IslandSim } from '../../packages/server/src/sim/island.ts';
import { spawnInitialCritters } from '../../packages/server/src/sim/spawn.ts';
import {
  MAX_FASTFORWARD_TICKS,
  describeFastForward,
  fastForward,
  offlineMsToTicks,
} from '../../packages/server/src/sim/fastforward.ts';

function newIsland(seed: string, critters?: number): IslandSim {
  const sim = new IslandSim({ islandId: 'main', seed });
  spawnInitialCritters(sim.world, critters);
  return sim;
}

describe('offlineMsToTicks', () => {
  test('実時間をtickに換算する', () => {
    expect(offlineMsToTicks(TICK_MS)).toBe(1);
    expect(offlineMsToTicks(60_000)).toBe(240); // 実1分
    expect(offlineMsToTicks(3_600_000)).toBe(14_400); // 実1時間 = 島の1日
    expect(offlineMsToTicks(100)).toBe(0);
    expect(offlineMsToTicks(-5)).toBe(0);
  });

  test('24島時間の上限は島の1日ぶん', () => {
    expect(MAX_FASTFORWARD_TICKS).toBe(TICKS_PER_ISLAND_DAY);
  });
});

describe('fastForward', () => {
  test('島時間とtickが進む', () => {
    const sim = newIsland('ff-basic');
    const before = sim.tick;
    const r = fastForward(sim, TICKS_PER_ISLAND_HOUR * 2);
    expect(r.ticks).toBe(TICKS_PER_ISLAND_HOUR * 2);
    expect(r.islandHours).toBe(2);
    expect(sim.tick).toBe(before + r.ticks);
  });

  test('0tickなら何も起きない', () => {
    const sim = newIsland('ff-zero');
    const before = sim.tick;
    const r = fastForward(sim, 0);
    expect(r.ticks).toBe(0);
    expect(sim.tick).toBe(before);
  });

  test('240tickに満たない端数も進む', () => {
    const sim = newIsland('ff-small');
    const r = fastForward(sim, 100);
    expect(r.ticks).toBe(100);
    expect(sim.tick).toBe(100);
  });

  test('24島時間で打ち切る', () => {
    const sim = newIsland('ff-clamp');
    const r = fastForward(sim, TICKS_PER_ISLAND_DAY * 5);
    expect(r.clamped).toBe(true);
    expect(r.ticks).toBe(MAX_FASTFORWARD_TICKS);
    expect(r.islandHours).toBe(24);
  });

  test('24島時間ぶん早送りしても島が破綻しない', () => {
    const sim = newIsland('ff-24h');
    const r = fastForward(sim, MAX_FASTFORWARD_TICKS);

    expect(sim.world.countActors('critter'), '動物が絶滅した').toBeGreaterThanOrEqual(MIN_CRITTERS);
    expect(sim.world.countActors('critter'), '動物が増えすぎた').toBeLessThanOrEqual(MAX_CRITTERS);
    expect(sim.world.totalResourceAmount(), '食料が枯れ切った').toBeGreaterThan(0);
    expect(sim.world.decayedTileRatio(), '島が砂漠化した').toBeLessThan(0.5);
    expect(r.fed, '誰も食べていない').toBeGreaterThan(0);
    expect(r.dayChanges).toBe(1); // 24島時間 = 1島日
  });

  test('早送り後も欲求と健康が範囲内', () => {
    const sim = newIsland('ff-needs');
    fastForward(sim, TICKS_PER_ISLAND_HOUR * 12);
    for (const a of sim.world.actors.values()) {
      if (a.kind !== 'critter') continue;
      for (const v of Object.values(a.needs)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
      expect(a.health).toBeGreaterThan(0);
    }
  });

  test('早送りは通常のstepと大きく乖離しない（同じ島時間ぶん）', () => {
    const real = newIsland('ff-compare');
    for (let i = 0; i < TICKS_PER_ISLAND_DAY; i++) real.step();

    const ff = newIsland('ff-compare');
    fastForward(ff, TICKS_PER_ISLAND_DAY);

    const ratio = (a: number, b: number): number => (b === 0 ? (a === 0 ? 1 : Infinity) : a / b);
    const critterRatio = ratio(ff.world.countActors('critter'), real.world.countActors('critter'));
    const resourceRatio = ratio(ff.world.totalResourceAmount(), real.world.totalResourceAmount());

    // 完全一致は求めない（早送りは行動を粗く再現する）。桁が変わらないことを見る
    expect(critterRatio, `個体数比 ${critterRatio.toFixed(2)}`).toBeGreaterThan(0.8);
    expect(critterRatio, `個体数比 ${critterRatio.toFixed(2)}`).toBeLessThan(1.3);
    expect(resourceRatio, `資源比 ${resourceRatio.toFixed(2)}`).toBeGreaterThan(0.5);
    expect(resourceRatio, `資源比 ${resourceRatio.toFixed(2)}`).toBeLessThan(2.0);
  });

  test('夜のあいだ寝ていた扱いになる（眠気が振り切れない）', () => {
    const sim = newIsland('ff-night');
    fastForward(sim, MAX_FASTFORWARD_TICKS);
    const critters = [...sim.world.actors.values()].filter((a) => a.kind === 'critter');
    const avgSleep = critters.reduce((s, a) => s + a.needs.sleep, 0) / critters.length;
    expect(avgSleep, `平均眠気 ${avgSleep.toFixed(1)}`).toBeLessThan(90);
  });

  test('同じseed・同じtick数なら結果が一致する（決定論）', () => {
    function fingerprint(): string {
      const sim = newIsland('ff-determinism', 40);
      fastForward(sim, TICKS_PER_ISLAND_HOUR * 6);
      return [...sim.world.actors.values()]
        .filter((a) => a.kind === 'critter')
        .sort((a, b) => a.id - b.id)
        .map((a) => `${a.id}:${a.needs.hunger.toFixed(2)}:${a.health.toFixed(1)}`)
        .join('|');
    }
    expect(fingerprint()).toBe(fingerprint());
  });

  test('早送り後に通常のstepへ戻れる', () => {
    const sim = newIsland('ff-resume');
    fastForward(sim, TICKS_PER_ISLAND_HOUR * 4);
    const tickAfterFf = sim.tick;
    expect(() => {
      for (let i = 0; i < 1000; i++) sim.step();
    }).not.toThrow();
    expect(sim.tick).toBe(tickAfterFf + 1000);
    // 早送り中に anim='sleep' で止めた個体が動き出す
    const moving = [...sim.world.actors.values()].filter((a) => a.kind === 'critter' && a.anim !== 'sleep');
    expect(moving.length).toBeGreaterThan(0);
  });

  test('24島時間の早送りが実用的な速さ（3秒以内）', () => {
    const sim = newIsland('ff-speed');
    const r = fastForward(sim, MAX_FASTFORWARD_TICKS);
    expect(r.elapsedMs, `${r.elapsedMs}ms かかりました`).toBeLessThan(3000);
  });

  test('結果を日本語1文で説明できる', () => {
    const sim = newIsland('ff-desc');
    const text = describeFastForward(fastForward(sim, TICKS_PER_ISLAND_HOUR * 3));
    expect(text).toContain('3島時間');
    expect(text).toContain('島の時間を進めました');
  });
});
