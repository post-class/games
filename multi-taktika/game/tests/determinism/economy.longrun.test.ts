/**
 * 経済が「試合の最後まで回り続ける」ことの回帰テスト。
 *
 * ■ なぜ必要か
 * ここに書いた 3 つのバグは、**単体テストが全部緑のまま**同時に潜んでいた。
 * どれも「短時間なら動く」ので、単体テストでは見えなかった:
 *
 *  1. **単独で歩いている兵・村人が「孤立」で士気 0 になり退却する。**
 *     敵が 1 体もいない平地でも起きる。退却後は指示を失って戻らないので、
 *     村人は運搬の途中で固まり、軍は永久に接触しない（AI の戦域が 0 本になっていた）。
 *  2. **4×4 の町の中心には構造的に到達できない。**
 *     到達判定が「中心との距離 1 マス以内」だったので、縁に立っても届かない。
 *     満載の村人が搬入点の 1.6 マス手前で止まり、資源が凍る。
 *  3. **森 1 本を採り切った村人が次の森を探さない。**
 *     拠点まわりに 18 本あるのに、木材が 300 で止まる。
 *
 * だから「30 分回して**後半も**資源が増えているか」を見る。
 * 「開始値より増えたか」だけでは 1〜3 のどれも検出できない（序盤は動くので）。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { fxToInt, FX_ONE, fxFromInt } from '@/sim/core/fx';
import { stepWorld } from '@/sim/index';
import { applyCommands } from '@/sim/command';
import { createMatch } from '@/sim/setup';
import { spawnEntity, UnitState } from '@/sim/core/entity';
import { unitDefById } from '@/sim/core/defs';
import { MATCH_LENGTH_TICKS } from '@/sim/core/config';

function play(ticks: number) {
  const { world: w } = createMatch({
    seed: 20260809,
    playerCount: 2,
    civs: ['yamato', 'mongol'],
    mapType: 'plain',
  });
  const samples: number[][] = [];
  for (let t = 0; t < ticks; t++) {
    stepWorld(w, []);
    if (w.tick % 5000 === 0) samples.push(Array.from(w.players[0]!.resources, (v) => fxToInt(v)));
  }
  return { w, samples };
}

describe('経済は試合の最後まで回り続ける', () => {
  const { w, samples } = play(MATCH_LENGTH_TICKS);

  it('30 分（45,000 tick）を回し切る', () => {
    expect(w.tick).toBe(MATCH_LENGTH_TICKS);
    expect(samples.length).toBeGreaterThan(5);
  });

  it('**後半でも**資源が増えている（序盤だけ動いて止まるのを検出する）', () => {
    const first = samples[0]!;
    const mid = samples[Math.floor(samples.length / 2)]!;
    const last = samples[samples.length - 1]!;
    const total = (r: number[]): number => r.reduce((a, b) => a + b, 0);

    // 前半で増えている
    expect(total(mid), `前半で増えていない: ${first} → ${mid}`).toBeGreaterThan(total(first));
    // **後半でも増えている**（ここが凍っていた）
    expect(total(last), `後半で止まっている: ${mid} → ${last}`).toBeGreaterThan(total(mid));
  });

  it('村人が最後まで働いている（Idle のまま固まらない）', () => {
    const e = w.entities;
    let working = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1 || e.kind[i] !== EntityKind.Unit || e.owner[i] !== 0) continue;
      if (e.state[i] === UnitState.Gathering || e.state[i] === UnitState.Hauling) working++;
    }
    expect(working, '30 分後に働いている村人が 1 人もいない').toBeGreaterThan(0);
  });
});

describe('敵がいなければ士気は下がらない（`07§6` は戦闘の仕組み）', () => {
  it('単独の兵が 30 マス先の目標まで歩き切る', () => {
    const { world: w } = createMatch({
      seed: 1,
      playerCount: 2,
      civs: ['yamato', 'mongol'],
      mapType: 'plain',
    });
    const def = unitDefById('clubman');
    const sx = w.map.starts[0]!;
    const sy = w.map.starts[1]!;
    const id = spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner: 0,
      typeId: def.index,
      x: sx,
      y: sy,
      hpMax: def.hp,
      morale: FX_ONE,
    });
    const i = id & 0xffff;
    const goalX = Math.floor(sx / FX_ONE) + 30;
    const goalY = Math.floor(sy / FX_ONE);
    applyCommands(w, [
      { t: 'moveUnits', p: 0, units: [id], x: fxFromInt(goalX), y: fxFromInt(goalY), queued: false },
    ]);

    for (let t = 0; t < 2000; t++) stepWorld(w, []);

    // 目標に着いている（以前は 17 マス進んで退却し、出発点付近へ戻っていた）
    expect(w.entities.x[i]! / FX_ONE).toBeGreaterThan(goalX - 2);
    // 敵が 1 体もいないので士気は満タンのまま
    expect(w.entities.morale[i]).toBe(FX_ONE);
    expect(w.entities.state[i]).not.toBe(UnitState.Routed);
  });
});
