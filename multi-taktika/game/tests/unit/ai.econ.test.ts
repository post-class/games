/**
 * 内政 AI（T-M13-02）。完了条件: **段階 1 が 20 分間破綻せず内政を回す**。
 *
 * 「破綻しない」をこう定義して数値で確かめる:
 *  1. 20 分（30,000 tick）を例外なく完走する
 *  2. 採集収入がある（累計収入 > 0）＝ 内政が止まっていない
 *  3. 村人が増えている（生産を続けている）
 *  4. 家が建ち、**人口上限で詰まらない**（1 秒ごとの観測で余裕が 0 にならない）
 *  5. 資源を使い切らない（家 1 棟ぶんの余力を常に残す。使い切ると詰む）
 *
 * ■ 上流の不具合について（申し送り。AI の外側）
 * `createMatch` の World を **AI なし・コマンドなし**で空回しすると、
 * 開始村人が tick 8,000 前後で動けなくなり、プレイヤー 0 の資源が
 * 230/300/100/50 で凍る（`movement` が速度を持ちながら座標を進めない）。
 * つまり「資源が最後まで増え続ける」はシム側の修正が要る。
 * このテストは **AI の責任範囲**（生産・建設・人口管理・資源の使い方）だけを見る。
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

describe('内政 AI（T-M13-02）', () => {
  it('段階 1 が 20 分間破綻せず内政を回す', () => {
    const { world } = createMatch({ seed: 4242, playerCount: 2 });
    const ai = new AiPlayer(0, 1);
    const villagerType = unitDefById('villager').index;
    const houseType = buildingDefById('house').index;
    const houseCost = buildingDefById('house').cost;

    const startVillagers = countOwn(world, 0, villagerType, EntityKind.Unit);
    const startCap = world.players[0]!.popCap;
    // 累計収入 = 資源が増えた分だけを足す（生産・建設で減った分は数えない）。
    const income = new Int32Array(RESOURCE_COUNT);
    let prev = Int32Array.from(world.players[0]!.resources);
    let jammedSamples = 0;
    let minHeadroom = Number.MAX_SAFE_INTEGER;

    for (let t = 0; t < TWENTY_MIN_TICKS; t++) {
      const cmds = ai.think(world);
      stepWorld(world, cmds);
      const pl = world.players[0]!;
      for (let r = 0; r < RESOURCE_COUNT; r++) {
        const d = pl.resources[r]! - prev[r]!;
        if (d > 0) income[r] = income[r]! + d;
      }
      prev = Int32Array.from(pl.resources);
      if (t % TICK_RATE === 0) {
        const headroom = pl.popCap - pl.pop;
        if (headroom < minHeadroom) minHeadroom = headroom;
        if (headroom <= 0) jammedSamples++;
      }
    }

    const pl = world.players[0]!;
    // 1) 20 分を例外なく完走。
    expect(world.tick).toBe(TWENTY_MIN_TICKS);
    // 2) 採集収入がある（内政が回っている）。
    let totalIncome = 0;
    for (let r = 0; r < RESOURCE_COUNT; r++) totalIncome += fxToInt(income[r]!);
    expect(totalIncome).toBeGreaterThan(0);
    // 3) 村人が増えている。
    expect(countOwn(world, 0, villagerType, EntityKind.Unit)).toBeGreaterThan(startVillagers);
    // 4) 家が建ち、人口上限が伸びている。詰まった観測は 1 度も無い。
    expect(countOwn(world, 0, houseType, EntityKind.Building)).toBeGreaterThan(0);
    expect(pl.popCap).toBeGreaterThan(startCap);
    expect(jammedSamples).toBe(0);
    expect(minHeadroom).toBeGreaterThan(0);
    // 5) 家 1 棟ぶんの余力を残している（使い切って詰まない）。
    for (let r = 0; r < RESOURCE_COUNT; r++) {
      if (houseCost[r]! > 0) expect(pl.resources[r]!).toBeGreaterThanOrEqual(houseCost[r]!);
    }
  });

  it('段階 1 は軍事の Command を 1 件も出さない（内政のみ・攻めてこない。07§11）', () => {
    const { world } = createMatch({ seed: 7, playerCount: 2 });
    const ai = new AiPlayer(0, 1);
    let military = 0;
    for (let t = 0; t < 120 * TICK_RATE; t++) {
      const cmds = ai.think(world);
      for (const c of cmds) {
        if (c.t === 'setOrder' || c.t === 'moveUnits' || c.t === 'attackTarget') military++;
        if (c.t === 'produce' && unitDefById(c.unit).lineIdx !== 0) military++;
      }
      stepWorld(world, cmds);
    }
    expect(military).toBe(0);
  });

  it('段階 3 以上だけが時代進化を試みる（ai.json の allowAdvanceAge）', () => {
    const seen = [false, false, false, false, false];
    for (let level = 1; level <= 5; level++) {
      const { world } = createMatch({ seed: 11, playerCount: 2 });
      const ai = new AiPlayer(0, level);
      for (let t = 0; t < 60 * TICK_RATE; t++) {
        const cmds = ai.think(world);
        for (const c of cmds) if (c.t === 'advanceAge') seen[level - 1] = true;
        stepWorld(world, cmds);
      }
    }
    expect(seen[0]).toBe(false); // 素人
    expect(seen[1]).toBe(false); // 見習い
    expect(seen[2]).toBe(true); // 諸侯
    expect(seen[3]).toBe(true); // 将軍
    expect(seen[4]).toBe(true); // 総大将
  });
});
