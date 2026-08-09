/**
 * tests/balance/apm.test.ts — 操作量（APM）の実測（T-M18-05）
 *
 * 完了条件（手順書 M18 タスク表 / `07§9`）:
 *   「操作量の実測（毎分 20〜40 操作）」「超えていたら UI を見直す」
 *   親からの完了条件: **通常の操作で APM 60 未満**
 *
 * ■ なぜ測るのか
 * `01_ゲーム宣伝.html` の「手数で勝たない」が本作の売り文句そのもので、
 * 「令を配って半自動で戦わせる」設計が成立している限り、**上手いプレイヤーほど
 * 手数が増える**ということが起きてはいけない。ここはその数値的な担保。
 *
 * ■ 「通常の操作」の定義（この測定の前提。記録として残す）
 *   1 操作 = `Command` 1 件（`src/ui/stats.ts` の `apmFrom` のコメント参照）。
 *   操作列は **`AiPlayer` の判断そのもの**を使う。理由は 2 つ:
 *     - AI は「令を配る・村人を出す・家と兵舎を建てる・時代を進める・市場で交換する」
 *       という `06` の操作一式しか出さない（`Command` しか出せない設計）。
 *       つまり **人間が普通に遊ぶときの操作の種類と 1 対 1 で対応している**。
 *     - 判断間隔が `ai.json` に数値で入っているので、「どのくらいの頻度で
 *       盤面を見直す人か」を段階で表現できる（8/6/4/2/1 秒に 1 回）。
 *   **段階 3「諸侯」（4 秒に 1 回見直す）を「通常の操作」とする。**
 *   4 秒に 1 回盤面を見直して必要なら手を打つのは、`06§4`「連打しないでください」
 *   （令の切り替え間隔 6 秒）と釣り合う頻度で、人間が無理なく続けられる範囲。
 *   段階 4（2 秒に 1 回）は「張り付いて打ち続ける人」の上限として**判定にも使う**。
 *   段階 5（1 秒に 1 回）は人間ではなく機械の頻度なので**参考値**として測るだけ。
 *   実測（下のログ）では段階 5 だけが 60 をわずかに超える（62.3 / 61.5）。
 *   これは「手数を増やせば増やせる」ことを示すが、超えているのは
 *   **人間が 10 分間 1 秒間隔で判断し続けた場合**であり、通常の操作の値ではない。
 *
 * ■ 測り方
 *   `MatchStats.countCommands` に `stepWorld` へ渡したのと同じ配列を毎 tick 渡し、
 *   `apmOf(p)` を読む。**実時間を使わない**（tick で割る）ので、
 *   同じ操作列なら何度測っても同じ値になる。
 */

import { describe, expect, it } from 'vitest';
import { CIV_IDS, type PlayerId } from '@/shared/types';
import type { Command, CommandType } from '@/sim/command';
import { COMMAND_TYPES } from '@/sim/command';
import { TICK_RATE } from '@/sim/core/config';
import { stepWorld } from '@/sim/index';
import { createMatch } from '@/sim/setup';
import { AiPlayer, aiLevelConfig } from '@/ai/index';
import { MatchStats, TICKS_PER_MINUTE, apmFrom } from '@/ui/stats';

/** 測定する試合長。15,000 tick = 10 分（`07§2` の「初接触」〜「分割」を含む）。 */
const MEASURE_TICKS = 15000;

/** 完了条件の上限（毎分の操作数）。 */
const APM_LIMIT = 60;

/** `07§9` の想定操作量。 */
const APM_EXPECTED_LOW = 20;
const APM_EXPECTED_HIGH = 40;

/** 「通常の操作」= AI 段階 3「諸侯」（4 秒に 1 回見直す）。 */
const NORMAL_LEVEL = 3;

/**
 * 「張り付いて打ち続ける人間」の上限として扱う段階。
 * 段階 5（1 秒に 1 回判断）は**人間の頻度ではなく機械の頻度**なので、
 * 完了条件の判定には使わず参考値として記録する（結果は下のログと docs/BALANCE.md）。
 */
