/**
 * 戦域 AI（T-M13-04）と 5 段階の差分（T-M13-05）。
 *
 * 完了条件:
 *  - T-M13-04: **段階 4 が囮の戦域を立てる**
 *  - T-M13-05: **段階 5 が固有令・二重旗・攻城を使う**
 *
 * 令の遅延・切り替え間隔は `sim` が持っているので、ここで見るのは
 * 「AI が**何を出すか**」だけ（プレイヤーと同じ経路 = `Command`）。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import type { CivId } from '@/shared/types';
import type { Command } from '@/sim/command';
import { spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fxFromInt } from '@/sim/core/fx';
import { buildingDefById, techDefById, unitDefById } from '@/sim/core/defs';
import { createWorld, getFront } from '@/sim/core/world';
import type { World } from '@/sim/core/world';
import { AiPlayer, SQUAD_MIN_UNITS } from '@/ai/index';

const MAP = 200;

function makeWorld(ownCiv: CivId = 'yamato'): World {
  return createWorld({
    seed: 31,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 512,
    civs: [ownCiv, 'azteca'],
  });
}

function putUnit(w: World, id: string, owner: number, tx: number, ty: number): void {
  const def = unitDefById(id);
  spawnEntity(w.entities, {
    kind: EntityKind.Unit,
    owner,
    typeId: def.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: def.hp,
  });
}

function putBuilding(w: World, id: string, owner: number, tx: number, ty: number): void {
  const def = buildingDefById(id);
  const eid = spawnEntity(w.entities, {
    kind: EntityKind.Building,
    owner,
    typeId: def.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: def.hp,
  });
  // 完成扱いにする（`PROGRESS_DONE` を入れないと建設中になる）。
  const i = eid & 0xffff;
  w.entities.buildProgress[i] = 1 << 30;
}

/** 戦域を 1 つ立てた状態にする（`frontLifecycle` を待たずにテストの前提を作る）。 */
function activateFront(
  w: World,
  owner: number,
  slot: number,
  opts: { x: number; y: number; advantage: number; members: number; radiusTiles?: number }
): void {
  const f = getFront(w, owner, slot)!;
  f.active = true;
  f.x = fxFromInt(opts.x);
  f.y = fxFromInt(opts.y);
  f.radius = fxFromInt(opts.radiusTiles ?? 15);
  f.advantage = opts.advantage;
  f.memberCount = opts.members;
  w.players[owner]!.frontSlots = 6;
}

function ordersOf(cmds: readonly Command[]): { order: string; tier: string; front: number }[] {
  const out: { order: string; tier: string; front: number }[] = [];
  for (const c of cmds) if (c.t === 'setOrder') out.push({ order: c.order, tier: c.tier, front: c.front });
  return out;
}

function movesOf(cmds: readonly Command[]): { n: number; x: number; y: number }[] {
  const out: { n: number; x: number; y: number }[] = [];
  for (const c of cmds) if (c.t === 'moveUnits') out.push({ n: c.units.length, x: c.x, y: c.y });
  return out;
}

/** 判断間隔に当たる tick まで空回しせず、その段階の位相に合わせた tick を作る。 */
function thinkAt(ai: AiPlayer, w: World): Command[] {
  for (let k = 0; k < 300; k++) {
    if (ai.isDecisionTick(w.tick)) return ai.think(w);
    w.tick += 1;
  }
  throw new Error('判断 tick が来ない');
}

describe('戦域 AI（T-M13-04）', () => {
  it('段階 2 は突撃と死守だけを使う（ai.json の usableOrders）', () => {
    const w = makeWorld();
    putUnit(w, 'y-ashigaru', 0, 50, 50);
    activateFront(w, 0, 1, { x: 50, y: 50, advantage: 0, members: 5 });
    const cmds = thinkAt(new AiPlayer(0, 2), w);
    const orders = ordersOf(cmds);
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) {
      expect(['charge', 'hold']).toContain(o.order);
      expect(o.tier).toBe('upper');
    }
  });

  it('崩れかけの戦域に「後退」を渡して捨てる（段階 3 以上。07§2 の「捨てる戦域を選ぶ」）', () => {
    const w = makeWorld();
    putUnit(w, 'y-ashigaru', 0, 50, 50);
    // 戦域 1 は総崩れ（-0.8）、戦域 2 は優勢（+0.5）→ 1 を捨てて 2 に寄せる。
    activateFront(w, 0, 1, { x: 50, y: 50, advantage: -Math.round(0.8 * FX_ONE), members: 4 });
    activateFront(w, 0, 2, { x: 80, y: 80, advantage: Math.round(0.5 * FX_ONE), members: 9 });
    const orders = ordersOf(thinkAt(new AiPlayer(0, 3), w));
    const one = orders.find((o) => o.front === 1);
    const two = orders.find((o) => o.front === 2);
    expect(one?.order).toBe('retreat');
    expect(two?.order).toBe('charge');
  });

  it('段階 2 は後退を使えないので、崩れかけでも死守で粘る', () => {
    const w = makeWorld();
    putUnit(w, 'y-ashigaru', 0, 50, 50);
    activateFront(w, 0, 1, { x: 50, y: 50, advantage: -Math.round(0.8 * FX_ONE), members: 4 });
    activateFront(w, 0, 2, { x: 80, y: 80, advantage: Math.round(0.5 * FX_ONE), members: 9 });
    const orders = ordersOf(thinkAt(new AiPlayer(0, 2), w));
    expect(orders.find((o) => o.front === 1)?.order).toBe('hold');
  });

  it('段階 4 が囮の戦域を立てる（本命とは別の場所へ front.spawnMinUnits 体）', () => {
    const w = makeWorld();
    // 兵は本命 1 隊 + 囮 1 隊ぶん（= spawnMinUnits × 2）以上。
    for (let k = 0; k < SQUAD_MIN_UNITS * 3; k++) putUnit(w, 'y-ashigaru', 0, 50 + k, 50);
    // 見えている敵の拠点を 2 つ（送り先が 2 つ以上ないと囮にならない）。
    putBuilding(w, 'house', 1, 54, 50);
    putBuilding(w, 'house', 1, 56, 52);
    activateFront(w, 0, 1, { x: 50, y: 50, advantage: 0, members: SQUAD_MIN_UNITS });

    const moves = movesOf(thinkAt(new AiPlayer(0, 4), w));
    // 本命と囮の 2 隊が出る。
    expect(moves.length).toBe(2);
    const decoy = moves[1]!;
    const main = moves[0]!;
    expect(decoy.n).toBe(SQUAD_MIN_UNITS); // 囮は「少数の兵」（07§11）
    expect(main.n).toBeGreaterThan(decoy.n);
    // 送り先が本命と違う（守備を引き剥がすため）。
    expect(decoy.x !== main.x || decoy.y !== main.y).toBe(true);
  });

  it('段階 3 は囮を立てない（allowDecoy = false）', () => {
    const w = makeWorld();
    for (let k = 0; k < SQUAD_MIN_UNITS * 3; k++) putUnit(w, 'y-ashigaru', 0, 50 + k, 50);
    putBuilding(w, 'house', 1, 54, 50);
    putBuilding(w, 'house', 1, 56, 52);
    activateFront(w, 0, 1, { x: 50, y: 50, advantage: 0, members: SQUAD_MIN_UNITS });
    const moves = movesOf(thinkAt(new AiPlayer(0, 3), w));
    expect(moves.length).toBe(1);
  });
});

