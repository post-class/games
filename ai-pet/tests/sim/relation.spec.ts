import { beforeEach, describe, expect, test } from 'vitest';
import { MAX_CRITTERS, RELATION, RESOURCE, Rng, TICKS_PER_ISLAND_DAY, type Actor } from '@ai-pet/shared';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { WorldClock } from '../../packages/server/src/sim/clock.ts';
import { EventBus } from '../../packages/server/src/sim/events.ts';
import { RelationSystem } from '../../packages/server/src/sim/relation.ts';
import { createCritterActor } from '../../packages/server/src/sim/actors.ts';

/** 中央付近だけ草地にした小さな世界 */
function newWorld(seed = 'rel'): IslandWorld {
  const world = new IslandWorld(new Rng(seed));
  for (let y = 50; y < 80; y++) {
    for (let x = 50; x < 80; x++) world.setTerrain(x, y, 'grass');
  }
  world.spawn = { x: 64.5, y: 64.5 };
  return world;
}

/**
 * 繁殖は「1個体あたりの食料」で出生率が変わるので、
 * 繁殖を検証するテストでは食料を十分に置いておく必要がある。
 */
function addFood(world: IslandWorld, nodes = 20): void {
  for (let i = 0; i < nodes; i++) {
    world.addResource({
      id: world.allocId(),
      type: 'berry_tree',
      pos: { x: 52 + (i % 10), y: 52 + Math.floor(i / 10) },
      amount: RESOURCE.berryTreeMax,
      max: RESOURCE.berryTreeMax,
      regenPerIslandHour: RESOURCE.berryRegenPerIslandHour,
    });
  }
}

interface Ctx {
  world: IslandWorld;
  clock: WorldClock;
  bus: EventBus;
  rel: RelationSystem;
  events: string[];
}

function newCtx(seed = 'rel'): Ctx {
  const world = newWorld(seed);
  const clock = new WorldClock(world.rng);
  const bus = new EventBus(clock);
  const events: string[] = [];
  bus.onFlush((list) => {
    for (const e of list) events.push(`${e.kind}:${e.text}`);
  });
  return { world, clock, bus, rel: new RelationSystem(world, clock, bus), events };
}

/** 交流中の2体を隣に置く */
function pairSocializing(ctx: Ctx, tick = 0): [Actor, Actor] {
  const a = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64, y: 64 }, ageDays: 20 });
  const b = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64.8, y: 64 }, ageDays: 20 });
  for (const x of [a, b]) x.action = { kind: 'socialize', startedAtTick: tick, durationTicks: 100 };
  return [a, b];
}

describe('好感度', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = newCtx();
  });

  test('初対面は0', () => {
    expect(ctx.rel.get(1, 2)).toBe(0);
  });

  test('順序に関係なく同じペアを指す', () => {
    ctx.rel.adjust(1, 2, 10);
    expect(ctx.rel.get(2, 1)).toBe(10);
  });

  test('-100..100 に収まる', () => {
    ctx.rel.adjust(1, 2, 999);
    expect(ctx.rel.get(1, 2)).toBe(100);
    ctx.rel.adjust(1, 2, -999);
    expect(ctx.rel.get(1, 2)).toBe(-100);
  });

  test('自分自身との関係は作らない', () => {
    ctx.rel.adjust(1, 1, 50);
    expect(ctx.rel.entries()).toHaveLength(0);
  });

  test('交流していると好感度が上がる', () => {
    const [a, b] = pairSocializing(ctx);
    for (let t = 0; t <= RELATION.updateEveryTicks * 10; t++) ctx.rel.update(t);
    expect(ctx.rel.get(a.id, b.id)).toBeGreaterThan(0);
  });

  test('寝ている個体とは交流しない', () => {
    const [a, b] = pairSocializing(ctx);
    b.anim = 'sleep';
    for (let t = 0; t <= RELATION.updateEveryTicks * 10; t++) ctx.rel.update(t);
    expect(ctx.rel.get(a.id, b.id)).toBe(0);
  });

  test('離れていると交流しない', () => {
    const [a, b] = pairSocializing(ctx);
    b.pos = { x: 70, y: 70 };
    for (let t = 0; t <= RELATION.updateEveryTicks * 10; t++) ctx.rel.update(t);
    expect(ctx.rel.get(a.id, b.id)).toBe(0);
  });

  test('仲良くなった瞬間だけ befriend イベントが出る', () => {
    const [a, b] = pairSocializing(ctx);
    ctx.rel.adjust(a.id, b.id, RELATION.befriendThreshold - 1);
    for (let t = 0; t <= RELATION.updateEveryTicks * 40; t++) {
      ctx.rel.update(t);
      ctx.bus.flush();
    }
    const befriends = ctx.events.filter((e) => e.startsWith('befriend:'));
    expect(befriends).toHaveLength(1);
    expect(befriends[0]).toContain('仲良くなった');
  });

  test('friendsOf は好感度の高い相手を返す', () => {
    ctx.rel.adjust(1, 2, 80);
    ctx.rel.adjust(1, 3, 90);
    ctx.rel.adjust(1, 4, 10);
    expect(ctx.rel.friendsOf(1)).toEqual([3, 2]);
  });

  test('保存・復元で好感度が戻る', () => {
    ctx.rel.adjust(5, 6, 42);
    const saved = ctx.rel.entries();

    const other = newCtx();
    other.rel.restore(saved);
    expect(other.rel.get(6, 5)).toBe(42);
  });
});

