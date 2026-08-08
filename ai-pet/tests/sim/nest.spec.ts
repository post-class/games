/**
 * 巣（nest）の可視化と永続化のテスト（C-3）
 *
 * 守りたいこと:
 * 1. 巣は `Actor.nest` に持つので、スナップショットの保存→復元をまたいで場所が変わらない
 *    （以前は critter.ts の WeakMap 保持で、再起動すると全個体の寝床が消えていた。
 *     M3申し送り4 / M5申し送り6）
 * 2. 巣は `nest` 種別の設置物として画面に出る。**持ち主が死んだら消える**（無限に増えない）
 * 3. 同じ seed なら同じ配置になる（決定論。Math.random を使っていないこと）
 */
import { afterEach, describe, expect, it, test } from 'vitest';
import { Rng, type Actor, type Placeable, type Traits, type Vec2 } from '@ai-pet/shared';
import { Repo } from '../../packages/server/src/db/repo.ts';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { IslandSim } from '../../packages/server/src/sim/island.ts';
import { createCritterActor, createPetActor, sanitizeActorNest } from '../../packages/server/src/sim/actors.ts';
import { spawnInitialCritters } from '../../packages/server/src/sim/spawn.ts';
import { WorldClock } from '../../packages/server/src/sim/clock.ts';
import { NavService } from '../../packages/server/src/sim/nav.ts';
import { PLACE_ATTRACT } from '../../packages/server/src/sim/build.ts';
import {
  CritterAI,
  abandonNest,
  scoreCandidates,
  setNest,
  syncNestPlaceables,
  type Candidate,
  type CritterContext,
} from '../../packages/server/src/sim/critter.ts';
import { restoreIsland, saveIsland } from '../../packages/server/src/sim/persistence.ts';

// ---------- 足場 ----------

const c = (x: number, y: number): Vec2 => ({ x: x + 0.5, y: y + 0.5 });

const MID_TRAITS: Traits = { energy: 0.5, sociability: 0.5, caution: 0.5, gluttony: 0.5, curiosity: 0.5 };

function newWorld(): IslandWorld {
  return new IslandWorld(new Rng('nest-test'));
}

function newClock(): WorldClock {
  const clock = new WorldClock(new Rng('clock'));
  clock.weather = 'clear';
  clock.season = 'summer';
  return clock;
}

function addCritter(world: IslandWorld, pos: Vec2): Actor {
  const a = createCritterActor(world, { species: 'rabbit', pos, traits: MID_TRAITS });
  a.needs = { hunger: 0, sleep: 0, social: 0, safety: 0, curiosity: 0 };
  return a;
}

function nests(world: IslandWorld): Placeable[] {
  return [...world.placeables.values()].filter((p) => p.type === 'nest');
}

const repos: Repo[] = [];
function newRepo(): Repo {
  const r = new Repo(':memory:');
  repos.push(r);
  return r;
}
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});

// ---------- 巣づくり ----------

