/**
 * 「どの出来事でどの音が鳴るか」の検算（`audio/cues.ts`）。
 *
 * ■ なぜこのテストが必要か
 * `sfx.ts`（枠）と `synth.ts`（音）が揃っていても、**鳴らす場所が無ければ無音**。
 * 実際に `grep -rn "sfx.play" src` は長いあいだ **1 件**しか返さず、
 * 10 枠のうち `warning` だけが鳴る状態だった。
 * 「枠がある」「音が作れる」は「鳴る」を意味しない ―― 効果の未結線
 * （`docs/ISSUES.md` の重大項目）とまったく同じ形の見落としだった。
 *
 * ここでは World を直接いじって「出来事」を作り、期待した名前が返るかを見る。
 * 音そのものは鳴らさない（`AudioCues` は名前を返すだけ）。
 */

import { describe, expect, it } from 'vitest';
import { createMatch } from '@/sim';
import { AudioCues } from '@/audio/cues';
import { EntityKind } from '@/shared/types';
import { PROGRESS_DONE, isAliveIndex, markDeadIndex } from '@/sim/core/entity';
import { MAX_FRONTS } from '@/sim/core/world';
import type { World } from '@/sim/core/world';

function newWorld(): World {
  return createMatch({ seed: 5, playerCount: 2, civs: ['yamato', 'mongol'] }).world;
}

/**
 * 戦域は**配列の位置で持ち主が決まる**（`fronts[owner * MAX_FRONTS + (slot - 1)]`）。
 * `owner` は `readonly` なので、席を変えたいときは**添字を変える**。
 */
function frontOf(w: World, owner: number, slot = 1): World['fronts'][number] {
  const f = w.fronts[owner * MAX_FRONTS + (slot - 1)];
  if (f === undefined) throw new Error('戦域の添字が範囲外');
  return f;
}

/** 最初の 1 回で基準を作る（開始時の状態は「変化」ではない）。 */
function primed(w: World): AudioCues {
  const cues = new AudioCues();
  expect(cues.step(w, 0), '最初の呼び出しで音が鳴っている').toEqual([]);
  return cues;
}