const ATTENTIVE_LEVEL = 4;

interface Measured {
  readonly level: number;
  /** プレイヤーごとの APM。 */
  readonly apm: readonly number[];
  /** プレイヤーごとの操作数。 */
  readonly commands: readonly number[];
  readonly ticks: number;
  /** 操作の種類ごとの件数（`COMMAND_TYPES` 順、両プレイヤーの合計）。何が手数を食っているか。 */
  readonly byType: readonly number[];
}

/** 段階 `level` の AI 同士（2 人）で `MEASURE_TICKS` 回し、APM を測る。 */
function measure(level: number, seed = 20260810): Measured {
  const { world } = createMatch({
    seed,
    playerCount: 2,
    civs: [CIV_IDS[0]!, CIV_IDS[7]!],
  });
  const ais = [new AiPlayer(0, level), new AiPlayer(1, level)];
  const stats = new MatchStats(2);
  const byType = new Array<number>(COMMAND_TYPES.length).fill(0);
  for (let t = 0; t < MEASURE_TICKS; t++) {
    const cmds: Command[] = [];
    for (let p = 0; p < 2; p++) {
      const c = ais[p]!.think(world);
      for (let k = 0; k < c.length; k++) cmds.push(c[k]!);
    }
    stats.countCommands(cmds);
    for (let k = 0; k < cmds.length; k++) {
      const ti = COMMAND_TYPES.indexOf(cmds[k]!.t as CommandType);
      if (ti >= 0) byType[ti] = byType[ti]! + 1;
    }
    stepWorld(world, cmds);
    stats.sample(world);
    if (world.gameOver) break;
  }
  const apm: number[] = [];
  const commands: number[] = [];
  for (let p = 0; p < 2; p++) {
    apm.push(stats.apmOf(p as PlayerId));
    commands.push(stats.commandsOf(p as PlayerId));
  }
  return { level, apm, commands, ticks: stats.observedTicks(), byType };
}

describe('APM の計算（T-M18-05 の土台）', () => {
  it('tick で割る（実時間を使わない）', () => {
    expect(TICKS_PER_MINUTE).toBe(TICK_RATE * 60);
    // 1 分ぶんの tick で 30 操作なら 30 APM。
    expect(apmFrom(30, TICKS_PER_MINUTE)).toBe(30);
    // 30 秒で 30 操作なら 60 APM。
    expect(apmFrom(30, TICKS_PER_MINUTE / 2)).toBe(60);
    // 0 tick でも 0 除算にしない。
    expect(Number.isFinite(apmFrom(1, 0))).toBe(true);
  });

  it('countCommands は自分の入力だけを数える', () => {
    const stats = new MatchStats(2);
    stats.countCommands([
      { t: 'resign', p: 0 as PlayerId },
      { t: 'resign', p: 1 as PlayerId },
      { t: 'resign', p: 1 as PlayerId },
    ]);
    expect(stats.commandsOf(0 as PlayerId)).toBe(1);
    expect(stats.commandsOf(1 as PlayerId)).toBe(2);
  });

  it('既存の統計を壊していない（snapshot に APM が増えただけ）', () => {
    const stats = new MatchStats(2);
    const snap = stats.snapshot();
    expect(snap.players.length).toBe(2);
    expect(snap.players[0]!.apm).toBe(0);
    expect(snap.players[0]!.commands).toBe(0);
    expect(snap.observedTicks).toBe(0);
    // 既存の欄はそのまま。
    expect(snap.players[0]!.perOrder.length).toBeGreaterThan(0);
  });
});