describe('資源の取り合い', () => {
  test('同じ資源を食べていると好感度が下がり、ケンカが起きる', () => {
    const ctx = newCtx('quarrel');
    const node = ctx.world.addResource({
      id: ctx.world.allocId(),
      type: 'berry_tree',
      pos: { x: 64.5, y: 64.5 },
      amount: 5,
      max: 6,
      regenPerIslandHour: 0.6,
    });
    const a = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64.2, y: 64.5 }, ageDays: 20 });
    const b = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64.8, y: 64.5 }, ageDays: 20 });
    for (const x of [a, b]) {
      x.action = { kind: 'eat', targetEntity: node.id, startedAtTick: 0, durationTicks: 1000 };
      x.needs.hunger = 90;
    }

    for (let t = 0; t <= RELATION.updateEveryTicks * 60; t++) {
      ctx.rel.update(t);
      ctx.bus.flush();
      // flee になったら食事に戻す（取り合いが続く状況を作る）
      for (const x of [a, b]) {
        if (x.action?.kind === 'flee') {
          x.action = { kind: 'eat', targetEntity: node.id, startedAtTick: t, durationTicks: 1000 };
        }
      }
    }

    expect(ctx.rel.get(a.id, b.id)).toBeLessThan(0);
    const quarrels = ctx.events.filter((e) => e.startsWith('quarrel:'));
    expect(quarrels.length).toBeGreaterThan(0);
    expect(quarrels[0]).toContain('木の実');
    expect(ctx.rel.stats().quarrels).toBe(quarrels.length);
  });

  test('違う資源を食べているならケンカしない', () => {
    const ctx = newCtx('noquarrel');
    const n1 = ctx.world.addResource({
      id: ctx.world.allocId(), type: 'berry_tree', pos: { x: 64.5, y: 64.5 }, amount: 5, max: 6, regenPerIslandHour: 0.6,
    });
    const n2 = ctx.world.addResource({
      id: ctx.world.allocId(), type: 'berry_tree', pos: { x: 65.5, y: 64.5 }, amount: 5, max: 6, regenPerIslandHour: 0.6,
    });
    const a = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64.4, y: 64.5 }, ageDays: 20 });
    const b = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64.9, y: 64.5 }, ageDays: 20 });
    a.action = { kind: 'eat', targetEntity: n1.id, startedAtTick: 0, durationTicks: 1000 };
    b.action = { kind: 'eat', targetEntity: n2.id, startedAtTick: 0, durationTicks: 1000 };

    for (let t = 0; t <= RELATION.updateEveryTicks * 40; t++) {
      ctx.rel.update(t);
      ctx.bus.flush();
    }
    expect(ctx.events.filter((e) => e.startsWith('quarrel:'))).toHaveLength(0);
  });
});

