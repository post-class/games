/**
 * 生態シミュレーションの不変条件（docs/02_ゲーム実装プラン/10_テストと品質.md §2）
 *
 * このゲームは「島が自分で回る」ことに賭けているので、
 * 「長く回しても破綻しない」を機械的に検証できることが品質の土台になる。
 *
 * CIで回すのは3島日ぶん（約4.3万tick）。長時間版は `npm run sim:long` で手動実行する。
 */
import { describe, expect, test } from 'vitest';
import {
  MAX_CRITTERS,
  MIN_CRITTERS,
  TICKS_PER_ISLAND_DAY,
  TICKS_PER_ISLAND_HOUR,
  type Actor,
} from '@ai-pet/shared';
import { IslandSim } from '../../packages/server/src/sim/island.ts';
import { spawnInitialCritters } from '../../packages/server/src/sim/spawn.ts';

interface Sample {
  tick: number;
  islandDay: number;
  season: string;
  critters: number;
  resourceTotal: number;
  decayedRatio: number;
  sleepingRatio: number;
  isNight: boolean;
}

function newIsland(seed: string, critters?: number): IslandSim {
  const sim = new IslandSim({ islandId: 'main', seed });
  spawnInitialCritters(sim.world, critters);
  return sim;
}

function critterList(sim: IslandSim): Actor[] {
  const out: Actor[] = [];
  for (const a of sim.world.actors.values()) if (a.kind === 'critter') out.push(a);
  return out;
}

/** 指定tickぶん回しながら1島時間ごとに標本を取る */
function run(sim: IslandSim, ticks: number): { samples: Sample[]; maxTickMs: number } {
  const samples: Sample[] = [];
  let maxTickMs = 0;
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    sim.step();
    const dt = performance.now() - t0;
    if (dt > maxTickMs) maxTickMs = dt;

    if (sim.tick % TICKS_PER_ISLAND_HOUR === 0) {
      const critters = critterList(sim);
      const sleeping = critters.filter((a) => a.anim === 'sleep').length;
      samples.push({
        tick: sim.tick,
        islandDay: sim.clock.islandDay,
        season: sim.clock.season,
        critters: critters.length,
        resourceTotal: sim.world.totalResourceAmount(),
        decayedRatio: sim.world.decayedTileRatio(),
        sleepingRatio: critters.length === 0 ? 0 : sleeping / critters.length,
        isNight: sim.clock.isNight(sim.tick),
      });
    }
  }
  return { samples, maxTickMs };
}

/**
 * 「行き先があるのに動けていない」個体を探す（経路探索や移動のバグの兆候）。
 * その場で寝る・食べる・雨宿りする個体は動かないのが正しいので除外する。
 */
function stuckActors(sim: IslandSim, before: Map<number, string>): Actor[] {
  const out: Actor[] = [];
  for (const a of critterList(sim)) {
    const key = `${a.pos.x.toFixed(2)},${a.pos.y.toFixed(2)}`;
    if (before.get(a.id) !== key) continue;
    if (a.anim === 'sleep') continue;

    const hasPath = (a.path?.length ?? 0) > 0;
    const target = a.action?.targetTile;
    const farFromTarget = target !== undefined && Math.hypot(a.pos.x - target.x, a.pos.y - target.y) > 1.5;
    if (hasPath || farFromTarget) out.push(a);
  }
  return out;
}

function posMap(sim: IslandSim): Map<number, string> {
  const m = new Map<number, string>();
  for (const a of critterList(sim)) m.set(a.id, `${a.pos.x.toFixed(2)},${a.pos.y.toFixed(2)}`);
  return m;
}