describe('巣の設置物', () => {
  it('巣を作ると nest の設置物が置かれ、寝床になる', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    setNest(w, a, c(20, 20), 100);

    expect(a.nest?.pos).toEqual(c(20, 20));
    expect(a.nest?.createdAtTick).toBe(100);
    const list = nests(w);
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(a.nest?.placeableId);
    expect(list[0]?.pos).toEqual(c(20, 20));
  });

  it('巣の attract は 0（餌の無い場所に群れが通って餓死するのを避ける）', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    setNest(w, a, c(20, 20), 0);
    expect(nests(w)[0]?.attract).toBe(0);
    expect(PLACE_ATTRACT.nest).toBe(0);

    // attract 0 の設置物は goto 候補に出ない
    const ctx: CritterContext = { tick: 0, clock: newClock(), isNight: false };
    const b = addCritter(w, c(21, 20));
    const goto = scoreCandidates(w, b, ctx).filter((x: Candidate) => x.kind === 'goto');
    expect(goto.length).toBe(0);
  });

  it('巣を作り直すと古い設置物は消える（1個体に1つだけ）', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    setNest(w, a, c(20, 20), 0);
    const first = a.nest?.placeableId as number;

    setNest(w, a, c(40, 40), 10);
    expect(nests(w).length).toBe(1);
    expect(w.placeables.has(first)).toBe(false);
    expect(a.nest?.pos).toEqual(c(40, 40));
  });

  it('同じタイルに作り直しても設置物のIDは増えない', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    setNest(w, a, c(20, 20), 0);
    const id = a.nest?.placeableId as number;
    setNest(w, a, c(20, 20), 40);
    expect(a.nest?.placeableId).toBe(id);
    expect(nests(w).length).toBe(1);
  });

  it('巣が重ならないよう空きタイルへずらす（同じ寝床を選んだ群れ）', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    const b = addCritter(w, c(20, 20));
    const d = addCritter(w, c(20, 20));
    setNest(w, a, c(20, 20), 0);
    setNest(w, b, c(20, 20), 0);
    setNest(w, d, c(20, 20), 0);

    const tiles = nests(w).map((p) => `${Math.floor(p.pos.x)},${Math.floor(p.pos.y)}`);
    expect(new Set(tiles).size).toBe(3);
  });

  it('歩けないタイルには巣を作らない', () => {
    const w = newWorld();
    for (let y = 18; y <= 22; y++) for (let x = 18; x <= 20; x++) w.setTerrain(x, y, 'water');
    const a = addCritter(w, c(25, 20));
    setNest(w, a, c(19, 20), 0);
    const p = nests(w)[0] as Placeable;
    expect(w.isWalkableTile(Math.floor(p.pos.x), Math.floor(p.pos.y))).toBe(true);
  });

  it('abandonNest で巣と設置物の両方が消える', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    setNest(w, a, c(20, 20), 0);
    abandonNest(w, a);
    expect(a.nest).toBeUndefined();
    expect(nests(w).length).toBe(0);
  });
});

// ---------- 掃除（無限に増えないこと） ----------

describe('syncNestPlaceables', () => {
  it('動物が死んだら巣の設置物も消える', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    const b = addCritter(w, c(30, 30));
    setNest(w, a, c(20, 20), 0);
    setNest(w, b, c(30, 30), 0);
    expect(nests(w).length).toBe(2);

    w.removeActor(a.id); // relation.ts の reap 相当
    const r = syncNestPlaceables(w);
    expect(r.removed).toBe(1);
    expect(nests(w).length).toBe(1);
    expect(nests(w)[0]?.id).toBe(b.nest?.placeableId);
  });

  it('設置物だけ消えていたら作り直す（自己修復）', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    setNest(w, a, c(20, 20), 0);
    w.placeables.delete(a.nest?.placeableId as number);

    const r = syncNestPlaceables(w);
    expect(r.added).toBe(1);
    expect(nests(w).length).toBe(1);
    expect(w.placeables.has(a.nest?.placeableId as number)).toBe(true);
    expect(nests(w)[0]?.pos).toEqual(c(20, 20));
  });

  it('CritterAI.update が定期的に掃除する（設置物が動物の数を超えない）', () => {
    const w = newWorld();
    const ai = new CritterAI(w, new NavService(w), newClock());
    const born: Actor[] = [];
    for (let i = 0; i < 6; i++) born.push(addCritter(w, c(20 + i * 4, 20)));
    for (const a of born) setNest(w, a, { x: a.pos.x, y: a.pos.y }, 0);
    expect(nests(w).length).toBe(6);

    // 半分を退場させる（巣は Actor 側に残ったまま消える）
    for (let i = 0; i < 3; i++) w.removeActor((born[i] as Actor).id);
    // nestSyncTicks（40）を必ず1回はまたぐ
    for (let t = 1; t <= 81; t++) ai.update(t);

    expect(nests(w).length).toBe(3);
    expect(nests(w).length).toBeLessThanOrEqual(w.countActors('critter'));
  });

  it('ペットは巣を持たない扱い（設置物を増やさない）', () => {
    const w = newWorld();
    const pet = createPetActor(w, { species: 'mofi', name: 'もふ', ownerId: 'p1', pos: c(20, 20) });
    // 手で壊れた状態を作る。sanitize と sync のどちらでも増えないこと
    pet.nest = { pos: c(20, 20), placeableId: 0, createdAtTick: 0 };
    expect(syncNestPlaceables(w)).toEqual({ added: 0, removed: 0 });
    expect(sanitizeActorNest(pet).nest).toBeUndefined();
  });
});

// ---------- 復元 ----------

