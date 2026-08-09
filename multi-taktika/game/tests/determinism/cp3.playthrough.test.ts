/**
 * CP3（実装手順書 §15.2）— 本作の中核が成立していることの通し確認。
 *
 * 手順書 T-M9-11 の完了条件:
 *   「1 人 + AI なしで 30 分、戦域 6 本まで運用。例外なし、60fps 維持、決定論ハッシュ再現」
 *
 * このテストが見るのは **60fps 以外のすべて**。描画（M5）が未実装なので
 * 60fps はここでは測れない。代わりに「シミュレーションが実時間の何倍で回るか」を
 * 記録し、描画に残せる予算を示す。
 *
 * ■ なぜこのテストが必要か
 * M1〜M9 は別々に実装され、単体テストはすべて緑だった。それでも
 *   - マップ上の資源ノードが全部「食料」と解釈される
 *   - 建設中の家が人口上限を提供する
 *   - 採集を命じた村人が働かない
 * といった不整合が、**境界をまたいで初めて**現れた。
 * 「30 分の試合が最後まで壊れずに進むか」は、そういう不整合を最後に捕まえる網。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { entityIndex, isAlive, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fxFromInt, fxToInt } from '@/sim/core/fx';
import { unitDefById } from '@/sim/core/defs';
import { HASH_CHECK_INTERVAL_TICKS, stepWorld } from '@/sim/index';
import { createMatch } from '@/sim/setup';
import { hashWorld } from '@/sim/hash';
import { getFront } from '@/sim/core/world';
import type { World } from '@/sim/core/world';
import type { Command } from '@/sim/command';
import { MATCH_LENGTH_TICKS, TICK_RATE } from '@/sim/core/config';

/** 1 試合 = 30 分 = 45,000 tick。 */
const MATCH_TICKS = MATCH_LENGTH_TICKS;

interface Outcome {
  hashes: number[];
  finalHash: number;
  elapsedMs: number;
  /** 試合中に一度でも同時に立った戦域の最大本数（プレイヤー 0 視点）。 */
  peakFronts: number;
  /** 令が実際に発効した回数。 */
  ordersDelivered: number;
  /** 資源の開始値（プレイヤー 0、単位に直したもの）。 */
  startResources: number[];
  /** 資源の最終値（プレイヤー 0、単位に直したもの）。 */
  finalResources: number[];
  /** 試合中に採集した累計（= 増分の最大値。使った分は戻らないので下限になる）。 */
  peakResources: number[];
  /** 5,000 tick ごとの資源のサンプル（後半でも増えているかを見る）。 */
  samples: number[][];
  world: World;
}

/**
 * 兵をぶつけて戦域を立てる試合を回す。
 *
 * AI（M13）が未実装なので、**戦域が立つ状況をテスト側で作る**:
 *  - 両軍の兵を 6 か所で対峙させる（6 本の戦域が立つ）
 *  - プレイヤー 0 は立った戦域に順番に令を渡す（キーを打つ人の代わり）
 */
