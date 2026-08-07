/**
 * build.ts（設置物と共同建設）のテスト
 *
 * 設置物の判定は手で書いた地形（既定は全面 grass）で確認する。
 * 建設予定地は「水をまたぐ位置」を探す必要があるので generateIsland を使う。
 */
import { describe, expect, it } from 'vitest';
import { Rng, type Construction, type PlaceableType, type Vec2 } from '@ai-pet/shared';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { generateIsland } from '../../packages/server/src/sim/worldgen.ts';
import { CRITTER_WEIGHTS } from '../../packages/server/src/sim/critter.ts';
import { BUILD_TUNING, BuildSystem, type BuildDeps } from '../../packages/server/src/sim/build.ts';

interface Harness {
  world: IslandWorld;
  build: BuildSystem;
  events: { text: string; importance?: number }[];
  terrainChanges: Vec2[][];
}

function harness(world: IslandWorld, deps?: Partial<BuildDeps>): Harness {
  const events: { text: string; importance?: number }[] = [];
  const terrainChanges: Vec2[][] = [];
  const build = new BuildSystem(world, {
    emitEvent: (e) => events.push({ text: e.text, ...(e.importance !== undefined ? { importance: e.importance } : {}) }),
    onTerrainChanged: (tiles) => terrainChanges.push(tiles),
    nameOf: (id) => (id === 'p1' ? 'りょう' : id),
    ...deps,
  });
  return { world, build, events, terrainChanges };
}

/** 全面 grass の島（worldgen に依存しない） */
function flatWorld(seed = 'build'): IslandWorld {
  return new IslandWorld(new Rng(seed));
}

function place(h: Harness, type: PlaceableType, x: number, y: number, playerPos?: Vec2, playerId = 'p1') {
  return h.build.place({
    playerId,
    type,
    pos: { x, y },
    playerPos: playerPos ?? { x: x + 0.5, y: y + 0.5 },
    tick: 100,
  });
}

/** 橋の予定地ができる島を探す（見つかった seed 群のうち先頭を使う） */
function islandWithBridge(): { seed: string; world: IslandWorld; h: Harness; bridge: Construction } {
  for (const seed of ['main', 't', 'poko', 'winter-check']) {
    const world = generateIsland(seed);
    const h = harness(world);
    const bridge = h.build.seedConstructions().find((c) => c.type === 'bridge');
    if (bridge) return { seed, world, h, bridge };
  }
  throw new Error('橋の予定地を持つ seed が見つからない（BRIDGE_MIN_DETOUR を確認）');
}

/** 完成まで貢献する（クールダウンを避けるため十分にtickを進める） */
function contributeUntilDone(h: Harness, id: number, pos: Vec2, playerId = 'p1'): number {
  let tick = 0;
  let completedAt = -1;
  for (let i = 0; i < 40; i++) {
    tick += BUILD_TUNING.contributeCooldownTicks;
    const r = h.build.contribute({ playerId, constructionId: id, playerPos: pos, tick });
    if (r.ok && r.completed) {
      completedAt = tick;
      break;
    }
  }
  return completedAt;
}

