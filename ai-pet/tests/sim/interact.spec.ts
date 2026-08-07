/**
 * interact.ts（プレイヤーの収穫・水やり）のテスト
 * 既定の世界は全面 grass（TERRAINS[0]）なので worldgen には依存しない。
 */
import { describe, expect, it } from 'vitest';
import {
  RESOURCE,
  Rng,
  TICKS_PER_ISLAND_HOUR,
  type EntityId,
  type ResourceNode,
  type ResourceType,
  type Vec2,
} from '@ai-pet/shared';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { WorldClock } from '../../packages/server/src/sim/clock.ts';
import { updateResources } from '../../packages/server/src/sim/resource.ts';
import { InteractSystem, type InteractDeps } from '../../packages/server/src/sim/interact.ts';

interface Emitted {
  kind: 'harvest' | 'build';
  text: string;
  pos?: Vec2;
  actorId?: EntityId;
  importance?: number;
}

function setup(): { world: IslandWorld; clock: WorldClock; sys: InteractSystem; events: Emitted[] } {
  const world = new IslandWorld(new Rng('t'));
  const clock = new WorldClock(new Rng('t'));
  clock.restore({ islandDay: 1, season: 'spring', weather: 'clear' });
  const events: Emitted[] = [];
  const deps: InteractDeps = { emitEvent: (e) => void events.push(e) };
  return { world, clock, sys: new InteractSystem(world, clock, deps), events };
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
    max: opts.max ?? 10,
    regenPerIslandHour: opts.regen ?? 1,
  });
}

/** プレイヤー（アバターは作らず座標だけでよい。距離判定しか見ていない） */
const ACTOR_ID = 999;

function act(
  sys: InteractSystem,
  kind: 'harvest' | 'water',
  node: ResourceNode,
  playerPos: Vec2,
  tick: number,
  playerId = 'p1',
) {
  const opts = { playerId, playerName: 'りょう', actorId: ACTOR_ID, targetId: node.id, playerPos, tick };
  return kind === 'harvest' ? sys.harvest(opts) : sys.water(opts);
}

/** node の隣（距離1未満）に立つ */
function nextTo(node: ResourceNode): Vec2 {
  return { x: node.pos.x + 1, y: node.pos.y };
}

function run(world: IslandWorld, clock: WorldClock, ticks: number, from = 0): void {
  for (let t = from + 1; t <= from + ticks; t++) updateResources(world, t, clock);
}

