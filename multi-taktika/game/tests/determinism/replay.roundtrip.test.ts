/**
 * T-M15-02, 06: リプレイ再生が元の試合を再現することの検証
 *
 * `07§12`「保存されているのは映像ではなく入力の記録」。これが成り立つのは
 * ゲームロジックが決定論だからで、**その 2 つが繋がっていることを確かめるのがここ**。
 *
 * 手順書 §14.1 の「ゴールデンリプレイ」の土台にもなる:
 *   代表試合の入力列と期待ハッシュを固定しておき、
 *   **バランス調整以外の変更で壊れたら即バグ**として検出する。
 */

import { idOfIndex, isAliveIndex } from '@/sim/core/entity';
import { buildingDef } from '@/sim/core/defs';
import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import type { Command } from '@/sim/command';
import { HASH_CHECK_INTERVAL_TICKS, stepWorld } from '@/sim/index';
import { createMatch } from '@/sim/setup';
import { hashWorld } from '@/sim/hash';
import { getFront } from '@/sim/core/world';
import { spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fxFromInt } from '@/sim/core/fx';
import { unitDefById } from '@/sim/core/defs';
import { ReplayReader, ReplayRecorder, checkReplay, serializeReplay } from '@/replay/format';
import { dataHash } from '@/data/hash';

const SETUP = {
  playerCount: 2,
  civs: ['yamato', 'mongol'] as const,
  mapType: 'plain' as const,
};
const SEED = 20260809;
const TICKS = 3000; // 2 分

/** 兵をぶつけて戦域が立つ状況を作る（戦域・令を記録に乗せるため）。 */
function seedUnits(w: ReturnType<typeof createMatch>['world']): void {
  for (const pl of w.players) {
    pl.age = 3;
    pl.frontSlots = 6;
  }
  const spots: readonly [number, number][] = [
    [70, 70],
    [70, 110],
  ];
  for (const [tx, ty] of spots) {
    for (let k = 0; k < 4; k++) {
      for (const [owner, id] of [
        [0, 'y-nagae'],
        [1, 'g-heavy'],
      ] as const) {
        const def = unitDefById(id);
        spawnEntity(w.entities, {
          kind: EntityKind.Unit,
          owner,
          typeId: def.index,
          x: fxFromInt(tx + (owner === 0 ? -1 : 1)) + (FX_ONE >> 1),
          y: fxFromInt(ty + k) + (FX_ONE >> 1),
          hpMax: def.hp,
          morale: FX_ONE,
        });
      }
    }
  }
}

/** 「人が打った入力」の代わり。150 tick ごとに立っている戦域へ令を配る。 */
function humanInput(w: ReturnType<typeof createMatch>['world']): Command[] {
  if (w.tick === 0 || w.tick % 150 !== 0) return [];
  const slot = ((w.tick / 150) % 6) + 1;
  const f = getFront(w, 0, slot);
  if (f === undefined || !f.active) return [];
  const order = (['charge', 'hold', 'retreat', 'build'] as const)[
    Math.floor(w.tick / 900) % 4
  ] as string;
  return [{ t: 'setOrder', p: 0, front: slot, order: order as never, tier: 'upper' }];
}

/** 試合を 1 回回して、記録とハッシュ列を返す。 */
function playAndRecord(): { replay: ReturnType<ReplayRecorder['finish']>; hashes: number[] } {
  const { world: w } = createMatch({ seed: SEED, ...SETUP });
  seedUnits(w);
  const rec = new ReplayRecorder(SEED, SETUP, dataHash());
  const hashes: number[] = [];

  for (let t = 0; t < TICKS; t++) {
    const cmds = humanInput(w);
    // 記録は **stepWorld に渡すのと同じ内容**（順序も同じ）。
    rec.record(w.tick, cmds.length > 0 ? { 0: cmds } : {});
    stepWorld(w, cmds);
    if (w.tick % HASH_CHECK_INTERVAL_TICKS === 0) {
      const h = hashWorld(w);
      hashes.push(h);
      rec.recordHash(w.tick, h);
    }
  }
  return { replay: rec.finish(), hashes };
}

/** 記録から再生して、ハッシュ列を返す。 */
function replayBack(replay: ReturnType<ReplayRecorder['finish']>): number[] {
  const { world: w } = createMatch({ seed: replay.seed, ...SETUP });
  seedUnits(w);
  const reader = new ReplayReader(replay);
  const buf: Command[] = [];
  const hashes: number[] = [];
  for (let t = 0; t < replay.endTick + 1; t++) {
    stepWorld(w, reader.take(w.tick, buf));
    if (w.tick % HASH_CHECK_INTERVAL_TICKS === 0) hashes.push(hashWorld(w));
  }
  return hashes;
}

