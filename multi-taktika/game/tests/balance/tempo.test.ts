/**
 * 試合のテンポの検証（T-M18-01。`07§2` / `config.matchPhases`）。
 *
 * ■ 資料が定める 4 区間
 *   0〜5 分   立ち上げ  村人だけを増やす時間。**戦域は立たない**
 *   5〜12 分  初接触    斥候が出会い**最初の戦域が 1 つ立つ**
 *   12〜20 分 分割      戦線が**2〜4 本**に割れる。捨てる戦域を選び始める
 *   20〜30 分 総力戦    残った戦力を集めて決める
 *
 * ■ 何をどう測るか
 * AI 同士の試合を 30 分回し、**区間ごとに「戦域が何本立っていたか」**を数える。
 * 人間のプレイとは違うが、`07§2` が言っているのは
 * 「その時間に何が起きているか」なので、AI でも同じ形が出るはず。
 *
 * ■ 判定を厳しくしない理由
 * テンポは AI の強さに強く依存する。**いま何が成立していて何が成立していないかを
 * 数字で残す**のが目的なので、明らかな破綻（立ち上げから戦域が立つ、
 * 30 分でも 1 本も立たない）だけを落とす。厳しい上下限を置くと
 * AI を触るたびに落ちて、数字を見なくなる。
 */

import { describe, expect, it } from 'vitest';
import { TICK_RATE, createMatch, stepWorld } from '@/sim';
import { AiPlayer } from '@/ai/AiPlayer';
import type { Command } from '@/sim/command';
import { cfgArray } from '@/sim/core/config';

/** `config.matchPhases` の 1 区間。 */
interface Phase {
  readonly id: string;
  readonly name: string;
  readonly fromTick: number;
  readonly toTick: number;
}

/** `config.json` の `matchPhases` を tick に直す（数値をここに書かない）。 */
function phases(): Phase[] {
  return cfgArray('matchPhases').map((raw) => {
    const p = raw as Record<string, unknown>;
    return {
      id: String(p['id']),
      name: String(p['name']),
      fromTick: Math.round(Number(p['fromSec']) * TICK_RATE),
      toTick: Math.round(Number(p['toSec']) * TICK_RATE),
    };
  });
}

/** 区間ごとの実測。 */
interface PhaseStat {
  readonly phase: Phase;
  /** その区間で同時に立っていた戦域の最大数（両プレイヤーの合計ではなく片方ずつの最大）。 */
  maxFronts: number;
  /** その区間のあいだに戦域が立っていた tick の割合（0..1）。 */
  activeRatio: number;
  /** 区間の終わりの時代（0 = 黎明）。 */
  endAge: number;
}

/** AI 同士を 30 分回して区間ごとの実測を取る。 */
function measure(seed: number): PhaseStat[] {
  const ps = phases();
  const { world } = createMatch({
    seed,
    playerCount: 2,
    civs: ['yamato', 'mongol'],
    mapType: 'plain',
  });
  const ais = [new AiPlayer(0, 4), new AiPlayer(1, 4)];
  const out: PhaseStat[] = ps.map((phase) => ({
    phase,
    maxFronts: 0,
    activeRatio: 0,
    endAge: 0,
  }));
  const activeTicks = ps.map(() => 0);
  const lastTick = ps[ps.length - 1]?.toTick ?? 0;

  for (let t = 0; t < lastTick; t++) {
    const cmds: Command[] = [];
    for (const ai of ais) cmds.push(...ai.think(world));
    stepWorld(world, cmds);

    // どの区間か（index 昇順で最初に当たったもの）
    let at = -1;
    for (let k = 0; k < ps.length; k++) {
      if (world.tick >= ps[k]!.fromTick && world.tick < ps[k]!.toTick) {
        at = k;
        break;
      }
    }
    if (at < 0) continue;

    // 立っている戦域を playerId ごとに数える
    let p0 = 0;
    let p1 = 0;
    for (const f of world.fronts) {
      if (!f.active) continue;
      if (f.owner === 0) p0++;
      else if (f.owner === 1) p1++;
    }
    const most = p0 > p1 ? p0 : p1;
    if (most > out[at]!.maxFronts) out[at]!.maxFronts = most;
    if (most > 0) activeTicks[at] = activeTicks[at]! + 1;
    out[at]!.endAge = world.players[0]!.age;
  }
  for (let k = 0; k < ps.length; k++) {
    const span = ps[k]!.toTick - ps[k]!.fromTick;
    out[k]!.activeRatio = span > 0 ? activeTicks[k]! / span : 0;
  }
  return out;
}

describe('試合のテンポ（T-M18-01）', () => {
  const stats = measure(20260810);

  it('実測を表に出す（`docs/BALANCE.md` に貼るための数字）', () => {
    const lines = stats.map(
      (s) =>
        `  ${s.phase.name.padEnd(6, '　')} ${Math.round(s.phase.fromTick / TICK_RATE / 60)}〜` +
        `${Math.round(s.phase.toTick / TICK_RATE / 60)} 分: 戦域 最大 ${s.maxFronts} 本 / ` +
        `立っていた時間 ${Math.round(s.activeRatio * 100)}% / 区間の終わりの時代 ${s.endAge}`,
    );
    console.log(`[T-M18-01] AI 段階 4 / 2 人戦 / 30 分\n${lines.join('\n')}`);
    expect(stats.length).toBeGreaterThan(0);
  });

  it('立ち上げ（0〜5 分）は戦域が立たない（`07§2`「村人だけを増やす時間」）', () => {
    const buildup = stats.find((s) => s.phase.id === 'buildup');
    expect(buildup, 'config.matchPhases に buildup がない').toBeDefined();
    expect(buildup!.maxFronts, '立ち上げから戦域が立っている').toBe(0);
  });

  it('30 分のうちどこかで戦域が立つ（1 本も立たないなら試合になっていない）', () => {
    const most = stats.reduce((a, s) => (s.maxFronts > a ? s.maxFronts : a), 0);
    expect(most, '30 分回しても戦域が 1 本も立たない').toBeGreaterThan(0);
  });

  it('区間は隙間なく続いている（`config.matchPhases` の定義の検算）', () => {
    for (let k = 1; k < stats.length; k++) {
      expect(stats[k]!.phase.fromTick, `${stats[k]!.phase.name} の始まりが前の区間の終わりと違う`).toBe(
        stats[k - 1]!.phase.toTick,
      );
    }
  });

  it('全区間の合計が試合の長さ（30 分）と一致する', () => {
    const total = stats[stats.length - 1]!.phase.toTick;
    expect(total).toBe(45000);
  });
}, 300000);