describe('島を3島日回しても破綻しない', () => {
  const sim = newIsland('invariants-1');
  const startCritters = critterList(sim).length;
  const { samples, maxTickMs } = run(sim, TICKS_PER_ISLAND_DAY * 3);

  test('動物が絶滅しない', () => {
    expect(startCritters).toBeGreaterThan(MIN_CRITTERS);
    for (const s of samples) {
      expect(s.critters, `${s.islandDay}日目に個体数が ${s.critters}`).toBeGreaterThanOrEqual(MIN_CRITTERS);
    }
  });

  test('動物が増えすぎない', () => {
    for (const s of samples) {
      expect(s.critters, `${s.islandDay}日目に個体数が ${s.critters}`).toBeLessThanOrEqual(MAX_CRITTERS);
    }
  });

  test('食料が枯れ切らない', () => {
    for (const s of samples) {
      expect(s.resourceTotal, `tick=${s.tick} で資源総量が ${s.resourceTotal}`).toBeGreaterThan(0);
    }
  });

  test('島が砂漠化しない（荒廃タイル率 < 50%）', () => {
    for (const s of samples) {
      expect(s.decayedRatio, `tick=${s.tick} で荒廃率 ${s.decayedRatio}`).toBeLessThan(0.5);
    }
  });

  test('夜はちゃんと寝る（夜間の睡眠率 > 60%）', () => {
    const nights = samples.filter((s) => s.isNight);
    expect(nights.length).toBeGreaterThan(0);
    const avg = nights.reduce((sum, s) => sum + s.sleepingRatio, 0) / nights.length;
    expect(avg, `夜間の平均睡眠率 ${avg.toFixed(2)}`).toBeGreaterThan(0.6);
  });

  test('昼は起きている（昼間の睡眠率 < 40%）', () => {
    const days = samples.filter((s) => !s.isNight);
    const avg = days.reduce((sum, s) => sum + s.sleepingRatio, 0) / days.length;
    expect(avg, `昼間の平均睡眠率 ${avg.toFixed(2)}`).toBeLessThan(0.4);
  });

  test('座標が壊れない（NaN・マップ外が無い）', () => {
    for (const a of critterList(sim)) {
      expect(Number.isFinite(a.pos.x) && Number.isFinite(a.pos.y), `#${a.id} の座標が壊れています`).toBe(true);
      expect(a.pos.x).toBeGreaterThanOrEqual(0);
      expect(a.pos.y).toBeGreaterThanOrEqual(0);
      expect(a.pos.x).toBeLessThan(128);
      expect(a.pos.y).toBeLessThan(128);
    }
  });

  test('動物が水の上に立っていない', () => {
    for (const a of critterList(sim)) {
      const t = sim.world.terrainAt(Math.floor(a.pos.x), Math.floor(a.pos.y));
      expect(t, `#${a.id} が ${t} の上にいます`).not.toBe('water');
    }
  });

  test('欲求と健康が範囲内', () => {
    for (const a of critterList(sim)) {
      for (const [k, v] of Object.entries(a.needs)) {
        expect(Number.isFinite(v), `#${a.id} の ${k} が ${v}`).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
      expect(a.health).toBeGreaterThanOrEqual(0);
      expect(a.health).toBeLessThanOrEqual(100);
    }
  });

  test('tick処理時間が予算内（p95 < 40ms）', () => {
    const m = sim.metrics();
    expect(m.tickMsP95, `p95=${m.tickMsP95}ms p50=${m.tickMsP50}ms 最悪=${maxTickMs.toFixed(1)}ms`).toBeLessThan(40);
    expect(m.tickOverrun).toBe(0);
  });

  test('経路探索のキューが詰まっていない', () => {
    expect(sim.nav.pending()).toBeLessThan(50);
  });

  test('島の出来事が記録されている（誕生・ケンカ・天気など）', () => {
    const stats = sim.events.stats();
    expect(stats.total).toBeGreaterThan(0);
    // 3島日あれば天気の変化は必ず起きる
    expect(stats.byKind['weather'] ?? 0).toBeGreaterThan(0);
  });

  test('関係性が生まれている（仲良し or 苦手が発生する）', () => {
    const rel = sim.relations.stats();
    expect(rel.pairs, '誰とも関係が生まれていません').toBeGreaterThan(0);
  });

  test('長時間動かない個体がいない', () => {
    const before = posMap(sim);
    run(sim, TICKS_PER_ISLAND_HOUR); // 1島時間ぶん追加で回す
    const stuck = stuckActors(sim, before);
    expect(stuck.map((a) => `#${a.id}(${a.action?.kind ?? 'none'})`)).toEqual([]);
  });
});

describe('別のseedでも破綻しない', () => {
  test.each(['invariants-2', 'invariants-3'])('%s で1島日回して不変条件を満たす', (seed) => {
    const sim = newIsland(seed);
    const { samples } = run(sim, TICKS_PER_ISLAND_DAY);
    for (const s of samples) {
      expect(s.critters).toBeGreaterThanOrEqual(MIN_CRITTERS);
      expect(s.critters).toBeLessThanOrEqual(MAX_CRITTERS);
      expect(s.resourceTotal).toBeGreaterThan(0);
      expect(s.decayedRatio).toBeLessThan(0.5);
    }
    const nights = samples.filter((s) => s.isNight);
    const avg = nights.reduce((sum, s) => sum + s.sleepingRatio, 0) / Math.max(1, nights.length);
    expect(avg, `夜間睡眠率 ${avg.toFixed(2)}`).toBeGreaterThan(0.6);
  });
});

describe('決定論', () => {
  test('同じseedなら3000tick後の状態が完全に一致する', () => {
    function fingerprint(seed: string): string {
      const sim = newIsland(seed, 40);
      for (let i = 0; i < 3000; i++) sim.step();
      return critterList(sim)
        .sort((a, b) => a.id - b.id)
        .map((a) => `${a.id}:${a.pos.x.toFixed(3)},${a.pos.y.toFixed(3)},${a.anim},${a.needs.hunger.toFixed(2)}`)
        .join('|');
    }
    expect(fingerprint('determinism-x')).toBe(fingerprint('determinism-x'));
  });
});