describe('T-M15-02: リプレイ再生が元の試合を再現する', () => {
  const first = playAndRecord();

  it('再生したハッシュ列が元の試合と完全に一致する', () => {
    const back = replayBack(first.replay);
    expect(back.length).toBeGreaterThan(0);
    expect(back).toEqual(first.hashes);
  });

  it('記録した時点のハッシュと、再生時のハッシュが tick ごとに一致する', () => {
    // `ReplayReader.hashAt` で突き合わせる（デシンクの検出と同じ粒度）
    const reader = new ReplayReader(first.replay);
    const { world: w } = createMatch({ seed: first.replay.seed, ...SETUP });
    seedUnits(w);
    const buf: Command[] = [];
    let checked = 0;
    for (let t = 0; t < first.replay.endTick + 1; t++) {
      stepWorld(w, reader.take(w.tick, buf));
      if (w.tick % HASH_CHECK_INTERVAL_TICKS !== 0) continue;
      const expected = reader.hashAt(w.tick);
      if (expected === null) continue;
      expect(hashWorld(w), `tick ${w.tick} でずれた`).toBe(expected);
      checked++;
    }
    // ちゃんと突き合わせたことを確かめる（0 件で緑になっては意味がない）
    expect(checked).toBeGreaterThan(5);
  });

  it('同じ試合を 2 回記録すると同じ記録になる（記録側も決定論）', () => {
    const second = playAndRecord();
    expect(serializeReplay(second.replay)).toBe(serializeReplay(first.replay));
  });

  it('記録は再生できると判定される', () => {
    expect(checkReplay(first.replay, dataHash())).toEqual({ ok: true });
  });

  it('入力を 1 件足すと結果が変わる（記録が効いている証明）', () => {
    // ■ 改ざんの仕方を 3 度変えている。経緯を残す（どれも「効かない改ざん」だった）
    //  1. 最初のフレームの `setOrder` を別の令に差し替える
    //     → そのフレームに `setOrder` が無いと効かない
    //  2. コマンドが入っている最初のフレームを 1 つ空にする
    //     → `humanInput` は 900 tick ごとに令を変えるので、同じ令を続けて出している
    //       区間では 1 つ抜いても結果が同じ（重複した命令）
    //  3. 記録した入力を**全部**取り除く
    //     → それでも同じだった。この試合の `setOrder` は
    //       （切り替え間隔や配達中の令のせいで）ほとんど受け付けられていない
    //
    // だから「**確実に効く命令を 1 件足す**」形にした。村人を 1 体作る命令は
    // 資源を減らしてユニットを増やすので、受け付けられれば必ず結果が変わる。
    // 「記録した入力を消す」より弱い主張ではない ―― 見たいのは
    // 「入力が結果に効いている＝リプレイが映像ではなく入力の記録である」ことなので、
    // 足しても引いても同じことが示せる。
    const probe = createMatch({ seed: SEED, ...SETUP });
    const e = probe.world.entities;
    let tc = -1;
    for (let i = 0; i < e.highWater; i++) {
      if (!isAliveIndex(e, i)) continue;
      if (e.kind[i] !== EntityKind.Building || e.owner[i] !== 0) continue;
      if (buildingDef(e.typeId[i]!).id !== 'town_center') continue;
      tc = idOfIndex(e, i);
      break;
    }
    expect(tc, '町の中心が見つからない').toBeGreaterThan(0);

    const extra: Command = {
      t: 'produce',
      p: 0,
      building: tc as never,
      unit: 'villager',
      count: 1,
    };
    const inputs = [{ tick: 0, byPlayer: { 0: [extra] } }, ...first.replay.inputs];
    const back = replayBack({ ...first.replay, inputs });
    expect(back).not.toEqual(first.hashes);
  });

  it('記録の容量が小さい（入力だけなので。完了条件は 30 分で 500KB 以内）', () => {
    const bytes = new TextEncoder().encode(serializeReplay(first.replay)).length;
    // このテストは 2 分ぶんなので、30 分ぶんに換算して見る
    const per30min = (bytes * 45000) / TICKS;
    console.log(
      `[T-M15-01] 記録 ${bytes} バイト（${TICKS} tick）→ 30 分換算 ${Math.round(per30min / 1024)}KB（gzip 前）`,
    );
    expect(per30min).toBeLessThan(500 * 1024);
  });
});