describe('収穫', () => {
  it('2タイル以内なら採れる（1回2つ）', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 6 });
    const res = act(sys, 'harvest', node, { x: node.pos.x + 2, y: node.pos.y }, 100);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe('harvest');
    expect(res.got).toBeCloseTo(2, 6);
    expect(res.resourceId).toBe(node.id);
    expect(res.amount).toBeCloseTo(4, 6);
    expect(res.text).toBe('りょうが木の実を収穫した');
    expect(node.amount).toBeCloseTo(4, 6);
  });

  it('畑と釣り場も収穫できる', () => {
    const { world, sys } = setup();
    const field = addNode(world, { x: 10, y: 10, amount: 6, type: 'field' });
    const spot = addNode(world, { x: 20, y: 20, amount: 6, type: 'fishing_spot' });

    const a = act(sys, 'harvest', field, nextTo(field), 100);
    const b = act(sys, 'harvest', spot, nextTo(spot), 200, 'p2');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok) expect(a.text).toBe('りょうが畑の作物を収穫した');
    if (b.ok) expect(b.text).toBe('りょうが魚を収穫した');
  });

  it('3タイル離れると too_far', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 6 });
    const res = act(sys, 'harvest', node, { x: node.pos.x + 3, y: node.pos.y }, 100);

    expect(res).toEqual({ ok: false, reason: 'too_far' });
    expect(node.amount).toBe(6);
  });

  it('在庫が無ければ empty（1未満も採れない）', () => {
    const { world, sys } = setup();
    const empty = addNode(world, { x: 10, y: 10, amount: 0 });
    const almost = addNode(world, { x: 20, y: 20, amount: 0.5 });

    expect(act(sys, 'harvest', empty, nextTo(empty), 100)).toEqual({ ok: false, reason: 'empty' });
    expect(act(sys, 'harvest', almost, nextTo(almost), 200)).toEqual({ ok: false, reason: 'empty' });
  });

  it('存在しないIDと水場は not_found', () => {
    const { world, sys } = setup();
    const pond = addNode(world, { x: 10, y: 10, amount: 20, type: 'water' });
    const missing: ResourceNode = { ...pond, id: 12345 };

    expect(act(sys, 'harvest', missing, nextTo(pond), 100)).toEqual({ ok: false, reason: 'not_found' });
    expect(act(sys, 'harvest', pond, nextTo(pond), 200)).toEqual({ ok: false, reason: 'not_found' });
    expect(pond.amount).toBe(20);
  });

  it('採ると荒廃度が上がる', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 6 });
    expect(world.decayAt(10, 10)).toBe(0);

    act(sys, 'harvest', node, nextTo(node), 100);
    expect(world.decayAt(10, 10)).toBe(RESOURCE.decayPerHarvest);
  });

  it('失敗した収穫では荒廃度は上がらない', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 6 });
    act(sys, 'harvest', node, { x: node.pos.x + 5, y: node.pos.y }, 100);
    expect(world.decayAt(10, 10)).toBe(0);
  });

  it('成功したときだけ島の出来事になる（importance 3 / kind harvest）', () => {
    const { world, sys, events } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 6 });

    act(sys, 'harvest', node, { x: node.pos.x + 9, y: node.pos.y }, 100);
    expect(events).toHaveLength(0);

    act(sys, 'harvest', node, nextTo(node), 200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'harvest',
      text: 'りょうが木の実を収穫した',
      actorId: ACTOR_ID,
      importance: 3,
    });
    expect(events[0]?.pos).toEqual(node.pos);
  });

  it('連続収穫は1秒（4tick）のクールダウン。明ければ成功する', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 10 });
    const pos = nextTo(node);

    expect(act(sys, 'harvest', node, pos, 100).ok).toBe(true);
    for (const t of [100, 101, 102, 103]) {
      expect(act(sys, 'harvest', node, pos, t)).toEqual({ ok: false, reason: 'rate' });
    }
    expect(act(sys, 'harvest', node, pos, 104).ok).toBe(true);
    expect(node.amount).toBeCloseTo(6, 6);
  });

  it('クールダウンはプレイヤーごと（他人はブロックされない）', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 10 });
    const pos = nextTo(node);

    expect(act(sys, 'harvest', node, pos, 100, 'p1').ok).toBe(true);
    expect(act(sys, 'harvest', node, pos, 101, 'p1').ok).toBe(false);
    expect(act(sys, 'harvest', node, pos, 101, 'p2').ok).toBe(true);
  });

  it('失敗ではクールダウンが始まらない', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 10 });
    // 遠すぎて失敗 → すぐ近づいて採れる
    expect(act(sys, 'harvest', node, { x: node.pos.x + 8, y: node.pos.y }, 100).ok).toBe(false);
    expect(act(sys, 'harvest', node, nextTo(node), 100).ok).toBe(true);
  });
});

describe('水やり', () => {
  it('畑に水をやると期限が入り、出来事になる（kind build）', () => {
    const { world, sys, events } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 2, type: 'field' });
    const res = act(sys, 'water', node, nextTo(node), 100);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe('water');
    expect(res.got).toBeUndefined();
    expect(res.text).toBe('りょうが畑に水をやった');
    expect(node.wateredUntilTick).toBe(100 + RESOURCE.wateredIslandHours * TICKS_PER_ISLAND_HOUR);
    expect(events[0]).toMatchObject({ kind: 'build', importance: 3, actorId: ACTOR_ID });
  });

  it('木にも水をやれる', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 2 });
    const res = act(sys, 'water', node, nextTo(node), 100);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe('りょうが木に水をやった');
  });

  it('釣り場と水場は not_waterable', () => {
    const { world, sys } = setup();
    const spot = addNode(world, { x: 10, y: 10, amount: 2, type: 'fishing_spot' });
    const pond = addNode(world, { x: 20, y: 20, amount: 20, type: 'water' });

    expect(act(sys, 'water', spot, nextTo(spot), 100)).toEqual({ ok: false, reason: 'not_waterable' });
    expect(act(sys, 'water', pond, nextTo(pond), 200)).toEqual({ ok: false, reason: 'not_waterable' });
    expect(spot.wateredUntilTick).toBeUndefined();
  });

  it('存在しないIDは not_found、遠いと too_far', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 2, type: 'field' });
    const missing: ResourceNode = { ...node, id: 12345 };

    expect(act(sys, 'water', missing, nextTo(node), 100)).toEqual({ ok: false, reason: 'not_found' });
    expect(act(sys, 'water', node, { x: node.pos.x + 3, y: node.pos.y }, 200)).toEqual({
      ok: false,
      reason: 'too_far',
    });
  });

  it('期限内の再水やりは already_watered、期限が切れればまたできる', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 2, type: 'field' });
    const pos = nextTo(node);
    const span = RESOURCE.wateredIslandHours * TICKS_PER_ISLAND_HOUR;

    expect(act(sys, 'water', node, pos, 100).ok).toBe(true);
    expect(act(sys, 'water', node, pos, 100 + span - 1)).toEqual({ ok: false, reason: 'already_watered' });
    expect(act(sys, 'water', node, pos, 100 + span).ok).toBe(true);
    expect(node.wateredUntilTick).toBe(100 + span * 2);
  });

  it('水やりのクールダウンは収穫と共通', () => {
    const { world, sys } = setup();
    const a = addNode(world, { x: 10, y: 10, amount: 6, type: 'field' });
    const b = addNode(world, { x: 12, y: 10, amount: 6, type: 'field' });
    // a を収穫した直後は b に水をやれない
    expect(act(sys, 'harvest', a, nextTo(a), 100).ok).toBe(true);
    expect(act(sys, 'water', b, nextTo(b), 101)).toEqual({ ok: false, reason: 'rate' });
    expect(act(sys, 'water', b, nextTo(b), 104).ok).toBe(true);
  });

  it('水やり後は回復が速くなる（updateResources を回して確認）', () => {
    const { world, clock, sys } = setup();
    const watered = addNode(world, { x: 10, y: 10, amount: 0, max: 100, regen: 2, type: 'field' });
    const plain = addNode(world, { x: 30, y: 30, amount: 0, max: 100, regen: 2, type: 'field' });

    expect(act(sys, 'water', watered, nextTo(watered), 0).ok).toBe(true);
    run(world, clock, TICKS_PER_ISLAND_HOUR);

    expect(watered.amount).toBeGreaterThan(plain.amount);
    expect(watered.amount / plain.amount).toBeCloseTo(RESOURCE.wateredRegenMultiplier, 5);
  });
});

