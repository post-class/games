/**
 * 設置物の撤去（G-5）のテスト。
 *
 * 「置いたものが残っていく島」を壊さないため、撤去できるのは**自分が置いたものだけ**。
 * 島が置いたもの（家・風車・柵・噴水・井戸・天文台 = ISLAND_OWNER）は誰も撤去できない。
 */
import { describe, expect, it } from 'vitest';
import { Rng, parseClientMsg, type Placeable, type PlaceableType, type Vec2 } from '@ai-pet/shared';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { BUILD_TUNING, BuildSystem, ISLAND_OWNER, type BuildDeps } from '../../packages/server/src/sim/build.ts';

interface Harness {
  world: IslandWorld;
  build: BuildSystem;
  events: { text: string; importance?: number }[];
}

function harness(deps?: Partial<BuildDeps>): Harness {
  const world = new IslandWorld(new Rng('remove'));
  const events: { text: string; importance?: number }[] = [];
  const build = new BuildSystem(world, {
    emitEvent: (e) =>
      events.push({ text: e.text, ...(e.importance !== undefined ? { importance: e.importance } : {}) }),
    onTerrainChanged: () => {},
    nameOf: (id) => (id === 'p1' ? 'りょう' : id),
    ...deps,
  });
  return { world, build, events };
}

function place(h: Harness, x: number, y: number, playerId = 'p1', type: PlaceableType = 'bench'): Placeable {
  const r = h.build.place({
    playerId,
    type,
    pos: { x, y },
    playerPos: { x: x + 0.5, y: y + 0.5 },
    tick: 100,
  });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.reason);
  return r.placeable;
}

/** 島が置いたもの（worldgen / 建設の完成物と同じ形） */
function islandOwned(h: Harness, x: number, y: number, type: PlaceableType = 'fountain'): Placeable {
  const p: Placeable = {
    id: h.world.allocId(),
    type,
    pos: { x: x + 0.5, y: y + 0.5 },
    ownerId: ISLAND_OWNER,
    attract: 0,
  };
  h.world.addPlaceable(p);
  return p;
}

const at = (p: Placeable): Vec2 => ({ x: p.pos.x, y: p.pos.y });

describe('remove メッセージ', () => {
  it('id だけを受け取る（座標はサーバ権威の値を使う）', () => {
    const r = parseClientMsg({ t: 'remove', id: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.msg).toEqual({ t: 'remove', id: 42 });
  });

  it('id が無い・整数でないものは弾く', () => {
    expect(parseClientMsg({ t: 'remove' }).ok).toBe(false);
    expect(parseClientMsg({ t: 'remove', id: 1.5 }).ok).toBe(false);
    expect(parseClientMsg({ t: 'remove', id: 'x' }).ok).toBe(false);
  });
});

describe('BuildSystem.removeByPlayer', () => {
  it('自分が置いたものは撤去できる', () => {
    const h = harness();
    const bench = place(h, 20, 20);
    const res = h.build.removeByPlayer({ playerId: 'p1', placeableId: bench.id, playerPos: at(bench) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.placeable.type).toBe('bench');
    expect(h.world.placeables.size).toBe(0);
    // 島の出来事として残る（他のプレイヤーやペットが「片付けた」を見聞きできる）
    expect(h.events.some((e) => e.text.includes('片付けた'))).toBe(true);
  });

  it('他人の設置物は撤去できない', () => {
    const h = harness();
    const bench = place(h, 20, 20, 'p1');
    const res = h.build.removeByPlayer({ playerId: 'p2', placeableId: bench.id, playerPos: at(bench) });
    expect(res).toEqual({ ok: false, reason: 'not_owner' });
    expect(h.world.placeables.size).toBe(1);
  });

  it('島が所有するもの（噴水・井戸・天文台など）は撤去できない', () => {
    const h = harness();
    for (const type of ['fountain', 'well', 'observatory', 'house_a', 'windmill', 'fence_h'] as PlaceableType[]) {
      const p = islandOwned(h, 30, 30, type);
      const res = h.build.removeByPlayer({ playerId: 'p1', placeableId: p.id, playerPos: at(p) });
      expect(res).toEqual({ ok: false, reason: 'not_owner' });
      expect(h.world.placeables.has(p.id)).toBe(true);
      h.world.placeables.delete(p.id);
    }
  });

  it('存在しないIDは not_found（例外にしない）', () => {
    const h = harness();
    expect(h.build.removeByPlayer({ playerId: 'p1', placeableId: 9999 })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('遠くのものは撤去できない（設置と同じ距離）', () => {
    const h = harness();
    const bench = place(h, 20, 20);
    const far: Vec2 = { x: 20.5 + BUILD_TUNING.placeRangeTiles + 1, y: 20.5 };
    expect(h.build.removeByPlayer({ playerId: 'p1', placeableId: bench.id, playerPos: far })).toEqual({
      ok: false,
      reason: 'out_of_range',
    });
    // 近づけば撤去できる
    expect(h.build.removeByPlayer({ playerId: 'p1', placeableId: bench.id, playerPos: at(bench) }).ok).toBe(true);
  });

  it('playerPos を渡さなければ距離を見ない（サーバ内部からの撤去）', () => {
    const h = harness();
    const bench = place(h, 20, 20);
    expect(h.build.removeByPlayer({ playerId: 'p1', placeableId: bench.id }).ok).toBe(true);
  });

  it('撤去すると持ち物の上限が空く（また置ける）', () => {
    const h = harness();
    const first = place(h, 20, 20);
    // 上限までの残りを埋める（間隔があるので3タイルおきに置く）
    for (let i = 1; i < BUILD_TUNING.maxPlaceablesPerPlayer; i++) place(h, 20 + i * 3, 20);
    const over = h.build.place({
      playerId: 'p1',
      type: 'bench',
      pos: { x: 20, y: 30 },
      playerPos: { x: 20.5, y: 30.5 },
      tick: 100,
    });
    expect(over).toEqual({ ok: false, reason: 'too_many' });

    expect(h.build.removeByPlayer({ playerId: 'p1', placeableId: first.id, playerPos: at(first) }).ok).toBe(true);
    const again = h.build.place({
      playerId: 'p1',
      type: 'bench',
      pos: { x: 20, y: 30 },
      playerPos: { x: 20.5, y: 30.5 },
      tick: 100,
    });
    expect(again.ok).toBe(true);
  });

  it('撤去の統計が残る', () => {
    const h = harness();
    const bench = place(h, 20, 20);
    h.build.removeByPlayer({ playerId: 'p2', placeableId: bench.id, playerPos: at(bench) });
    h.build.removeByPlayer({ playerId: 'p1', placeableId: bench.id, playerPos: at(bench) });
    const stats = h.build.stats();
    expect(stats['removed']).toBe(1);
    expect((stats['rejects'] as Record<string, number>)['not_owner']).toBe(1);
  });
});
