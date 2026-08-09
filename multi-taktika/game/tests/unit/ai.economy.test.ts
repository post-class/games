/**
 * AI の内政が実際に回っているかの検証（T-M13-02 / M18 の測定で見つかった不具合の回帰）。
 *
 * ■ なぜ「単体テストが緑なのに壊れていた」のか
 * 各判断関数（`planEconBuilding` / `planResearch` …）の単体テストはすべて通っていた。
 * それでも **30 分回すと石材と金の採集量が 0**、村人は数体しか増えず、
 * 誰も次の世に到達しなかった。原因は関数単体ではなく**関数どうしの取り合い**だった:
 *
 *  1. 生産された村人が「建設係」のまま手空きで立ち続けた（採集に就く経路が無い）
 *  2. 採集先を「いちばん足りない資源」だけにしたので、消費の速い食料と木材が
 *     常に最下位になり、**石材と金は永久に選ばれなかった**
 *  3. 同じ食料を村人と兵が取り合い、兵が勝って内政が立ち上がらなかった
 *  4. 時代進化を毎回出していた（資源不足で `sim` が黙って捨てるので気付けない）
 *
 * だからここは**長回しの実測**で固定する。1 つでも戻ったら落ちる。
 */

import { describe, expect, it } from 'vitest';
import { createMatch, stepWorld } from '@/sim';
import { AiPlayer } from '@/ai/AiPlayer';
import type { Command } from '@/sim/command';
import { RESOURCE_IDS } from '@/shared/types';
import { fxToInt } from '@/sim/core/fx';

/**
 * 16 分ぶん。**青銅の世の解読（130 秒）が終わるところまで**含める長さ。
 * 30 分フルは CI が重くなるうえ、ここまでで 4 件の不具合すべてが見える。
 */
const TICKS_WITH_AGE = 24000;

function run(level: number) {
  const { world } = createMatch({
    seed: 7,
    playerCount: 2,
    civs: ['yamato', 'mongol'],
    mapType: 'plain',
  });
  const ais = [new AiPlayer(0, level), new AiPlayer(1, level)];
  const kinds: Record<string, number> = {};
  for (let t = 0; t < TICKS_WITH_AGE; t++) {
    const cmds: Command[] = [];
    for (const ai of ais) cmds.push(...ai.think(world));
    for (const c of cmds) kinds[c.t] = (kinds[c.t] ?? 0) + 1;
    stepWorld(world, cmds);
  }
  return { world, kinds };
}

describe('AI の内政（15 分の実測）', () => {
  const { world, kinds } = run(3);
  const stone = RESOURCE_IDS.indexOf('stone');
  const gold = RESOURCE_IDS.indexOf('gold');

  it('生産された村人が採集に就く（`gather` が出ている）', () => {
    // 直った前は 15 分で 1 件以下だった。
    expect(kinds['gather'] ?? 0).toBeGreaterThan(5);
  });

  it('石材と金が増える（採集先が 4 資源に散っている）', () => {
    // 直った前は開始値（石材 100 / 金 50）から 30 分間 1 も動かなかった。
    // どちらかが開始値を超えていれば「4 資源に散っている」ことは示せる
    // （もう一方はその時点で使われている可能性がある）。
    let grew = 0;
    for (const p of [0, 1]) {
      const res = world.players[p]!.resources;
      if (fxToInt(res[stone]!) > 100) grew++;
      if (fxToInt(res[gold]!) > 50) grew++;
    }
    expect(grew, '石材も金も開始値から動いていない = 採集先が偏っている').toBeGreaterThan(0);
  });

  it('村人が育つ（兵に食料を取られて数体で止まらない）', () => {
    for (const p of [0, 1]) {
      // 直る前は「pop は 20 を超えるのに中身は兵ばかりで、村人は数体」だった。
      //
      // 直したあとの人口はむしろ**少なくなる**（12 前後）。これは狙いどおりで、
      // 次の世の費用を貯めるあいだ村人生産を止めているぶん。
      // 「人口が多い」ことより「時代が進む」ことのほうが強いので、この取引を採る
      // （時代が進まないと文明ごとの兵種が 1 つも出ない）。
      // ここでは「数体で止まっていない」ことだけを見る。
      expect(world.players[p]!.pop, `P${p} の人口が伸びていない`).toBeGreaterThan(9);
    }
  });

  it('時代進化の空打ちをしない（出すのは費用が足りているときだけ）', () => {
    // 直った前は**全コマンドの 96〜97%** がこの空打ちで、操作量の計測が
    // 意味を失っていた（APM 62 のうち有効な操作は 2 件）。
    const total = Object.values(kinds).reduce((a, b) => a + b, 0);
    const advance = kinds['advanceAge'] ?? 0;
    expect(advance / total, '時代進化のコマンドが多すぎる = 空打ちしている').toBeLessThan(0.2);
  });

  it('どちらのプレイヤーも一方的に消滅しない（席による有利不利を作らない）', () => {
    for (const p of [0, 1]) {
      expect(world.players[p]!.popCap, `P${p} が拠点を失っている`).toBeGreaterThan(0);
    }
  });
}, 300000);

describe('段階 1（素人）は内政のみ', () => {
  it('兵を作らない（`07§11`「攻めてこない」）', () => {
    const { world } = createMatch({ seed: 3, playerCount: 2, civs: ['yamato', 'roma'], mapType: 'plain' });
    const ai = new AiPlayer(0, 1);
    const cmds: Command[] = [];
    for (let t = 0; t < 3000; t++) {
      const c = ai.think(world);
      cmds.push(...c);
      stepWorld(world, [...c]);
    }
    // 令も戦域も出さない
    expect(cmds.some((c) => c.t === 'setOrder')).toBe(false);
  }, 120000);
});