function playthrough(seed: number, ticks: number): Outcome {
  const { world: w } = createMatch({
    seed,
    playerCount: 2,
    civs: ['yamato', 'mongol'],
    mapType: 'plain',
  });

  // 帝国の世まで進めて 6 枠使えるようにする（時代進化を待つと 30 分では足りない）。
  for (const pl of w.players) {
    pl.age = 3;
    pl.frontSlots = 6;
  }

  // 6 か所で対峙させる。1 か所につき双方 4 体（発生条件は「それぞれ 3 体以上」）。
  const spots: readonly [number, number][] = [
    [60, 60],
    [60, 100],
    [60, 140],
    [140, 60],
    [140, 100],
    [140, 140],
  ];
  for (const [tx, ty] of spots) {
    for (let k = 0; k < 4; k++) {
      spawnUnit(w, 'y-nagae', 0, tx - 1, ty + k);
      spawnUnit(w, 'g-heavy', 1, tx + 1, ty + k);
    }
  }

  const startResources = Array.from(w.players[0]!.resources, (v) => fxToInt(v));
  const peakResources = startResources.slice();
  const samples: number[][] = [];

  const hashes: number[] = [];
  let peakFronts = 0;
  let ordersDelivered = 0;
  const seenPending = new Set<string>();

  const t0 = performance.now();
  for (let t = 0; t < ticks; t++) {
    stepWorld(w, commandsFor(w, w.tick));

    // 立っている戦域の数と、令が発効した回数を数える
    let active = 0;
    for (let slot = 1; slot <= 6; slot++) {
      const f = getFront(w, 0, slot);
      if (f === undefined || !f.active) continue;
      active++;
      const key = `${slot}:${f.order ?? '-'}:${f.orderLower ?? '-'}`;
      if (f.order !== null && !seenPending.has(key)) {
        seenPending.add(key);
        ordersDelivered++;
      }
    }
    if (active > peakFronts) peakFronts = active;

    // 資源は使うと減るので、最終値だけ見ると「採れていない」と区別できない。
    // 到達した最大値を記録して「増えた」ことを確かめる。
    const res = w.players[0]!.resources;
    for (let k = 0; k < res.length; k++) {
      const v = fxToInt(res[k]!);
      if (v > peakResources[k]!) peakResources[k] = v;
    }

    if (w.tick % HASH_CHECK_INTERVAL_TICKS === 0) hashes.push(hashWorld(w));
    if (w.tick % 5000 === 0) samples.push(Array.from(res, (v) => fxToInt(v)));
  }
  const elapsedMs = performance.now() - t0;

  return {
    hashes,
    finalHash: hashWorld(w),
    elapsedMs,
    peakFronts,
    ordersDelivered,
    startResources,
    finalResources: Array.from(w.players[0]!.resources, (v) => fxToInt(v)),
    peakResources,
    samples,
    world: w,
  };
}

function spawnUnit(w: World, id: string, owner: number, tx: number, ty: number): void {
  const def = unitDefById(id);
  spawnEntity(w.entities, {
    kind: EntityKind.Unit,
    owner,
    typeId: def.index,
    x: fxFromInt(tx) + (FX_ONE >> 1),
    y: fxFromInt(ty) + (FX_ONE >> 1),
    hpMax: def.hp,
    morale: FX_ONE,
  });
}

/**
 * プレイヤー 0 の入力（キーを打つ人の代わり）。
 *
 * 6 秒（150 tick）ごとに、立っている戦域へ順番に令を渡す。
 * `06§1`「Tab → 数字 → Shift+数字」の 3 手を、Command 列として書いたもの。
 */
function commandsFor(w: World, tick: number): readonly Command[] {
  if (tick % 150 !== 0 || tick === 0) return [];
  const slot = ((tick / 150) % 6) + 1;
  const f = getFront(w, 0, slot);
  if (f === undefined || !f.active) return [];
  // 令を巡回させる（突撃 → 死守 → 後退 → 建設）
  const upper = (['charge', 'hold', 'retreat', 'build'] as const)[
    Math.floor(tick / 900) % 4
  ] as string;
  return [{ t: 'setOrder', p: 0, front: slot, order: upper as never, tier: 'upper' }];
}