describe('sanitizeActorNest', () => {
  it('座標が壊れた巣は捨てる（NaNの寝床で経路探索が毎tick失敗するのを防ぐ）', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    a.nest = { pos: { x: Number.NaN, y: 3 }, placeableId: 5, createdAtTick: 0 };
    expect(sanitizeActorNest(a).nest).toBeUndefined();
  });

  it('createdAtTick が欠けていても巣は残す（0で埋める）', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    a.nest = { pos: c(20, 20), placeableId: 0 } as Actor['nest'] as NonNullable<Actor['nest']>;
    expect(sanitizeActorNest(a).nest?.createdAtTick).toBe(0);
  });

  it('巣を持たない Actor は素通り', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    expect(sanitizeActorNest(a).nest).toBeUndefined();
  });
});

describe('再起動をまたぐ永続化', () => {
  test('保存→復元で巣の場所と設置物が変わらない', () => {
    const repo = newRepo();
    const a = new IslandSim({ islandId: 'main', seed: 'nest-persist' });
    spawnInitialCritters(a.world);
    // 島の動物のうち先頭3体に巣を持たせる（夜まで進めるより速く、狙った状態を作れる）
    const target: Actor[] = [];
    for (const actor of a.world.actors.values()) {
      if (actor.kind !== 'critter') continue;
      target.push(actor);
      if (target.length === 3) break;
    }
    for (const actor of target) setNest(a.world, actor, { x: actor.pos.x, y: actor.pos.y }, a.tick);
    const before = target.map((x) => ({ id: x.id, pos: { ...(x.nest as NonNullable<Actor['nest']>).pos } }));
    const beforeNests = nests(a.world)
      .map((p) => `${p.pos.x},${p.pos.y}`)
      .sort();
    expect(beforeNests.length).toBe(3);

    saveIsland(a, repo);

    const b = new IslandSim({ islandId: 'main', seed: 'nest-persist' });
    expect(restoreIsland(b, repo).restored).toBe(true);

    for (const rec of before) {
      const actor = b.world.actor(rec.id) as Actor;
      expect(actor.nest?.pos).toEqual(rec.pos);
      // 設置物も同じIDで残っている
      expect(b.world.placeables.get(actor.nest?.placeableId as number)?.type).toBe('nest');
    }
    expect(
      nests(b.world)
        .map((p) => `${p.pos.x},${p.pos.y}`)
        .sort(),
    ).toEqual(beforeNests);
  });

  test('設置物だけ欠けた古いセーブでも復元時に巣が画面に出る', () => {
    const repo = newRepo();
    const a = new IslandSim({ islandId: 'main', seed: 'nest-legacy' });
    spawnInitialCritters(a.world);
    let one: Actor | null = null;
    for (const actor of a.world.actors.values()) {
      if (actor.kind === 'critter') {
        one = actor;
        break;
      }
    }
    const actor = one as Actor;
    setNest(a.world, actor, { x: actor.pos.x, y: actor.pos.y }, a.tick);
    // C-3 より前のDBを模す: Actor.nest はあるが nest の設置物が保存されていない
    a.world.placeables.delete(actor.nest?.placeableId as number);
    saveIsland(a, repo);

    const b = new IslandSim({ islandId: 'main', seed: 'nest-legacy' });
    restoreIsland(b, repo);
    const restored = b.world.actor(actor.id) as Actor;
    expect(nests(b.world).length).toBe(1);
    expect(b.world.placeables.get(restored.nest?.placeableId as number)?.pos).toEqual(restored.nest?.pos);
  });

  test('同じseedなら巣の配置も一致する（決定論）', () => {
    const run = (): string[] => {
      const sim = new IslandSim({ islandId: 'main', seed: 'nest-determinism' });
      spawnInitialCritters(sim.world);
      const ai = new CritterAI(sim.world, new NavService(sim.world), sim.clock);
      const list: Actor[] = [];
      for (const actor of sim.world.actors.values()) {
        if (actor.kind !== 'critter') continue;
        list.push(actor);
        if (list.length === 8) break;
      }
      for (const actor of list) setNest(sim.world, actor, { x: actor.pos.x, y: actor.pos.y }, sim.tick);
      for (let t = 1; t <= 81; t++) ai.update(t);
      return nests(sim.world)
        .map((p) => `${p.type}@${p.pos.x},${p.pos.y}`)
        .sort();
    };
    const first = run();
    expect(first.length).toBeGreaterThan(0);
    expect(run()).toEqual(first);
  });
});
