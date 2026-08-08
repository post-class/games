/**
 * 設置物が動物を引き寄せることの検証（docs 09章 M7 の完了条件
 * 「ベンチを置くと動物が集まるようになる（ログで行動選択の変化が見える）」）。
 *
 * 実時間では確認しづらい（動物の再判断は2秒ごと・移動に時間がかかる）ので、
 * シミュレーションを直接回して「ベンチのそばに居る個体数」の変化を見る。
 */
import { describe, expect, test } from 'vitest';
import { TICKS_PER_ISLAND_HOUR, type Actor, type Vec2 } from '@ai-pet/shared';
import { IslandSim } from '../../packages/server/src/sim/island.ts';
import { createCritterActor } from '../../packages/server/src/sim/actors.ts';
import { scoreCandidates } from '../../packages/server/src/sim/critter.ts';

const SEED = 'attract-test';

/** 広場のまわりに動物を並べた島を作る */
function newIsland(): { sim: IslandSim; center: Vec2; critters: Actor[] } {
  const sim = new IslandSim({ islandId: 'main', seed: SEED });
  const center = { x: sim.world.spawn.x, y: sim.world.spawn.y };

  // 広場から少し離れた位置に、歩ける場所を選んで20体置く
  const critters: Actor[] = [];
  let placed = 0;
  for (let r = 6; r <= 14 && placed < 20; r++) {
    for (let a = 0; a < 12 && placed < 20; a++) {
      const angle = (a / 12) * Math.PI * 2;
      const pos = { x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r };
      if (!sim.world.canStandAt(pos)) continue;
      critters.push(createCritterActor(sim.world, { species: 'rabbit', pos, ageDays: 12 }));
      placed++;
    }
  }
  return { sim, center, critters };
}

function countNear(critters: readonly Actor[], pos: Vec2, radius: number): number {
  return critters.filter((c) => Math.hypot(c.pos.x - pos.x, c.pos.y - pos.y) <= radius).length;
}

describe('設置物が動物を引き寄せる', () => {
  test('ベンチのそばに集まる個体が増える', () => {
    const withBench = newIsland();
    const spot = { x: Math.floor(withBench.center.x), y: Math.floor(withBench.center.y) };

    const placed = withBench.sim.build.place({
      playerId: 'p1',
      type: 'bench',
      pos: spot,
      playerPos: { x: spot.x + 0.5, y: spot.y + 0.5 },
      tick: 1,
    });
    expect(placed.ok, `ベンチが置けなかった: ${placed.ok ? '' : placed.reason}`).toBe(true);

    const before = countNear(withBench.critters, spot, 5);
    for (let i = 0; i < TICKS_PER_ISLAND_HOUR * 2; i++) withBench.sim.step();
    const after = countNear(withBench.critters, spot, 5);

    // 何もしない島（対照）と比べる
    const control = newIsland();
    for (let i = 0; i < TICKS_PER_ISLAND_HOUR * 2; i++) control.sim.step();
    const controlAfter = countNear(control.critters, spot, 5);

    expect(after, `ベンチあり ${before} → ${after} / 対照 ${controlAfter}`).toBeGreaterThan(controlAfter);
  });

  test('ベンチは基準（attractRef=5）より強く引き寄せる', () => {
    const { sim, center } = newIsland();
    const spot = { x: Math.floor(center.x), y: Math.floor(center.y) };
    sim.build.place({
      playerId: 'p1',
      type: 'bench',
      pos: spot,
      playerPos: { x: spot.x + 0.5, y: spot.y + 0.5 },
      tick: 1,
    });
    // 島の生成時に噴水などが置かれている（C-1 / C-2）ので、種別で探す
    const bench = [...sim.world.placeables.values()].find((p) => p.type === 'bench');
    expect(bench).toBeDefined();
    expect(bench?.attract, 'ベンチのattractは基準5を超えていること').toBeGreaterThan(5);
  });

  test('設置物があると goto の候補が出る（行動選択の変化）', () => {
    const { sim, center, critters } = newIsland();
    const spot = { x: Math.floor(center.x), y: Math.floor(center.y) };
    const actor = critters[0] as Actor;
    // 判断に効かせるため、他の欲求は落ち着かせておく
    actor.needs = { hunger: 10, sleep: 10, social: 10, safety: 0, curiosity: 40 };

    const ctx = { tick: 100, clock: sim.clock, isNight: false };
    const before = scoreCandidates(sim.world, actor, ctx).filter((c) => c.kind === 'goto');

    sim.build.place({
      playerId: 'p1',
      type: 'bench',
      pos: spot,
      playerPos: { x: spot.x + 0.5, y: spot.y + 0.5 },
      tick: 1,
    });

    const after = scoreCandidates(sim.world, actor, ctx).filter((c) => c.kind === 'goto');
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.some((c) => (c.why ?? '').includes('placeable'))).toBe(true);
  });

  test('複数の設置物があっても行動が壊れない（1島時間回して例外が出ない）', () => {
    const { sim, center, critters } = newIsland();
    const base = { x: Math.floor(center.x), y: Math.floor(center.y) };
    const types = ['bench', 'flowerbed', 'lantern', 'signboard'] as const;
    let placed = 0;
    for (let i = 0; i < 8 && placed < 4; i++) {
      const pos = { x: base.x + i * 2, y: base.y };
      const r = sim.build.place({
        playerId: 'p1',
        type: types[placed % types.length] as (typeof types)[number],
        pos,
        playerPos: { x: pos.x + 0.5, y: pos.y + 0.5 },
        tick: 1,
      });
      if (r.ok) placed++;
    }
    expect(placed).toBeGreaterThan(0);

    expect(() => {
      for (let i = 0; i < TICKS_PER_ISLAND_HOUR; i++) sim.step();
    }).not.toThrow();
    for (const c of critters) {
      expect(Number.isFinite(c.pos.x)).toBe(true);
      expect(sim.world.canStandAt(c.pos)).toBe(true);
    }
  });
});