describe('設置物', () => {
  it('歩ける場所に置ける', () => {
    const h = harness(flatWorld());
    const r = place(h, 'bench', 20, 20);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 位置はタイル中心に丸められる
    expect(r.placeable.pos).toEqual({ x: 20.5, y: 20.5 });
    expect(r.placeable.ownerId).toBe('p1');
    expect(h.world.placeables.size).toBe(1);
  });

  it('置いたら build イベントが出る', () => {
    const h = harness(flatWorld());
    place(h, 'bench', 20, 20);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.text).toBe('りょうがベンチを置いた');
  });

  it('水の上には置けない', () => {
    const h = harness(flatWorld());
    h.world.setTerrain(30, 30, 'water');
    const r = place(h, 'flowerbed', 30, 30);
    expect(r).toEqual({ ok: false, reason: 'not_walkable' });
    expect(h.world.placeables.size).toBe(0);
  });

  it('同じタイルには置けない', () => {
    const h = harness(flatWorld());
    expect(place(h, 'bench', 20, 20).ok).toBe(true);
    expect(place(h, 'lantern', 20, 20)).toEqual({ ok: false, reason: 'occupied' });
  });

  it('近すぎる場所には置けない（隣のタイル）', () => {
    const h = harness(flatWorld());
    expect(place(h, 'bench', 20, 20).ok).toBe(true);
    expect(place(h, 'lantern', 21, 20)).toEqual({ ok: false, reason: 'too_close' });
    // 2タイル離れれば置ける
    expect(place(h, 'lantern', 22, 20).ok).toBe(true);
  });

  it('資源のあるタイルには置けない', () => {
    const h = harness(flatWorld());
    h.world.addResource({
      id: h.world.allocId(),
      type: 'berry_tree',
      pos: { x: 40.5, y: 40.5 },
      amount: 3,
      max: 6,
      regenPerIslandHour: 1,
    });
    expect(place(h, 'bench', 40, 40)).toEqual({ ok: false, reason: 'occupied' });
  });

  it('プレイヤーから3タイルより遠い場所には置けない', () => {
    const h = harness(flatWorld());
    // タイル中心 (30.5,20.5) までの距離が 3 以内なら置ける
    expect(place(h, 'bench', 30, 20, { x: 27.5, y: 20.5 }).ok).toBe(true);
    const far = place(h, 'bench', 40, 20, { x: 36.0, y: 20.5 });
    expect(far).toEqual({ ok: false, reason: 'out_of_range' });
  });

  it('1プレイヤー8個までしか置けない', () => {
    const h = harness(flatWorld());
    // 2タイル間隔の格子に置いていく（プレイヤーも一緒に動かす）
    let placed = 0;
    for (let i = 0; i < 12; i++) {
      const x = 10 + (i % 4) * 2;
      const y = 10 + Math.floor(i / 4) * 2;
      const r = place(h, 'lantern', x, y);
      if (r.ok) placed++;
      else expect(r.reason).toBe('too_many');
    }
    expect(placed).toBe(BUILD_TUNING.maxPlaceablesPerPlayer);
    expect(h.world.placeables.size).toBe(8);

    // 別のプレイヤーはまだ置ける
    const other = place(h, 'bench', 30, 30, undefined, 'p2');
    expect(other.ok).toBe(true);
  });

  it('未知の種別は弾く', () => {
    const h = harness(flatWorld());
    const r = place(h, 'statue' as PlaceableType, 20, 20);
    expect(r).toEqual({ ok: false, reason: 'unknown_type' });
  });

  it('撤去できるのは自分が置いたものだけ', () => {
    const h = harness(flatWorld());
    const r = place(h, 'bench', 20, 20);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(h.build.remove({ playerId: 'p2', placeableId: r.placeable.id })).toBe(false);
    expect(h.world.placeables.size).toBe(1);
    expect(h.build.remove({ playerId: 'p1', placeableId: r.placeable.id })).toBe(true);
    expect(h.world.placeables.size).toBe(0);
    // 存在しないIDでも例外にならない
    expect(h.build.remove({ playerId: 'p1', placeableId: 9999 })).toBe(false);
  });

  it('ベンチの attract は critter.ts の基準（attractRef）より高い', () => {
    const h = harness(flatWorld());
    const r = place(h, 'bench', 20, 20);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.placeable.attract).toBeGreaterThan(CRITTER_WEIGHTS.attractRef);
    // 花壇・ランタン・看板は基準以下（ベンチがいちばん集まる）
    expect(BUILD_TUNING.attract.flowerbed).toBeLessThan(BUILD_TUNING.attract.bench);
    expect(BUILD_TUNING.attract.lantern).toBeLessThan(BUILD_TUNING.attract.flowerbed);
    expect(BUILD_TUNING.attract.signboard).toBeLessThan(BUILD_TUNING.attract.lantern);
  });
});