describe('5 段階の差分（T-M13-05）', () => {
  it('判断間隔が ai.json どおり（8/6/4/2/1 秒）', () => {
    const expected = [200, 150, 100, 50, 25];
    for (let level = 1; level <= 5; level++) {
      const ai = new AiPlayer(0, level);
      expect(ai.cfg.intervalTicks).toBe(expected[level - 1]);
      // 間隔外の tick では空配列（World を触らない）。
      const w = makeWorld();
      let decisions = 0;
      for (let t = 0; t < 1000; t++) {
        w.tick = t;
        if (ai.isDecisionTick(t)) decisions++;
      }
      expect(decisions).toBe(Math.ceil(1000 / expected[level - 1]!));
    }
  });

  it('段階 5 が固有令を使う（allowUniqueOrders。文明ごとに違う令が出る）', () => {
    for (const [civ, order] of [
      ['yamato', 'jindate'],
      ['roma', 'hojin'],
      ['persia', 'assai'],
      ['mongol', 'yugeki'],
    ] as const) {
      const w = makeWorld(civ);
      putUnit(w, 'clubman', 0, 50, 50);
      activateFront(w, 0, 1, { x: 50, y: 50, advantage: 0, members: 5 });
      const orders = ordersOf(thinkAt(new AiPlayer(0, 5), w));
      expect(orders.some((o) => o.order === order && o.tier === 'upper')).toBe(true);
    }
  });

  it('段階 4 以下は固有令を出さない（allowUniqueOrders = false）', () => {
    const w = makeWorld('yamato');
    putUnit(w, 'clubman', 0, 50, 50);
    activateFront(w, 0, 1, { x: 50, y: 50, advantage: 0, members: 5 });
    const orders = ordersOf(thinkAt(new AiPlayer(0, 4), w));
    expect(orders.some((o) => o.order === 'jindate')).toBe(false);
  });

  it('段階 5 が二重旗の下段を使う（研究「二重旗」を取った後だけ）', () => {
    const w = makeWorld('yamato');
    putUnit(w, 'clubman', 0, 50, 50);
    activateFront(w, 0, 1, { x: 50, y: 50, advantage: 0, members: 5 });
    // 上段は既に固有令が立っている状態にして、下段の判断に進ませる。
    getFront(w, 0, 1)!.order = 'jindate';

    // 二重旗を取っていなければ下段は出さない（プレイヤーと同じ条件。07§4）。
    const before = ordersOf(thinkAt(new AiPlayer(0, 5), w));
    expect(before.some((o) => o.tier === 'lower')).toBe(false);

    // 二重旗を研究済みにすると下段が出る。
    w.players[0]!.researched[techDefById('nijuuhata').index] = 1;
    const after = ordersOf(thinkAt(new AiPlayer(0, 5), w));
    expect(after.some((o) => o.tier === 'lower')).toBe(true);
  });

  it('段階 5 が攻城（包囲）を使う。段階 4 は使わない（allowSiege）', () => {
    function run(level: number): string[] {
      const w = makeWorld('yamato');
      putUnit(w, 'clubman', 0, 50, 50);
      putBuilding(w, 'house', 1, 52, 50); // 戦域の輪の中に敵の建物が見えている
      activateFront(w, 0, 1, { x: 50, y: 50, advantage: 0, members: 5 });
      getFront(w, 0, 1)!.order = 'jindate';
      w.players[0]!.researched[techDefById('nijuuhata').index] = 1;
      return ordersOf(thinkAt(new AiPlayer(0, level), w)).map((o) => o.order);
    }
    expect(run(5)).toContain('siege');
    expect(run(4)).not.toContain('siege');
  });

  it('段階 1 は戦域に令を配らない（内政のみ）', () => {
    const w = makeWorld();
    putUnit(w, 'y-ashigaru', 0, 50, 50);
    activateFront(w, 0, 1, { x: 50, y: 50, advantage: 0, members: 5 });
    expect(ordersOf(thinkAt(new AiPlayer(0, 1), w))).toHaveLength(0);
  });
});
