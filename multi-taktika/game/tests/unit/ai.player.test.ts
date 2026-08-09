/**
 * AI の骨格（T-M13-01）。完了条件: **AI が `sim` の内部状態を直接書き換えていない**。
 *
 * 見るもの:
 *  1. 判断間隔の tick 以外は空配列（`ai.json` の `decisionIntervalSec`）
 *  2. `think()` が World を書き換えない（`rngAi` の状態以外は 1 バイトも変わらない）
 *  3. 出るのは `Command` だけで、必ず自分の `playerId` が入っている
 *  4. 同じ World・同じ段階からは同じ Command が出る（決定論）
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { spawnEntity } from '@/sim/core/entity';
import { fxFromInt } from '@/sim/core/fx';
import { unitDefById } from '@/sim/core/defs';
import { COMMAND_TYPES } from '@/sim/command';
import { createMatch } from '@/sim/setup';
import { stepWorld } from '@/sim/index';
import type { World } from '@/sim/core/world';
import { AiPlayer } from '@/ai/index';

/**
 * `rngAi` を除いた World の署名。
 * AI は `rngAi` だけを消費してよく、それ以外を変えたらここが変わる。
 */
function signatureWithoutAiRng(w: World): string {
  const e = w.entities;
  const parts: (number | string)[] = [w.tick, e.count, e.highWater, w.winner, w.gameOver ? 1 : 0];
  for (let i = 0; i < e.highWater; i++) {
    parts.push(
      e.alive[i]!,
      e.owner[i]!,
      e.typeId[i]!,
      e.x[i]!,
      e.y[i]!,
      e.hp[i]!,
      e.frontId[i]!,
      e.manual[i]!,
      e.state[i]!,
      e.target[i]!,
      e.destX[i]!,
      e.destY[i]!,
      e.queueCount[i]!,
      e.buildProgress[i]!,
      e.researchTech[i]!
    );
  }
  for (let p = 0; p < w.playerCount; p++) {
    const pl = w.players[p]!;
    parts.push(pl.age, pl.pop, pl.popCap, pl.frontSlots, pl.loyalty, pl.resigned ? 1 : 0);
    for (let r = 0; r < pl.resources.length; r++) parts.push(pl.resources[r]!);
    for (let t = 0; t < pl.researched.length; t++) parts.push(pl.researched[t]!);
  }
  for (let s = 0; s < w.fronts.length; s++) {
    const f = w.fronts[s]!;
    parts.push(
      f.active ? 1 : 0,
      f.x,
      f.y,
      f.radius,
      String(f.order),
      String(f.orderLower),
      f.pendingOrder === null ? '-' : `${f.pendingOrder.id}/${f.pendingOrder.deliverAtTick}`,
      f.advantage,
      f.memberCount
    );
  }
  parts.push(...Array.from(w.rngCombat.state), ...Array.from(w.rngMap.state));
  return parts.join(',');
}

describe('AiPlayer の骨格（T-M13-01）', () => {
  it('判断間隔の tick 以外は空配列を返す', () => {
    const { world } = createMatch({ seed: 3, playerCount: 2 });
    const ai = new AiPlayer(0, 3); // 4 秒 = 100 tick
    let nonEmpty = 0;
    let decisions = 0;
    for (let t = 0; t < 500; t++) {
      const cmds = ai.think(world);
      if (ai.isDecisionTick(world.tick)) decisions++;
      else expect(cmds).toHaveLength(0);
      if (cmds.length > 0) nonEmpty++;
      stepWorld(world, cmds);
    }
    expect(decisions).toBe(5);
    expect(nonEmpty).toBeGreaterThan(0);
    expect(nonEmpty).toBeLessThanOrEqual(decisions);
  });

  it('think() は World を書き換えない（rngAi の状態以外は同一）', () => {
    const { world } = createMatch({ seed: 9, playerCount: 2 });
    const ai = new AiPlayer(0, 5); // 毎秒判断する段階で試す
    // 戦域と敵が見える状況も混ぜる。
    const def = unitDefById('clubman');
    spawnEntity(world.entities, {
      kind: EntityKind.Unit,
      owner: 1,
      typeId: def.index,
      x: fxFromInt(60),
      y: fxFromInt(60),
      hpMax: def.hp,
    });

    for (let t = 0; t < 200; t++) {
      const before = signatureWithoutAiRng(world);
      const combatBefore = Array.from(world.rngCombat.state);
      const cmds = ai.think(world);
      // 判断しても World は変わらない（変えるのは applyCommands だけ）。
      expect(signatureWithoutAiRng(world)).toBe(before);
      expect(Array.from(world.rngCombat.state)).toEqual(combatBefore);
      stepWorld(world, cmds);
    }
  });

  it('出るのは Command だけで、必ず自分の playerId が入っている', () => {
    const { world } = createMatch({ seed: 21, playerCount: 3 });
    const ai = new AiPlayer(2, 4);
    let total = 0;
    for (let t = 0; t < 600; t++) {
      const cmds = ai.think(world);
      for (const c of cmds) {
        expect(COMMAND_TYPES).toContain(c.t);
        expect(c.p).toBe(2);
        total++;
      }
      stepWorld(world, cmds);
    }
    expect(total).toBeGreaterThan(0);
  });

  it('同じ World・同じ段階からは同じ Command が出る（決定論）', () => {
    function run(): string[] {
      const { world } = createMatch({ seed: 77, playerCount: 2 });
      const ai = new AiPlayer(0, 4);
      const log: string[] = [];
      for (let t = 0; t < 1000; t++) {
        const cmds = ai.think(world);
        for (const c of cmds) log.push(JSON.stringify(c));
        stepWorld(world, cmds);
      }
      return log;
    }
    const a = run();
    const b = run();
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });
});
