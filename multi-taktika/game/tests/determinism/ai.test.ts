/**
 * AI の決定論（T-M13-05 / T-M13-06）。
 *
 * 完了条件:
 *  - T-M13-05: **AI の乱数消費が戦闘結果に影響しない**（手順書 §4.3 / §10）
 *  - T-M13-06: **AI 同士 8 人で 30 分完走**（例外なし / 決定論ハッシュ再現 / 性能）
 *
 * ■ 「AI の乱数消費が戦闘結果に影響しない」をどう確かめるか
 * `rngAi` と `rngCombat` は別ストリーム（`world.ts` の salt で分離）なので、
 * **AI が何回乱数を引いても戦闘の乱数列は 1 つもずれない**はずである。
 * これを次の 2 通りで確かめる:
 *   (A) 同じ試合を 2 つ用意し、片方だけ `rngAi` を毎 tick 余分に引く。
 *       `rngAi` 以外の状態（＝戦闘結果を含む World 全体）が完全に一致すること。
 *   (B) 段階 1 と段階 5 の AI を「判断はさせるが Command は捨てる」形で並走させる。
 *       乱数を引く回数は段階で大きく違うが、戦闘は同じに進むこと。
 * (B) は実際の `AiPlayer` を通すので、「AI の実装が `rngCombat` を触っていない」
 * ことまで同時に押さえられる（触れば即座に不一致になる）。
 */

import { describe, expect, it } from 'vitest';
import { CIV_IDS, EntityKind } from '@/shared/types';
import type { Command } from '@/sim/command';
import { spawnEntity } from '@/sim/core/entity';
import { fxFromInt } from '@/sim/core/fx';
import { unitDefById } from '@/sim/core/defs';
import { MATCH_LENGTH_TICKS, TICK_RATE } from '@/sim/core/config';
import { createWorld } from '@/sim/core/world';
import type { World } from '@/sim/core/world';
import { hashWorld } from '@/sim/hash';
import { HASH_CHECK_INTERVAL_TICKS, stepWorld } from '@/sim/index';
import { createMatch } from '@/sim/setup';
import { AiPlayer } from '@/ai/index';

/**
 * `rngAi` を除いた World の署名（`tests/unit/ai.player.test.ts` と同じ定義）。
 * テストファイルを import すると相手のテストまで走ってしまうので、
 * 意図して**この 1 関数だけ**を写している。
 */
function signatureWithoutAiRng(w: World): string {
  const e = w.entities;
  const parts: (number | string)[] = [w.tick, e.count, e.highWater, w.winner, w.gameOver ? 1 : 0];
  for (let i = 0; i < e.highWater; i++) {
    parts.push(
      e.alive[i]!, e.owner[i]!, e.typeId[i]!, e.x[i]!, e.y[i]!, e.hp[i]!,
      e.frontId[i]!, e.manual[i]!, e.state[i]!, e.target[i]!, e.destX[i]!, e.destY[i]!,
      e.queueCount[i]!, e.buildProgress[i]!, e.researchTech[i]!
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
      f.active ? 1 : 0, f.x, f.y, f.radius, String(f.order), String(f.orderLower),
      f.pendingOrder === null ? '-' : `${f.pendingOrder.id}/${f.pendingOrder.deliverAtTick}`,
      f.advantage, f.memberCount
    );
  }
  parts.push(...Array.from(w.rngCombat.state), ...Array.from(w.rngMap.state));
  return parts.join(',');
}


/** 8 人分の段階（1〜5 を混ぜる。上位ほど判断回数が多いので負荷も見られる）。 */
const LEVELS = [1, 2, 3, 4, 5, 4, 3, 2];

/** 小さな戦闘を仕込んだ World（戦闘乱数を必ず消費させるため）。 */
function makeBattle(): World {
  const w = createWorld({
    seed: 1234,
    playerCount: 2,
    mapWidthTiles: 200,
    mapHeightTiles: 200,
    entityCapacity: 512,
    civs: ['yamato', 'azteca'],
  });
  const mine = unitDefById('clubman');
  const theirs = unitDefById('a-club');
  for (let k = 0; k < 8; k++) {
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner: 0,
      typeId: mine.index,
      x: fxFromInt(50 + k),
      y: fxFromInt(50),
      hpMax: mine.hp,
    });
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner: 1,
      typeId: theirs.index,
      x: fxFromInt(50 + k),
      y: fxFromInt(52),
      hpMax: theirs.hp,
    });
  }
  return w;
}