describe('CP3: 30 分の試合が最後まで壊れずに進む（T-M9-11）', () => {
  const r = playthrough(20260809, MATCH_TICKS);

  it('45,000 tick（30 分）を例外なく回し切る', () => {
    expect(r.world.tick).toBe(MATCH_TICKS);
  });

  it('戦域が実際に立ち、最大 6 本まで同時運用される', () => {
    // 6 か所で対峙させているので 6 本立つはず。
    // 立たないなら発生条件（`07§3`）か移動・戦闘の結線が壊れている。
    expect(r.peakFronts).toBe(6);
  });

  it('令が発効している（押した瞬間ではなく遅延の後に届く）', () => {
    expect(r.ordersDelivered).toBeGreaterThan(0);
  });

  it('村人が働いて資源が増えている（内政の結線が生きている）', () => {
    // **開始資源より増えたこと**を見る。`> 0` だと開始資源だけで自明に通ってしまう。
    // 拠点のそばには 4 資源すべてが等距離で置かれている（`07§13`）ので、
    // どれか 1 つでも増えていなければ採集・搬入・移動・資源ノードの解釈のどこかが壊れている。
    const labels = ['食料', '木材', '石材', '金'];
    const grown = r.peakResources.filter((v, k) => v > r.startResources[k]!);
    expect(
      grown.length,
      `どの資源も増えていない: 開始 ${r.startResources.join('/')} → 最大 ${r.peakResources.join('/')}`,
    ).toBeGreaterThan(0);

    // 食料と木材は序盤から採る資源なので、この 2 つは必ず増えるはず
    for (const k of [0, 1]) {
      expect(
        r.peakResources[k]!,
        `${labels[k]}が増えていない（開始 ${r.startResources[k]} → 最大 ${r.peakResources[k]}）`,
      ).toBeGreaterThan(r.startResources[k]!);
    }
  });

  it('**試合の後半でも**資源が増え続けている（序盤だけ動いて凍るのを検出する）', () => {
    // このテストは以前「最大値 > 開始値」だけを見ていたため、
    // **経済が tick 4000 で凍っていても緑になっていた**（実際に凍っていた）。
    // 30 分の後半で増えていることまで見ないと、止まったことに気づけない。
    const half = Math.floor(r.samples.length / 2);
    const mid = r.samples[half]!;
    const last = r.samples[r.samples.length - 1]!;
    const total = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0);
    expect(
      total(last),
      `後半で資源が増えていない: ${mid.join('/')} → ${last.join('/')}`,
    ).toBeGreaterThan(total(mid));
  });

  it('同じシードで 2 回回すとハッシュ列が完全に一致する（決定論）', () => {
    const a = playthrough(777, 5000);
    const b = playthrough(777, 5000);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.finalHash).toBe(b.finalHash);
  });

  it('シードが違えば結果も違う（テストが常に成功しているわけではない証明）', () => {
    const a = playthrough(1001, 3000);
    const b = playthrough(1002, 3000);
    expect(a.finalHash).not.toBe(b.finalHash);
  });

  it('シミュレーションが実時間より十分速い（描画に予算を残せる）', () => {
    const realtimeMs = (MATCH_TICKS / TICK_RATE) * 1000;
    const speedup = realtimeMs / r.elapsedMs;
    const msPerTick = r.elapsedMs / MATCH_TICKS;
    console.log(
      `[CP3] 30 分の試合を ${(r.elapsedMs / 1000).toFixed(1)} 秒で計算` +
        ` = 実時間の ${speedup.toFixed(0)} 倍速 / ${msPerTick.toFixed(3)}ms per tick`,
    );
    // 1 tick の予算は 40ms。シムがその 1/4 を超えると描画に 30ms 残らない。
    expect(msPerTick).toBeLessThan(10);
    // リプレイ 8 倍速（200 tick/秒）に追いつくこと（`05§14`）
    expect(1000 / msPerTick).toBeGreaterThan(200);
  });

  it('エンティティが壊れていない（生存フラグと index の整合）', () => {
    const e = r.world.entities;
    let alive = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1) continue;
      alive++;
      // 生きているものは必ず EntityId から引き直せる
      const id = (e.generation[i]! << 16) | i;
      expect(isAlive(e, id), `index ${i}`).toBe(true);
      expect(entityIndex(id)).toBe(i);
      // HP は 0 より大きい（死んだものは cleanup で消えている）
      if (e.kind[i] === EntityKind.Unit) expect(e.hp[i]!).toBeGreaterThan(0);
    }
    expect(alive).toBe(e.count);
  });
});