describe('actionsFor', () => {
  it('近くて在庫があれば harvest と water の両方', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 3, type: 'field' });
    expect(sys.actionsFor(node.id, nextTo(node), 100)).toEqual(['harvest', 'water']);
  });

  it('遠いと空配列', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 3, type: 'field' });
    expect(sys.actionsFor(node.id, { x: node.pos.x + 3, y: node.pos.y }, 100)).toEqual([]);
  });

  it('在庫0なら harvest は出ない', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 0, type: 'field' });
    expect(sys.actionsFor(node.id, nextTo(node), 100)).toEqual(['water']);
  });

  it('水やり済みなら water は出ない。期限が切れれば戻る', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 3, type: 'field' });
    const span = RESOURCE.wateredIslandHours * TICKS_PER_ISLAND_HOUR;

    act(sys, 'water', node, nextTo(node), 100);
    expect(sys.actionsFor(node.id, nextTo(node), 100)).toEqual(['harvest']);
    expect(sys.actionsFor(node.id, nextTo(node), 100 + span)).toEqual(['harvest', 'water']);
  });

  it('釣り場は harvest だけ、水場と未知のIDは空', () => {
    const { world, sys } = setup();
    const spot = addNode(world, { x: 10, y: 10, amount: 3, type: 'fishing_spot' });
    const pond = addNode(world, { x: 20, y: 20, amount: 20, type: 'water' });

    expect(sys.actionsFor(spot.id, nextTo(spot), 100)).toEqual(['harvest']);
    expect(sys.actionsFor(pond.id, nextTo(pond), 100)).toEqual([]);
    expect(sys.actionsFor(12345, nextTo(spot), 100)).toEqual([]);
  });

  it('tick 省略時は「水やり済みかもしれない」側に倒す', () => {
    const { world, sys } = setup();
    const node = addNode(world, { x: 10, y: 10, amount: 3, type: 'field' });
    expect(sys.actionsFor(node.id, nextTo(node))).toEqual(['harvest', 'water']);
    act(sys, 'water', node, nextTo(node), 100);
    expect(sys.actionsFor(node.id, nextTo(node))).toEqual(['harvest']);
  });
});

describe('決定論', () => {
  it('同じ操作列なら同じ結果・同じ島の状態になる', () => {
    const script: { kind: 'harvest' | 'water'; tick: number; dx: number }[] = [
      { kind: 'harvest', tick: 100, dx: 1 },
      { kind: 'harvest', tick: 101, dx: 1 },
      { kind: 'water', tick: 104, dx: 1 },
      { kind: 'water', tick: 108, dx: 1 },
      { kind: 'harvest', tick: 112, dx: 5 },
      { kind: 'harvest', tick: 116, dx: 1 },
    ];

    const play = (): { results: unknown[]; amount: number; decay: number; stats: unknown } => {
      const { world, clock, sys, events } = setup();
      const node = addNode(world, { x: 10, y: 10, amount: 8, max: 10, regen: 2, type: 'field' });
      const results: unknown[] = [];
      for (const s of script) {
        results.push(act(sys, s.kind, node, { x: node.pos.x + s.dx, y: node.pos.y }, s.tick));
      }
      run(world, clock, TICKS_PER_ISLAND_HOUR, 116);
      return {
        results: [...results, ...events],
        amount: node.amount,
        decay: world.decayAt(10, 10),
        stats: sys.stats(),
      };
    };

    expect(play()).toEqual(play());
  });
});