describe('出来事 → 効果音', () => {
  it('最初のフレームでは何も鳴らない（開始時の建物で完成音が並ばない）', () => {
    const w = newWorld();
    const cues = new AudioCues();
    expect(cues.step(w, 0)).toEqual([]);
  });

  it('変化が無ければ何も鳴らない', () => {
    const w = newWorld();
    const cues = primed(w);
    expect(cues.step(w, 0)).toEqual([]);
  });

  it('自分の戦域が立つと front_open、畳まれると front_close', () => {
    const w = newWorld();
    const cues = primed(w);
    const f = frontOf(w, 0);
    f.active = true;
    expect(cues.step(w, 0)).toContain('front_open');
    f.active = false;
    expect(cues.step(w, 0)).toContain('front_close');
  });

  it('**相手の**戦域では鳴らない（視界の外の出来事が耳から漏れない）', () => {
    const w = newWorld();
    const cues = primed(w);
    const f = frontOf(w, 1); // 相手（席 1）の戦域
    f.active = true;
    expect(cues.step(w, 0)).toEqual([]);
  });

  it('令が変わると order_arrive（出した瞬間ではなく載った瞬間）', () => {
    const w = newWorld();
    const f = frontOf(w, 0);
    f.active = true;
    f.order = null;
    const cues = primed(w);
    f.order = 'charge'; // 上位の令（`orders.json`）
    expect(cues.step(w, 0)).toContain('order_arrive');
  });

  it('令が外れただけでは鳴らない（届いていないので）', () => {
    const w = newWorld();
    const f = frontOf(w, 0);
    f.active = true;
    f.order = 'charge'; // 上位の令（`orders.json`）
    const cues = primed(w);
    f.order = null;
    expect(cues.step(w, 0)).not.toContain('order_arrive');
  });

  it('下位の令が届いても鳴る（上位・下位のどちらでも「届いた」）', () => {
    const w = newWorld();
    const f = frontOf(w, 0);
    f.active = true;
    const cues = primed(w);
    f.orderLower = 'raid'; // 下位の令（`orders.json`）
    expect(cues.step(w, 0)).toContain('order_arrive');
  });

  it('時代が進むと age_up', () => {
    const w = newWorld();
    const cues = primed(w);
    w.players[0]!.age += 1;
    expect(cues.step(w, 0)).toContain('age_up');
  });

  it('人口が増えると unit_ready、減っても鳴らない', () => {
    const w = newWorld();
    const cues = primed(w);
    w.players[0]!.pop += 1;
    expect(cues.step(w, 0)).toContain('unit_ready');
    w.players[0]!.pop -= 1;
    expect(cues.step(w, 0)).not.toContain('unit_ready');
  });

  it('自軍の建物が完成すると build_done、失うと building_lost', () => {
    const w = newWorld();
    const e = w.entities;
    // 建てかけの建物を 1 つ作る（`buildProgress` を未完成にする）
    let idx = -1;
    for (let i = 0; i < e.highWater; i++) {
      if (isAliveIndex(e, i) && e.owner[i] === 0 && e.kind[i] === EntityKind.Building) {
        idx = i;
        break;
      }
    }
    expect(idx).toBeGreaterThanOrEqual(0);
    e.buildProgress[idx] = 0; // 建てかけに戻す
    const cues = primed(w);
    e.buildProgress[idx] = PROGRESS_DONE; // 完成した
    expect(cues.step(w, 0)).toContain('build_done');
    markDeadIndex(e, idx); // 壊された
    expect(cues.step(w, 0)).toContain('building_lost');
  });

  it('建てかけの建物は数えない（置いた瞬間に完成音が鳴らない）', () => {
    const w = newWorld();
    const cues = primed(w);
    const e = w.entities;
    for (let i = 0; i < e.highWater; i++) {
      if (isAliveIndex(e, i) && e.owner[i] === 0 && e.kind[i] === EntityKind.Building) {
        e.buildProgress[i] = 1; // 建てかけ
        break;
      }
    }
    expect(cues.step(w, 0)).not.toContain('build_done');
  });

  it('決着すると match_end（1 度だけ）', () => {
    const w = newWorld();
    const cues = primed(w);
    w.gameOver = true;
    expect(cues.step(w, 0)).toContain('match_end');
    expect(cues.step(w, 0)).not.toContain('match_end');
  });

  it('試合を作り直したら基準もやり直す（前の試合との差で鳴らない）', () => {
    const a = newWorld();
    const cues = primed(a);
    a.players[0]!.age = 3;
    cues.step(a, 0);
    // 別の World（新しい試合）に切り替わったら、その 1 回目は無音
    const b = newWorld();
    expect(cues.step(b, 0), '別の試合との差分で音が鳴っている').toEqual([]);
  });

  it('reset() で基準を捨てる', () => {
    const w = newWorld();
    const cues = primed(w);
    cues.reset();
    w.players[0]!.age += 1;
    expect(cues.step(w, 0)).toEqual([]);
  });

  it('World を書き換えない（音は試合に影響しない）', () => {
    const w = newWorld();
    const before = JSON.stringify({
      tick: w.tick,
      age: w.players[0]!.age,
      pop: w.players[0]!.pop,
      fronts: w.fronts.map((f) => [f.active, f.order, f.orderLower]),
    });
    const cues = new AudioCues();
    cues.step(w, 0);
    cues.step(w, 0);
    const after = JSON.stringify({
      tick: w.tick,
      age: w.players[0]!.age,
      pop: w.players[0]!.pop,
      fronts: w.fronts.map((f) => [f.active, f.order, f.orderLower]),
    });
    expect(after).toBe(before);
  });
});