describe('建設予定地', () => {
  it('同じseedなら同じ場所に置かれる', () => {
    const a = harness(generateIsland('main')).build.seedConstructions();
    const b = harness(generateIsland('main')).build.seedConstructions();
    expect(a.length).toBeGreaterThan(0);
    expect(b.map((c) => `${c.type}@${c.pos.x},${c.pos.y}`)).toEqual(a.map((c) => `${c.type}@${c.pos.x},${c.pos.y}`));
  });

  it('井戸は広場の近く、天文台は島の端寄りの歩ける場所', () => {
    const world = generateIsland('main');
    const h = harness(world);
    const cs = h.build.seedConstructions();
    const well = cs.find((c) => c.type === 'well');
    const obs = cs.find((c) => c.type === 'observatory');
    expect(well).toBeDefined();
    expect(obs).toBeDefined();
    if (!well || !obs) return;
    const dWell = Math.hypot(well.pos.x - world.spawn.x, well.pos.y - world.spawn.y);
    expect(dWell).toBeLessThanOrEqual(11);
    expect(world.isWalkableTile(Math.floor(well.pos.x), Math.floor(well.pos.y))).toBe(true);
    // 天文台は森ではない歩ける場所で、広場より島の端に近い
    expect(world.terrainAt(Math.floor(obs.pos.x), Math.floor(obs.pos.y))).not.toBe('forest');
    expect(world.isWalkableTile(Math.floor(obs.pos.x), Math.floor(obs.pos.y))).toBe(true);
    const dObs = Math.hypot(obs.pos.x - 64, obs.pos.y - 64);
    expect(dObs).toBeGreaterThan(dWell);
  });

  it('橋は水をまたぐ位置に置かれる', () => {
    const { world, bridge } = islandWithBridge();
    const bx = Math.floor(bridge.pos.x);
    const by = Math.floor(bridge.pos.y);
    expect(world.terrainAt(bx, by)).toBe('water');

    // どちらかの軸で「幅4以内の水の帯の両端が陸」になっている
    const spans = (['h', 'v'] as const).map((axis) => {
      const dx = axis === 'h' ? 1 : 0;
      const dy = axis === 'h' ? 0 : 1;
      let x0 = bx;
      let y0 = by;
      while (world.terrainAt(x0 - dx, y0 - dy) === 'water' && x0 > 1 && y0 > 1) {
        x0 -= dx;
        y0 -= dy;
      }
      let x1 = bx;
      let y1 = by;
      while (world.terrainAt(x1 + dx, y1 + dy) === 'water' && x1 < 126 && y1 < 126) {
        x1 += dx;
        y1 += dy;
      }
      const width = axis === 'h' ? x1 - x0 + 1 : y1 - y0 + 1;
      const bothLand = world.isWalkableTile(x0 - dx, y0 - dy) && world.isWalkableTile(x1 + dx, y1 + dy);
      return { width, bothLand };
    });
    expect(spans.some((s) => s.bothLand && s.width <= BUILD_TUNING.bridgeMaxSpan)).toBe(true);
  });

  it('橋の見つからない島でも例外にならない（水のない島）', () => {
    const h = harness(flatWorld());
    const cs = h.build.seedConstructions();
    expect(cs.some((c) => c.type === 'bridge')).toBe(false);
    // 井戸・天文台は置ける
    expect(cs.some((c) => c.type === 'well')).toBe(true);
  });

  it('二重に呼んでも予定地は増えない', () => {
    const h = harness(generateIsland('main'));
    const first = h.build.seedConstructions();
    const second = h.build.seedConstructions();
    expect(second).toHaveLength(first.length);
    expect(h.build.constructions()).toHaveLength(first.length);
  });
});