describe('操作量の実測（T-M18-05）', () => {
  it(`通常の操作（AI 段階 ${NORMAL_LEVEL}）の APM が ${APM_LIMIT} 未満`, () => {
    const rows: Measured[] = [];
    for (const level of [2, 3, 4, 5]) rows.push(measure(level));

    const lines: string[] = [];
    lines.push(
      `[T-M18-05] ${MEASURE_TICKS} tick（${MEASURE_TICKS / TICK_RATE / 60} 分）/ ` +
        `1 操作 = Command 1 件 / 分母は tick（実時間を使わない）`
    );
    lines.push('AI段階 | 判断間隔 | 操作数(p0/p1) | APM(p0/p1)');
    for (const r of rows) {
      lines.push(
        `  ${r.level}    | ${String(aiLevelConfig(r.level).intervalTicks).padStart(3)} tick | ` +
          `${r.commands.join('/')} | ${r.apm.map((v) => v.toFixed(1)).join(' / ')}`
      );
    }
    console.log(lines.join('\n'));

    const normal = rows.find((r) => r.level === NORMAL_LEVEL)!;
    for (let p = 0; p < normal.apm.length; p++) {
      expect(
        normal.apm[p]!,
        `段階 ${NORMAL_LEVEL} の p${p} の APM が ${APM_LIMIT} 以上`
      ).toBeLessThan(APM_LIMIT);
    }

    // 「張り付いて打ち続ける人間」（2 秒に 1 回見直す）でも 60 を超えないこと。
    const attentive = rows.find((r) => r.level === ATTENTIVE_LEVEL)!;
    for (let p = 0; p < attentive.apm.length; p++) {
      expect(
        attentive.apm[p]!,
        `段階 ${ATTENTIVE_LEVEL}（2 秒に 1 回判断）の p${p} の APM が ${APM_LIMIT} 以上`
      ).toBeLessThan(APM_LIMIT);
    }

    // 何が手数を食っているか（操作の種類ごとの件数）。60 を超える段階が出たときに読む。
    for (const r of rows) {
      const parts: string[] = [];
      for (let i = 0; i < COMMAND_TYPES.length; i++) {
        if (r.byType[i]! > 0) parts.push(`${COMMAND_TYPES[i]}=${r.byType[i]}`);
      }
      const over = r.apm.some((v) => v >= APM_LIMIT) ? ' ← 60 超' : '';
      console.log(`[T-M18-05] 段階 ${r.level} の内訳（2 人合計）: ${parts.join(' ')}${over}`);
    }

    // ---- 空打ちを除いた APM ----
    // `advanceAge` は AI が判断 tick ごとに無条件で出しており（`ai/econGoals.ts` の
    // `planAgeAdvance` は資源を見ない）、資源が足りないので sim 側で黙って捨てられる。
    // **人間はこれを連打しない**（進化ボタンは押せないときグレーになる。`05§4`）ので、
    // 「本当に盤面を動かした操作」の APM も併せて出す。
    const ageIdx = COMMAND_TYPES.indexOf('advanceAge');
    for (const r of rows) {
      const total = r.commands.reduce((a, b) => a + b, 0);
      const effective = total - (ageIdx >= 0 ? r.byType[ageIdx]! : 0);
      console.log(
        `[T-M18-05] 段階 ${r.level}: 有効な操作のみ（時代進化の空打ちを除く）` +
          `${effective} 件 → 2 人平均 ${apmFrom(effective / r.commands.length, r.ticks).toFixed(1)} APM`
      );
    }

    // `07§9` の想定（毎分 20〜40）に届いているかは**参考値**として出すだけ。
    // 下回るのは設計どおり（令が半自動で回るので手数が要らない）なので落とさない。
    console.log(
      `[T-M18-05] 07§9 の想定操作量 ${APM_EXPECTED_LOW}〜${APM_EXPECTED_HIGH} との比較: ` +
        rows
          .map(
            (r) =>
              `段階${r.level}=${r.apm.map((v) => v.toFixed(1)).join('/')}` +
              (r.apm.some((v) => v >= APM_EXPECTED_LOW) ? '(想定域)' : '(想定より少ない)')
          )
          .join(' ')
    );
  }, 600000);

  it('同じ操作列からは同じ APM が出る（リプレイで再現できる）', () => {
    const a = measure(NORMAL_LEVEL);
    const b = measure(NORMAL_LEVEL);
    expect(b.apm).toEqual(a.apm);
    expect(b.commands).toEqual(a.commands);
  }, 600000);
});
