/**
 * 文明の差がゲームに届いているかの検算（T-M18-05）。
 *
 * ■ このテストが生まれた経緯（**読んでから直すこと**）
 * ローマの勝率 78.6% の原因を探すため、8 文明の総当たりで**終局状態**（人口・建物・資源）を
 * 並べて見た。すると **5 文明（ヤマト・唐・ヴァイキング・マリ・モンゴル）の数値が
 * 小数点まで完全に一致**した:
 * ```
 *   civ        age   pop   TC  建物数 種類 資源計
 *   yamato      1.0  32.4  1.0  19.0  4.9  1598.6
 *   tou         1.0  32.4  1.0  19.0  4.9  1598.6   ← 全部同じ
 *   viking      1.0  32.4  1.0  19.0  4.9  1598.6
 *   mali        1.0  32.4  1.0  19.0  4.9  1598.6
 *   mongol      1.0  32.4  1.0  19.0  4.9  1598.6
 * ```
 * 原因は**効果適用エンジン（`core/effects.ts`）が sim にほとんど結線されていなかった**こと。
 * 研究 20 本と建物 3 件の効果が死んでいた（`docs/ISSUES.md` の重大項目）。
 *
 * **勝率だけ見ていたら永久に気付けなかった。** 勝率は席や組み合わせのせいで
 * それらしくばらつくので、「差が届いていない」ことを隠してしまう。
 *
 * ■ だから何を見るか
 * 勝敗ではなく **終局状態が文明ごとに違うこと**。
 * 全部が違う必要はない（似た文明はある）が、**5 文明が完全一致するのは異常**。
 *
 * ■ 判定を緩くしてある理由
 * どの文明がどれだけ強いかは AI の出来に強く依存する。ここで見たいのは
 * 「差が届いているか」だけなので、**同じ数値の塊がいくつあるか**しか見ない。
 */

import { describe, expect, it } from 'vitest';
import { TICK_RATE, createMatch, stepWorld } from '@/sim';
import { AiPlayer } from '@/ai/AiPlayer';
import { EntityKind } from '@/shared/types';
import type { CivId, PlayerId } from '@/shared/types';
import { isAliveIndex } from '@/sim/core/entity';
import { buildingDef } from '@/sim/core/defs';
import type { Command } from '@/sim/command';
import type { World } from '@/sim/core/world';

/** 測る文明（`civs.json` の全 8 文明）。 */
const CIVS: readonly CivId[] = [
  'yamato',
  'roma',
  'tou',
  'viking',
  'mali',
  'azteca',
  'persia',
  'mongol',
];

/** AI の段階（`ai.json` の最上位）。 */
const AI_LEVEL = 4;

/**
 * 1 試合の長さ。**総当たりの全 56 組は重すぎる**（実測 4 分）ので、
 * ここでは「全文明を 1 回ずつ同じ相手に当てる」形にして 8 試合に落とす。
 * 差が届いていないなら 8 試合でも同じ数値が並ぶ（実際に並んだ）。
 */
const MATCH_TICKS = 20 * 60 * TICK_RATE;

/** 終局状態（比べるためのもの。**勝敗は見ない**）。 */
interface Standing {
  readonly civ: CivId;
  readonly age: number;
  readonly pop: number;
  readonly buildings: number;
  readonly resources: number;
}

function standingOf(w: World, p: PlayerId, civ: CivId): Standing {
  const e = w.entities;
  let buildings = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (!isAliveIndex(e, i)) continue;
    if (e.owner[i] !== p || e.kind[i] !== EntityKind.Building) continue;
    buildingDef(e.typeId[i]!); // 未知の typeId なら落ちる（診断のため）
    buildings++;
  }
  const pl = w.players[p]!;
  let resources = 0;
  for (let r = 0; r < pl.resources.length; r++) resources += pl.resources[r]!;
  return { civ, age: pl.age, pop: pl.pop, buildings, resources };
}

/**
 * 全文明を**同じ相手・同じ種**で 1 回ずつ回す。
 *
 * 相手を固定するのは、**違いの原因を文明だけに絞る**ため。
 * 相手も変えると「組み合わせの相性で違って見えた」のか区別できない。
 * 相手はモンゴル（内政ボーナスが生産速度だけで、内政の数値に影響しにくい）。
 */
function measure(): Standing[] {
  const out: Standing[] = [];
  for (const civ of CIVS) {
    const { world } = createMatch({ seed: 20260811, playerCount: 2, civs: [civ, 'mongol'] });
    const ais = [new AiPlayer(0, AI_LEVEL), new AiPlayer(1, AI_LEVEL)];
    for (let t = 0; t < MATCH_TICKS; t++) {
      const cmds: Command[] = [];
      for (let p = 0; p < 2; p++) {
        const c = ais[p]!.think(world);
        for (let k = 0; k < c.length; k++) cmds.push(c[k]!);
      }
      stepWorld(world, cmds);
      if (world.gameOver) break;
    }
    out.push(standingOf(world, 0, civ));
  }
  return out;
}

/** 終局状態を 1 本の文字列にする（同じかどうかの比較用）。 */
function keyOf(s: Standing): string {
  return `${s.age}/${s.pop}/${s.buildings}/${s.resources}`;
}

describe('文明の差がゲームに届いている（T-M18-05）', () => {
  const stands = measure();

  it('実測を表に出す（`docs/BALANCE.md` に貼るための数字）', () => {
    const lines = stands.map(
      (s) =>
        `  ${s.civ.padEnd(8)} 時代 ${s.age} / 人口 ${String(s.pop).padStart(3)} / ` +
        `建物 ${String(s.buildings).padStart(3)} 棟 / 資源計 ${Math.round(s.resources / 256)}`
    );
    console.log(`[T-M18-05] AI 段階 ${AI_LEVEL} / 対モンゴル / 20 分\n${lines.join('\n')}`);
    expect(stands.length).toBe(CIVS.length);
  });

  it('終局状態が完全に一致する文明が 3 つ以上ないこと', () => {
    // 「効果が届いていない」ときは 5 文明が一致した。
    // 2 文明までなら「たまたま似た」で説明が付くが、3 文明以上は仕組みが死んでいる証拠。
    const groups = new Map<string, CivId[]>();
    for (const s of stands) {
      const k = keyOf(s);
      const g = groups.get(k);
      if (g === undefined) groups.set(k, [s.civ]);
      else g.push(s.civ);
    }
    let worst: CivId[] = [];
    for (const g of groups.values()) if (g.length > worst.length) worst = g;
    expect(
      worst.length,
      `終局状態が完全に一致する文明が ${worst.length} つある（${worst.join(', ')}）` +
        ' ―― 文明の差がゲームに届いていない疑い。`docs/ISSUES.md` の「効果適用エンジンが未結線」を読むこと'
    ).toBeLessThan(3);
  });

  it('どの文明も 20 分で青銅の世に上がる（内政が壊れていないことの下限）', () => {
    for (const s of stands) {
      expect(s.age, `${s.civ} が 20 分で青銅の世に上がらない`).toBeGreaterThanOrEqual(1);
    }
  });
}, 600000);
