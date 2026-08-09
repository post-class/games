/**
 * 内政 AI（T-M13-02）。完了条件: **段階 1 が 20 分間破綻せず内政を回す**。
 *
 * 「破綻しない」を数値で定義する:
 *  1. 例外が出ない
 *  2. 資源の合計が増え続ける（採集が止まらない）
 *  3. **人口上限で詰まらない**（家が建ち、popCap が pop より先に伸びる）
 *  4. 村人が増えている
 */

import { describe, expect, it } from 'vitest';
import { EntityKind, RESOURCE_COUNT } from '@/shared/types';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { fxToInt } from '@/sim/core/fx';
import { TICK_RATE } from '@/sim/core/config';
import { stepWorld } from '@/sim/index';
import { createMatch } from '@/sim/setup';
import type { World } from '@/sim/core/world';
import { AiPlayer } from '@/ai/index';

/** 20 分 = 1,200 秒 = 30,000 tick。 */
const TWENTY_MIN_TICKS = 20 * 60 * TICK_RATE;

function countOwn(w: World, p: number, typeId: number, kind: number): number {
  const e = w.entities;
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1 || e.owner[i] !== p) continue;
    if (e.kind[i] !== kind || e.typeId[i] !== typeId) continue;
    n++;
  }
  return n;
}

function totalResources(w: World, p: number): number {
  const pl = w.players[p]!;
  let sum = 0;
  for (let r = 0; r < RESOURCE_COUNT; r++) sum += fxToInt(pl.resources[r]!);
  return sum;
}

describe('内政 AI（T-M13-02）', () => {
  it('段階 1 が 20 分間破綻せず内政を回す（資源が増え続け、人口上限で詰まらない）', () => {
    const { world } = createMatch({ seed: 4242, playerCount: 2 });
    const ai = new AiPlayer(0, 1);
    const villagerType = unitDefById('villager').index;
    const houseType = buildingDefById('house').index;

    const startRes = totalResources(world, 0);
    const startVillagers = countOwn(world, 0, villagerType, EntityKind.Unit);
    let minHeadroom = Number.MAX_SAFE_INTEGER;
    let jammedTicks = 0;

    for (let t = 0; t < TWENTY_MIN_TICKS; t++) {
      const cmds = ai.think(world);
      stepWorld(world, cmds);
      if (t % TICK_RATE === 0) {
        const pl = world.players[0]!;
        const headroom = pl.popCap - pl.pop;
        if (headroom < minHeadroom) minHeadroom = headroom;
        if (headroom <= 0) jammedTicks++;
      }
    }

    const pl = world.players[0]!;
    // 1) 例外なしでここまで来ている。
    expect(world.tick).toBe(TWENTY_MIN_TICKS);
    // 2) 資源が増えている（採集が止まっていない）。
    expect(totalResources(world, 0)).toBeGreaterThan(startRes);
    // 3) 村人が増えている。
    expect(countOwn(world, 0, villagerType, EntityKind.Unit)).toBeGreaterThan(startVillagers);
    // 4) 家が建っている＝人口上限を伸ばしている。
    expect(countOwn(world, 0, houseType, EntityKind.Building)).toBeGreaterThan(0);
    // 5) 人口上限で詰まっていない（1 秒ごとの観測で余裕が 0 になった回数）。
    expect(jammedTicks).toBe(0);
    expect(pl.popCap).toBeGreaterThan(pl.pop);
  });

  it('段階 1 は軍事の Command を 1 件も出さない（内政のみ・攻めてこない。07§11）', () => {
    const { world } = createMatch({ seed: 7, playerCount: 2 });
    const ai = new AiPlayer(0, 1);
    let military = 0;
    for (let t = 0; t < 60 * TICK_RATE; t++) {
      const cmds = ai.think(world);
      for (const c of cmds) {
        if (c.t === 'setOrder' || c.t === 'moveUnits' || c.t === 'attackTarget') military++;
        if (c.t === 'produce' && unitDefById(c.unit).lineIdx !== 0) military++;
      }
      stepWorld(world, cmds);
    }
    expect(military).toBe(0);
  });
});