describe('貢献', () => {
  function wellHarness(): { h: Harness; well: Construction } {
    const h = harness(generateIsland('main'));
    const well = h.build.seedConstructions().find((c) => c.type === 'well') as Construction;
    return { h, well };
  }

  it('3タイル以内なら progress が +5 される', () => {
    const { h, well } = wellHarness();
    const r = h.build.contribute({ playerId: 'p1', constructionId: well.id, playerPos: well.pos, tick: 10 });
    expect(r).toMatchObject({ ok: true, progress: 5, completed: false });
  });

  it('遠いと too_far', () => {
    const { h, well } = wellHarness();
    const r = h.build.contribute({
      playerId: 'p1',
      constructionId: well.id,
      playerPos: { x: well.pos.x + 4, y: well.pos.y },
      tick: 10,
    });
    expect(r).toEqual({ ok: false, reason: 'too_far' });
    expect(well.progress).toBe(0);
  });

  it('存在しない建設物は not_found', () => {
    const { h } = wellHarness();
    const r = h.build.contribute({ playerId: 'p1', constructionId: 99999, playerPos: { x: 0, y: 0 }, tick: 1 });
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('クールダウン中は rate', () => {
    const { h, well } = wellHarness();
    expect(h.build.contribute({ playerId: 'p1', constructionId: well.id, playerPos: well.pos, tick: 10 }).ok).toBe(true);
    const again = h.build.contribute({ playerId: 'p1', constructionId: well.id, playerPos: well.pos, tick: 17 });
    expect(again).toEqual({ ok: false, reason: 'rate' });
    // 8tick 後なら通る
    const ok = h.build.contribute({ playerId: 'p1', constructionId: well.id, playerPos: well.pos, tick: 18 });
    expect(ok.ok).toBe(true);
    expect(well.progress).toBe(10);
    // 別プレイヤーのクールダウンは独立
    const other = h.build.contribute({ playerId: 'p2', constructionId: well.id, playerPos: well.pos, tick: 18 });
    expect(other.ok).toBe(true);
  });

  it('100に達すると completed になり、その後は already_done', () => {
    const { h, well } = wellHarness();
    const at = contributeUntilDone(h, well.id, well.pos);
    expect(at).toBeGreaterThan(0);
    expect(well.progress).toBe(100);
    expect(well.completedAtTick).toBe(at);
    const after = h.build.contribute({ playerId: 'p1', constructionId: well.id, playerPos: well.pos, tick: at + 100 });
    expect(after).toEqual({ ok: false, reason: 'already_done' });
    // 完成イベント（importance 8）
    expect(h.events.at(-1)).toEqual({ text: '井戸が完成した', importance: 8 });
  });

  it('貢献値がプレイヤーごとに記録される', () => {
    const { h, well } = wellHarness();
    h.build.contribute({ playerId: 'p1', constructionId: well.id, playerPos: well.pos, tick: 10 });
    h.build.contribute({ playerId: 'p2', constructionId: well.id, playerPos: well.pos, tick: 10 });
    h.build.contribute({ playerId: 'p2', constructionId: well.id, playerPos: well.pos, tick: 20 });
    expect(well.contributions).toEqual({ p1: 5, p2: 10 });
    expect(well.progress).toBe(15);
  });
});

describe('完成の効果', () => {
  it('橋が完成すると水タイルが歩けるようになり onTerrainChanged が呼ばれる', () => {
    const { world, h, bridge } = islandWithBridge();
    const bx = Math.floor(bridge.pos.x);
    const by = Math.floor(bridge.pos.y);
    expect(world.isWalkableTile(bx, by)).toBe(false);

    contributeUntilDone(h, bridge.id, bridge.pos);

    expect(h.terrainChanges).toHaveLength(1);
    const tiles = h.terrainChanges[0] as Vec2[];
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(BUILD_TUNING.bridgeMaxSpan);
    for (const t of tiles) {
      expect(Number.isInteger(t.x)).toBe(true);
      expect(world.terrainAt(t.x, t.y)).toBe('dirt');
      expect(world.isWalkableTile(t.x, t.y)).toBe(true);
    }
    expect(world.isWalkableTile(bx, by)).toBe(true);
    expect(h.events.at(-1)).toEqual({ text: '橋が完成した', importance: 8 });
  });

  it('井戸が完成すると水の資源が増える', () => {
    const h = harness(generateIsland('main'));
    const well = h.build.seedConstructions().find((c) => c.type === 'well') as Construction;
    const before = [...h.world.resources.values()].filter((r) => r.type === 'water').length;
    contributeUntilDone(h, well.id, well.pos);
    const after = [...h.world.resources.values()].filter((r) => r.type === 'water');
    expect(after.length).toBe(before + 1);
    const added = after.find((r) => r.pos.x === well.pos.x && r.pos.y === well.pos.y);
    expect(added).toBeDefined();
    expect(added?.amount).toBeGreaterThan(0);
    // 地形は変えない
    expect(h.terrainChanges).toHaveLength(0);
  });

  it('天文台が完成すると attract の高い設置物になる（地形は変えない）', () => {
    const h = harness(generateIsland('main'));
    const obs = h.build.seedConstructions().find((c) => c.type === 'observatory') as Construction;
    contributeUntilDone(h, obs.id, obs.pos);
    const near = h.world.placeablesNear(obs.pos, 1);
    expect(near).toHaveLength(1);
    expect(near[0]?.attract).toBeGreaterThan(BUILD_TUNING.attract.bench);
    // 島の所有物なのでプレイヤーは撤去できない
    expect(h.build.remove({ playerId: 'p1', placeableId: near[0]?.id as number })).toBe(false);
    expect(h.terrainChanges).toHaveLength(0);
  });
});

describe('復元', () => {
  it('進捗と貢献者が戻る', () => {
    const h = harness(generateIsland('main'));
    const cs = h.build.seedConstructions();
    const well = cs.find((c) => c.type === 'well') as Construction;
    h.build.contribute({ playerId: 'p1', constructionId: well.id, playerPos: well.pos, tick: 10 });
    h.build.contribute({ playerId: 'p2', constructionId: well.id, playerPos: well.pos, tick: 10 });
    const saved: Construction[] = JSON.parse(JSON.stringify(h.build.constructions()));

    // 再起動相当: 同じseedで島を作り直し、保存した建設物を流し込む
    const h2 = harness(generateIsland('main'));
    h2.build.restore(saved);
    const restored = h2.build.constructions().find((c) => c.id === well.id);
    expect(restored?.progress).toBe(10);
    expect(restored?.contributions).toEqual({ p1: 5, p2: 5 });
    expect(h2.build.constructions()).toHaveLength(cs.length);
  });

  it('完成済みの橋は地形を張り直す（terrain は永続化されない）', () => {
    const { seed, h, bridge } = islandWithBridge();
    contributeUntilDone(h, bridge.id, bridge.pos);
    const saved: Construction[] = JSON.parse(JSON.stringify(h.build.constructions()));

    // 同じseedで島を作り直す = 再起動相当（terrain は seed から作られるので橋は水に戻っている）
    const h2 = harness(generateIsland(seed));
    expect(h2.world.isWalkableTile(Math.floor(bridge.pos.x), Math.floor(bridge.pos.y))).toBe(false);
    h2.build.restore(saved);
    expect(h2.world.isWalkableTile(Math.floor(bridge.pos.x), Math.floor(bridge.pos.y))).toBe(true);
    expect(h2.terrainChanges).toHaveLength(1);
  });

  it('完成済みの建設は再完成しない（効果が二重に適用されない）', () => {
    const h = harness(generateIsland('main'));
    const well = h.build.seedConstructions().find((c) => c.type === 'well') as Construction;
    contributeUntilDone(h, well.id, well.pos);
    const saved: Construction[] = JSON.parse(JSON.stringify(h.build.constructions()));

    const h2 = harness(generateIsland('main'));
    const before = h2.world.resources.size;
    h2.build.restore(saved);
    // 資源はスナップショットで戻るので、復元で足し直さない
    expect(h2.world.resources.size).toBe(before);
    const again = h2.build.contribute({ playerId: 'p1', constructionId: well.id, playerPos: well.pos, tick: 99999 });
    expect(again).toEqual({ ok: false, reason: 'already_done' });
    expect(h2.events).toHaveLength(0);
  });

  it('復元でID採番が建設物より後ろに進む', () => {
    const h = harness(flatWorld());
    h.build.restore([{ id: 5000, type: 'well', pos: { x: 10.5, y: 10.5 }, progress: 20, contributions: {} }]);
    expect(h.world.peekNextId()).toBeGreaterThan(5000);
  });
});

describe('stats', () => {
  it('設置数・進捗・却下理由を見られる', () => {
    const h = harness(flatWorld());
    place(h, 'bench', 20, 20);
    place(h, 'bench', 21, 20); // too_close
    const s = h.build.stats();
    expect(s.placeables).toBe(1);
    expect(s.placed).toBe(1);
    expect((s.rejects as Record<string, number>).too_close).toBe(1);
    expect((s.placeablesByType as Record<string, number>).bench).toBe(1);
  });
});