describe('AI の乱数分離（T-M13-05）', () => {
  it('(A) rngAi を余分に引いても戦闘結果は 1 tick も変わらない', () => {
    const a = makeBattle();
    const b = makeBattle();
    const drawsPerTick = 7; // 「AI が余分に乱数を引く」状況の再現
    for (let t = 0; t < 1500; t++) {
      stepWorld(a, []);
      for (let k = 0; k < drawsPerTick; k++) b.rngAi.nextU32();
      stepWorld(b, []);
    }
    // rngAi 以外（エンティティ・HP・rngCombat）が完全一致。
    expect(signatureWithoutAiRng(b)).toBe(signatureWithoutAiRng(a));
    // rngAi の状態だけは違う（＝本当に余分に引いている）。
    expect(Array.from(b.rngAi.state)).not.toEqual(Array.from(a.rngAi.state));
    // 戦闘乱数は同じ位置にある。
    expect(Array.from(b.rngCombat.state)).toEqual(Array.from(a.rngCombat.state));
  });

  it('(B) 段階 1 と段階 5 の AI を走らせても戦闘の進み方は同じ', () => {
    const a = makeBattle();
    const b = makeBattle();
    const ai1 = new AiPlayer(0, 1);
    const ai5 = new AiPlayer(0, 5);
    let think1 = 0;
    let think5 = 0;
    for (let t = 0; t < 1500; t++) {
      // Command は捨てる（比べたいのは「乱数を引いたこと」の影響だけ）。
      if (ai1.think(a).length >= 0 && ai1.isDecisionTick(a.tick)) think1++;
      if (ai5.think(b).length >= 0 && ai5.isDecisionTick(b.tick)) think5++;
      stepWorld(a, []);
      stepWorld(b, []);
    }
    expect(think5).toBeGreaterThan(think1 * 5); // 判断回数は段階で大きく違う
    expect(signatureWithoutAiRng(b)).toBe(signatureWithoutAiRng(a));
    expect(Array.from(b.rngCombat.state)).toEqual(Array.from(a.rngCombat.state));
  });
});

describe('AI 同士 8 人で 30 分（T-M13-06）', () => {
  it('例外なく完走し、同じシードならハッシュ列が一致する', () => {
    interface Outcome {
      hashes: number[];
      finalHash: number;
      elapsedMs: number;
      commands: number;
      fronts: number;
    }

    function run(): Outcome {
      const { world } = createMatch({
        seed: 20260809,
        playerCount: 8,
        civs: CIV_IDS.slice(0, 8),
      });
      const ais: AiPlayer[] = [];
      for (let p = 0; p < 8; p++) ais.push(new AiPlayer(p, LEVELS[p]!));
      const hashes: number[] = [];
      let commands = 0;
      let fronts = 0;
      const t0 = performance.now();
      for (let t = 0; t < MATCH_LENGTH_TICKS; t++) {
        // 並びは playerId 昇順（手順書 §6.11）。
        const cmds: Command[] = [];
        for (let p = 0; p < 8; p++) {
          const c = ais[p]!.think(world);
          for (let k = 0; k < c.length; k++) cmds.push(c[k]!);
        }
        commands += cmds.length;
        stepWorld(world, cmds);
        if (world.tick % HASH_CHECK_INTERVAL_TICKS === 0) hashes.push(hashWorld(world));
        if (world.tick % TICK_RATE === 0) {
          let active = 0;
          for (let s = 0; s < world.fronts.length; s++) if (world.fronts[s]!.active) active++;
          if (active > fronts) fronts = active;
        }
      }
      return {
        hashes,
        finalHash: hashWorld(world),
        elapsedMs: performance.now() - t0,
        commands,
        fronts,
      };
    }

    const first = run();
    const second = run();

    // 1) 例外なし・完走。
    expect(first.hashes.length).toBeGreaterThan(0);
    // 2) 決定論: ハッシュ列と最終ハッシュが完全一致。
    expect(second.hashes).toEqual(first.hashes);
    expect(second.finalHash).toBe(first.finalHash);
    // 3) AI がちゃんと入力を出している。
    expect(first.commands).toBeGreaterThan(0);
    // 4) 性能: 1 tick が実時間 40ms（= 25 tick/秒）よりずっと速いこと。
    const msPerTick = first.elapsedMs / MATCH_LENGTH_TICKS;
    console.log(
      `[T-M13-06] 8 人 × ${MATCH_LENGTH_TICKS} tick: ${first.elapsedMs.toFixed(0)}ms ` +
        `= ${msPerTick.toFixed(3)} ms/tick、Command ${first.commands} 件、最大同時戦域 ${first.fronts}`
    );
    expect(msPerTick).toBeLessThan(1000 / TICK_RATE);
  }, 600000);
});