describe('世代交代', () => {
  test('島日が変わると年齢が増える', () => {
    const ctx = newCtx();
    const a = createCritterActor(ctx.world, { species: 'cat', pos: { x: 64, y: 64 }, ageDays: 3 });
    ctx.clock.restore({ islandDay: 2, season: 'spring', weather: 'clear' });
    ctx.rel.update(TICKS_PER_ISLAND_DAY);
    expect(a.ageDays).toBe(4);
  });

  test('仲の良い成体ペアから子が生まれ、性格が親に似る', () => {
    const ctx = newCtx('breed');
    addFood(ctx.world);
    const a = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64, y: 64 }, ageDays: 20 });
    const b = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64.5, y: 64 }, ageDays: 20 });
    a.traits.gluttony = 0.9;
    b.traits.gluttony = 0.9;
    ctx.rel.adjust(a.id, b.id, 90);

    // 春（出生率1.8）で何島日か回す
    for (let day = 0; day < 6; day++) ctx.rel.onIslandDay(day * TICKS_PER_ISLAND_DAY);
    ctx.bus.flush();

    expect(ctx.rel.stats().births).toBeGreaterThan(0);
    const born = ctx.events.filter((e) => e.startsWith('born:'));
    expect(born.length).toBeGreaterThan(0);

    // 生まれた後の島日で年齢が増えるので、IDが最大のもの（最後に生まれた個体）を見る
    const child = [...ctx.world.actors.values()]
      .filter((x) => x.id !== a.id && x.id !== b.id)
      .sort((p, q) => q.id - p.id)[0];
    expect(child).toBeDefined();
    expect(child?.species).toBe('rabbit');
    // 親の平均±0.1のノイズ
    expect(child?.traits.gluttony).toBeGreaterThan(0.7);
    // 親子は最初から仲が良い
    expect(ctx.rel.get(a.id, child!.id)).toBeGreaterThan(0);
  });

  test('好感度が低いペアからは生まれない', () => {
    const ctx = newCtx('nobreed');
    const a = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64, y: 64 }, ageDays: 20 });
    const b = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64.5, y: 64 }, ageDays: 20 });
    ctx.rel.adjust(a.id, b.id, 10);
    for (let day = 0; day < 10; day++) ctx.rel.onIslandDay(day * TICKS_PER_ISLAND_DAY);
    expect(ctx.rel.stats().births).toBe(0);
  });

  test('子ども個体（未成体）は繁殖しない', () => {
    const ctx = newCtx('child');
    const a = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64, y: 64 }, ageDays: 1 });
    const b = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64.5, y: 64 }, ageDays: 1 });
    ctx.rel.adjust(a.id, b.id, 95);
    for (let day = 0; day < 5; day++) ctx.rel.onIslandDay(day * TICKS_PER_ISLAND_DAY);
    expect(ctx.rel.stats().births).toBe(0);
  });

  test('種が違うペアからは生まれない', () => {
    const ctx = newCtx('species');
    const a = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 64, y: 64 }, ageDays: 20 });
    const b = createCritterActor(ctx.world, { species: 'cat', pos: { x: 64.5, y: 64 }, ageDays: 20 });
    ctx.rel.adjust(a.id, b.id, 95);
    for (let day = 0; day < 10; day++) ctx.rel.onIslandDay(day * TICKS_PER_ISLAND_DAY);
    expect(ctx.rel.stats().births).toBe(0);
  });

  test('冬は出生率が下がる（春より生まれにくい）', () => {
    function birthsIn(season: 'spring' | 'winter'): number {
      const ctx = newCtx('season-' + season);
      addFood(ctx.world);
      ctx.clock.restore({ islandDay: 1, season, weather: 'clear' });
      for (let i = 0; i < 10; i++) {
        const a = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 60 + i, y: 64 }, ageDays: 20 });
        const b = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 60 + i, y: 65 }, ageDays: 20 });
        ctx.rel.adjust(a.id, b.id, 90);
      }
      for (let day = 0; day < 5; day++) ctx.rel.onIslandDay(day * TICKS_PER_ISLAND_DAY);
      return ctx.rel.stats().births;
    }
    expect(birthsIn('winter')).toBeLessThan(birthsIn('spring'));
  });

  test('個体数の上限を超えて増えない', () => {
    const ctx = newCtx('cap');
    addFood(ctx.world, 200);
    for (let i = 0; i < MAX_CRITTERS; i++) {
      createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 55 + (i % 20), y: 55 + Math.floor(i / 20) }, ageDays: 20 });
    }
    const ids = [...ctx.world.actors.keys()];
    for (let i = 0; i + 1 < ids.length; i += 2) ctx.rel.adjust(ids[i]!, ids[i + 1]!, 90);

    ctx.rel.onIslandDay(TICKS_PER_ISLAND_DAY);
    expect(ctx.world.countActors('critter')).toBeLessThanOrEqual(MAX_CRITTERS);
  });

  test('寿命を超えた個体は退場し、died イベントが出る', () => {
    const ctx = newCtx();
    const a = createCritterActor(ctx.world, { species: 'bird', pos: { x: 64, y: 64 }, ageDays: 20 });
    // 島日が変わると21歳になり、寿命20を超えるので退場する
    a.lifespanDays = 20;
    ctx.rel.onIslandDay(TICKS_PER_ISLAND_DAY);
    ctx.bus.flush();

    expect(ctx.world.actor(a.id)).toBeUndefined();
    const died = ctx.events.filter((e) => e.startsWith('died:'));
    expect(died).toHaveLength(1);
    expect(died[0]).toContain('年をとって');
    expect(ctx.rel.stats().deaths).toBe(1);
  });

  test('健康が尽きた個体は「弱って」退場する', () => {
    const ctx = newCtx();
    const a = createCritterActor(ctx.world, { species: 'boar', pos: { x: 64, y: 64 }, ageDays: 5 });
    a.health = 0;
    ctx.rel.onIslandDay(TICKS_PER_ISLAND_DAY);
    ctx.bus.flush();
    expect(ctx.world.actor(a.id)).toBeUndefined();
    expect(ctx.events.filter((e) => e.includes('弱って'))).toHaveLength(1);
  });

  test('退場した個体の関係は消える', () => {
    const ctx = newCtx();
    const a = createCritterActor(ctx.world, { species: 'bird', pos: { x: 64, y: 64 }, ageDays: 20 });
    const b = createCritterActor(ctx.world, { species: 'bird', pos: { x: 65, y: 64 }, ageDays: 20 });
    // 繁殖のしきい値（45）を超えない値にする。超えると子が生まれて関係が増える
    ctx.rel.adjust(a.id, b.id, 30);
    a.lifespanDays = 20;
    ctx.rel.onIslandDay(TICKS_PER_ISLAND_DAY);
    expect(ctx.rel.get(a.id, b.id)).toBe(0);
    // 退場した個体を含むペアが1つも残っていないこと
    expect(ctx.rel.entries().filter((e) => e.a === a.id || e.b === a.id)).toHaveLength(0);
  });

  test('1個体あたりの関係数に上限がある', () => {
    const ctx = newCtx();
    const me = createCritterActor(ctx.world, { species: 'cat', pos: { x: 64, y: 64 }, ageDays: 20 });
    for (let i = 0; i < RELATION.maxRelationsPerActor + 15; i++) {
      ctx.rel.adjust(me.id, 10_000 + i, i % 2 === 0 ? 5 : -5);
    }
    ctx.rel.onIslandDay(TICKS_PER_ISLAND_DAY);
    const mine = ctx.rel.entries().filter((e) => e.a === me.id || e.b === me.id);
    expect(mine.length).toBeLessThanOrEqual(RELATION.maxRelationsPerActor);
  });
});

describe('決定論', () => {
  test('同じseedなら同じ結果になる', () => {
    function run(): string {
      const ctx = newCtx('determinism');
      for (let i = 0; i < 6; i++) {
        const a = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 60 + i, y: 64 }, ageDays: 20 });
        const b = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 60 + i, y: 65 }, ageDays: 20 });
        ctx.rel.adjust(a.id, b.id, 90);
      }
      for (let day = 0; day < 4; day++) ctx.rel.onIslandDay(day * TICKS_PER_ISLAND_DAY);
      ctx.bus.flush();
      return ctx.events.join('|');
    }
    expect(run()).toBe(run());
  });
});
