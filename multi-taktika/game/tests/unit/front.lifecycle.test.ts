/**
 * T-M8-01〜07, 09, 10: 戦域の発生・成長・統合・分裂・消滅・優勢度・視界例外（`07§3` / `07§7`）
 *
 * 「交戦が 2 秒続いた」の判定について:
 *   `frontLifecycle` は候補集合の **HP 合計が前 tick より減ったか**で実ダメージを検出する
 *   （World に候補用の列を足せないため。詳細はシステムのヘッダコメント）。
 *   したがってこのテストでは `combat` を回す代わりに **HP を直接削って被弾を作る**。
 *   「近接しているだけでは戦域が立たない」ことも同じ仕組みで検証している。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import {
  MAX_FRONTS,
  acquireFrontSlot,
  createWorld,
  getFront,
  type World,
} from '@/sim/core/world';
import { PROGRESS_DONE, entityIndex, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fx, fxFromInt, fxToInt } from '@/sim/core/fx';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { rebuildGrid } from '@/sim/core/grid';
import { allocateTerrain } from '@/sim/core/terrain';
import {
  computeAdvantage,
  frontRadiusForMembers,
  frontSpawnEngageTicks,
  isFrontWarning,
  ownFronts,
  visibleEnemyFronts,
} from '@/sim/core/front';
import { frontLifecycle } from '@/sim/systems/frontLifecycle';
import { frontEnrollment } from '@/sim/systems/frontEnrollment';
import { recomputeFrontSlots } from '@/sim/systems/production';

const MAP = 200;

/** 戦闘ユニットの ID（atk > 0 の歩兵）。 */
const SOLDIER = 'clubman';

function makeWorld(playerCount = 2): World {
  const w = createWorld({
    seed: 8,
    playerCount,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 1024,
  });
  allocateTerrain(w.map);
  // 戦域スロットは既定 1 枠。テストごとに必要な枠数を直接与える。
  for (const pl of w.players) pl.frontSlots = MAX_FRONTS;
  return w;
}

function putUnit(w: World, owner: number, tx: number, ty: number, id = SOLDIER): number {
  const d = unitDefById(id);
  return entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: d.index,
      x: fxFromInt(tx),
      y: fxFromInt(ty),
      hpMax: d.hp,
    })
  );
}

/** frontLifecycle → frontEnrollment を 1 tick 分だけ走らせる（stepWorld の 3・4 番）。 */
function tickFronts(w: World, times = 1, onTick?: (t: number) => void): void {
  for (let k = 0; k < times; k++) {
    rebuildGrid(w.grid, w.entities, w.tick);
    if (onTick !== undefined) onTick(w.tick);
    frontLifecycle(w);
    frontEnrollment(w);
    w.tick += 1;
  }
}

/** 全ユニットの HP を 1 ずつ削る（= 実ダメージが発生している状態を作る）。 */
function bleedAll(w: World): void {
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    e.hp[i] = e.hp[i]! - FX_ONE;
  }
}

/** 双方 n 体を (cx, cy) 付近に置く。戻り値は自軍 index の配列。 */
function setupClash(w: World, cx: number, cy: number, n: number): number[] {
  const own: number[] = [];
  for (let k = 0; k < n; k++) own.push(putUnit(w, 0, cx + k, cy));
  for (let k = 0; k < n; k++) putUnit(w, 1, cx + k, cy + 2);
  return own;
}

// ---------------------------------------------------------------- T-M8-01

describe('T-M8-01 スロット管理（時代 + 城 + 旗竿、上限 6）', () => {
  /** 完成済みの城を 1 棟置く（`frontSlotBonus: 1`）。 */
  function putCastle(w: World, tx: number): void {
    const d = buildingDefById('castle');
    const id = spawnEntity(w.entities, {
      kind: EntityKind.Building,
      owner: 0,
      typeId: d.index,
      x: fxFromInt(tx),
      y: fxFromInt(10),
      hpMax: d.hp,
    });
    w.entities.buildProgress[entityIndex(id)] = PROGRESS_DONE;
  }

  it('帝国 4 + 城 2 で 6、城 3 でも 6 で止まる', () => {
    const w = makeWorld();
    const pl = w.players[0]!;
    pl.age = 3; // 帝国 = スロット 4

    const castle = (tx: number): void => {
      putCastle(w, tx);
    };

    recomputeFrontSlots(w, 0);
    expect(pl.frontSlots).toBe(4);

    castle(20);
    recomputeFrontSlots(w, 0);
    expect(pl.frontSlots).toBe(5);

    castle(40);
    recomputeFrontSlots(w, 0);
    expect(pl.frontSlots).toBe(6);

    castle(60); // 3 棟目。上限 6 で止まる
    recomputeFrontSlots(w, 0);
    expect(pl.frontSlots).toBe(6);
  });

  it('acquireFrontSlot は番号の小さい空きから返し、frontSlots を超えない', () => {
    const w = makeWorld();
    const pl = w.players[0]!;
    pl.frontSlots = 2;
    expect(acquireFrontSlot(w, 0)).toBe(1);
    getFront(w, 0, 1)!.active = true;
    expect(acquireFrontSlot(w, 0)).toBe(2);
    getFront(w, 0, 2)!.active = true;
    expect(acquireFrontSlot(w, 0)).toBe(-1); // 3 枠目は使えない
  });
});

// ---------------------------------------------------------------- T-M8-02

describe('T-M8-02 発生（半径 15 内に双方 3 体以上、交戦 2 秒継続）', () => {
  it('3 体ずつ + 交戦 50 tick で戦域が立つ（両軍それぞれに立つ）', () => {
    const w = makeWorld();
    setupClash(w, 50, 50, 3);
    const engage = frontSpawnEngageTicks();
    expect(engage).toBe(50);

    // 継続 49 tick 目までは立たない。
    tickFronts(w, engage - 1, () => bleedAll(w));
    expect(getFront(w, 0, 1)!.active).toBe(false);

    tickFronts(w, 2, () => bleedAll(w));
    expect(getFront(w, 0, 1)!.active).toBe(true);
    // 戦域はプレイヤーごとに立つ（赤の 1 と青の 1 は別物）。
    expect(getFront(w, 1, 1)!.active).toBe(true);
  });

  it('1.9 秒（47 tick）では立たない', () => {
    const w = makeWorld();
    setupClash(w, 50, 50, 3);
    tickFronts(w, 47, () => bleedAll(w));
    expect(getFront(w, 0, 1)!.active).toBe(false);
  });

  it('2 体では立たない（3 体未満）', () => {
    const w = makeWorld();
    setupClash(w, 50, 50, 2);
    tickFronts(w, 120, () => bleedAll(w));
    expect(getFront(w, 0, 1)!.active).toBe(false);
    expect(getFront(w, 1, 1)!.active).toBe(false);
  });

  it('近接しているだけ（実ダメージなし）では立たない', () => {
    const w = makeWorld();
    setupClash(w, 50, 50, 4);
    tickFronts(w, 120); // HP を削らない
    expect(getFront(w, 0, 1)!.active).toBe(false);
  });

  it('離れていれば（半径 15 マス超）立たない', () => {
    const w = makeWorld();
    for (let k = 0; k < 4; k++) putUnit(w, 0, 30 + k, 30);
    for (let k = 0; k < 4; k++) putUnit(w, 1, 30 + k, 70); // 40 マス離す
    tickFronts(w, 120, () => bleedAll(w));
    expect(getFront(w, 0, 1)!.active).toBe(false);
  });
});

// ---------------------------------------------------------------- T-M8-03

describe('T-M8-03 成長（兵数で半径 15 → 30）', () => {
  it('式が clamp(15 + floor(n / 4), 15, 30) になっている', () => {
    expect(frontRadiusForMembers(0)).toBe(fxFromInt(15));
    expect(frontRadiusForMembers(3)).toBe(fxFromInt(15));
    expect(frontRadiusForMembers(4)).toBe(fxFromInt(16));
    expect(frontRadiusForMembers(40)).toBe(fxFromInt(25));
    expect(frontRadiusForMembers(60)).toBe(fxFromInt(30));
    expect(frontRadiusForMembers(400)).toBe(fxFromInt(30)); // 上限で止まる
  });

  it('兵を足すと半径が伸び、上限 30 で止まる', () => {
    const w = makeWorld();
    setupClash(w, 60, 60, 4);
    tickFronts(w, frontSpawnEngageTicks() + 1, () => bleedAll(w));
    const f = getFront(w, 0, 1)!;
    expect(f.active).toBe(true);
    expect(fxToInt(f.radius)).toBe(15);

    // 半径内に自軍を大量に増やす（編入されて半径が伸びる）。
    for (let k = 0; k < 40; k++) putUnit(w, 0, 58 + (k % 8), 58 + Math.trunc(k / 8));
    tickFronts(w, 3, () => bleedAll(w));
    expect(fxToInt(f.radius)).toBeGreaterThan(15);

    for (let k = 0; k < 200; k++) putUnit(w, 0, 55 + (k % 14), 55 + Math.trunc(k / 14));
    tickFronts(w, 3, () => bleedAll(w));
    expect(fxToInt(f.radius)).toBe(30);
  });
});

// ---------------------------------------------------------------- T-M8-04

describe('T-M8-04 統合（中心 20 マス以内、小さい slot が吸収し、その令が適用）', () => {
  it('令が吸収側のものになり、slot が 1 つ空く', () => {
    const w = makeWorld();
    const f1 = getFront(w, 0, 1)!;
    const f2 = getFront(w, 0, 2)!;

    // 中心 10 マス差の戦域 2 つを手で立てる（発生の 50 tick を待たない）。
    for (const [f, cx] of [
      [f1, 60],
      [f2, 70],
    ] as const) {
      f.active = true;
      f.x = fxFromInt(cx);
      f.y = fxFromInt(60);
      f.radius = fxFromInt(15);
      f.lastEngageTick = 0;
    }
    f1.order = 'hold';
    f2.order = 'charge';

    const a = putUnit(w, 0, 60, 60);
    const b = putUnit(w, 0, 70, 60);
    w.entities.frontId[a] = 1;
    w.entities.frontId[b] = 2;

    tickFronts(w, 1);

    expect(f1.active).toBe(true);
    expect(f2.active).toBe(false); // slot が 1 つ空いた
    expect(f1.order).toBe('hold'); // 吸収した側（小さい slot）の令
    expect(w.entities.frontId[b]).toBe(1); // 吸収された側の兵が slot 1 へ
  });

  it('離れている戦域（20 マス超）は統合しない', () => {
    const w = makeWorld();
    const f1 = getFront(w, 0, 1)!;
    const f2 = getFront(w, 0, 2)!;
    for (const [f, cx] of [
      [f1, 40],
      [f2, 75],
    ] as const) {
      f.active = true;
      f.x = fxFromInt(cx);
      f.y = fxFromInt(60);
      f.radius = fxFromInt(15);
      f.lastEngageTick = 0;
    }
    const a = putUnit(w, 0, 40, 60);
    const b = putUnit(w, 0, 75, 60);
    w.entities.frontId[a] = 1;
    w.entities.frontId[b] = 2;

    tickFronts(w, 1);
    expect(f1.active).toBe(true);
    expect(f2.active).toBe(true);
  });

  it('別プレイヤーの戦域とは統合しない', () => {
    const w = makeWorld();
    const f0 = getFront(w, 0, 1)!;
    const f1 = getFront(w, 1, 1)!;
    for (const f of [f0, f1]) {
      f.active = true;
      f.x = fxFromInt(60);
      f.y = fxFromInt(60);
      f.radius = fxFromInt(15);
      f.lastEngageTick = 0;
    }
    const a = putUnit(w, 0, 60, 60);
    const b = putUnit(w, 1, 61, 60);
    w.entities.frontId[a] = 1;
    w.entities.frontId[b] = 1;

    tickFronts(w, 1);
    expect(f0.active).toBe(true);
    expect(f1.active).toBe(true);
  });
});

// ---------------------------------------------------------------- T-M8-05

describe('T-M8-05 分裂（35 マス以上の離脱）', () => {
  /** 中心 (60,60) の戦域 1 と、遠くに離れた兵を用意する。 */
  function setupSplit(w: World): { near: number; far: number } {
    const f = getFront(w, 0, 1)!;
    f.active = true;
    f.x = fxFromInt(60);
    f.y = fxFromInt(60);
    f.radius = fxFromInt(15);
    f.order = 'hold';
    f.lastEngageTick = 0;
    const near = putUnit(w, 0, 60, 60);
    const far = putUnit(w, 0, 60, 100); // 40 マス離れている
    w.entities.frontId[near] = 1;
    w.entities.frontId[far] = 1;
    return { near, far };
  }

  it('空き slot があれば新戦域として独立し、令を引き継ぐ', () => {
    const w = makeWorld();
    const { near, far } = setupSplit(w);

    tickFronts(w, 1);

    const e = w.entities;
    expect(e.frontId[near]).toBe(1);
    expect(e.frontId[far]).toBe(2);
    const nf = getFront(w, 0, 2)!;
    expect(nf.active).toBe(true);
    expect(nf.order).toBe('hold'); // 令を引き継ぐ
    expect(fxToInt(nf.y)).toBe(100);
  });

  it('空きなしのとき遠い側が frontId = 0 になる（令は保持）', () => {
    const w = makeWorld();
    w.players[0]!.frontSlots = 1; // 空き slot なし
    const { near, far } = setupSplit(w);

    tickFronts(w, 1);

    const e = w.entities;
    expect(e.frontId[near]).toBe(1);
    expect(e.frontId[far]).toBe(0);
    // 最後の令（死守 = ORDER_IDS の 3 番目 → index 2 → 値 3）を保持している
    expect(e.lastOrder[far]).toBe(3);
  });
});

// ---------------------------------------------------------------- T-M8-06

describe('T-M8-06 消滅（無交戦 15 秒）と最後の令の保持', () => {
  it('375 tick 無交戦で閉じ、所属兵は frontId = 0 かつ lastOrder を保持する', () => {
    const w = makeWorld();
    const f = getFront(w, 0, 1)!;
    f.active = true;
    f.x = fxFromInt(60);
    f.y = fxFromInt(60);
    f.radius = fxFromInt(15);
    f.order = 'charge'; // ORDER_IDS の 1 番目 → lastOrder = 1
    f.lastEngageTick = 0;
    const a = putUnit(w, 0, 60, 60);
    w.entities.frontId[a] = 1;

    // tick 0..374 の 375 回。`tick - lastEngageTick` は最大 374 なのでまだ閉じない。
    tickFronts(w, 375);
    expect(f.active).toBe(true);
    expect(w.entities.frontId[a]).toBe(1);

    // tick 375 で `375 - 0 >= 375` が成立して閉じる。
    tickFronts(w, 1);
    expect(f.active).toBe(false);
    expect(w.entities.frontId[a]).toBe(0);
    expect(w.entities.lastOrder[a]).toBe(1); // 最後の令を保持して待機
  });
});

// ---------------------------------------------------------------- T-M8-07

describe('T-M8-07 優勢度と −30% 警告', () => {
  it('式（与被ダメージ収支 0.5 + 残存兵力比 0.5）どおりに計算する', () => {
    // 完全な優勢: 与ダメージのみ + 自軍無傷 / 敵半減
    const good = computeAdvantage({
      dealt: fx(100),
      taken: 0,
      hpOwn: fx(100),
      hpBaseOwn: fx(100),
      hpEnemy: fx(50),
      hpBaseEnemy: fx(100),
    });
    // 0.5 * 1.0 + 0.5 * (1.0 - 0.5) = 0.75
    expect(good).toBe(fx(0.75));

    // 一方的に負けている: 被弾のみ + 自軍半減 / 敵無傷
    const bad = computeAdvantage({
      dealt: 0,
      taken: fx(100),
      hpOwn: fx(50),
      hpBaseOwn: fx(100),
      hpEnemy: fx(100),
      hpBaseEnemy: fx(100),
    });
    // 0.5 * (-1.0) + 0.5 * (0.5 - 1.0) = -0.75
    expect(bad).toBe(fx(-0.75));

    // 互角
    expect(
      computeAdvantage({
        dealt: fx(50),
        taken: fx(50),
        hpOwn: fx(80),
        hpBaseOwn: fx(100),
        hpEnemy: fx(80),
        hpBaseEnemy: fx(100),
      })
    ).toBe(0);
  });

  it('一方的に負けている戦域が 10 秒以内に警告になる', () => {
    const w = makeWorld();
    const f = getFront(w, 0, 1)!;
    f.active = true;
    f.x = fxFromInt(60);
    f.y = fxFromInt(60);
    f.radius = fxFromInt(15);
    f.lastEngageTick = 0;

    // 自軍 3 体（削られる）、敵 3 体（無傷）。
    const own: number[] = [];
    for (let k = 0; k < 3; k++) {
      const i = putUnit(w, 0, 60 + k, 60);
      w.entities.frontId[i] = 1;
      own.push(i);
    }
    for (let k = 0; k < 3; k++) putUnit(w, 1, 60 + k, 62);

    expect(isFrontWarning(f)).toBe(false);

    // 10 秒 = 250 tick。毎 tick 被弾させる（combat が積むリングバッファを手で埋める）。
    const perTick = fx(2);
    tickFronts(w, 250, (t) => {
      const pos = t % 250;
      f.dmgTaken[pos] = perTick;
      for (const i of own) {
        if (w.entities.hp[i]! > perTick) w.entities.hp[i] = w.entities.hp[i]! - perTick;
      }
      f.lastEngageTick = t;
    });

    expect(f.advantage).toBeLessThan(fx(-0.3));
    expect(isFrontWarning(f)).toBe(true);
  });
});

// ---------------------------------------------------------------- T-M8-09

describe('T-M8-09 スロット不足（令が届かない戦闘）', () => {
  it('7 個目の戦闘は戦域にならず frontId が 0 のまま', () => {
    const w = makeWorld();
    // 6 か所 + 1 か所 = 7 か所で戦闘を起こす。十分離して統合しないようにする。
    const spots: number[][] = [];
    for (let k = 0; k < 7; k++) spots.push([20 + k * 25, 40]);
    const seventhOwn: number[] = [];
    for (let k = 0; k < spots.length; k++) {
      const [cx, cy] = spots[k]! as [number, number];
      const own = setupClash(w, cx, cy, 3);
      if (k === 6) seventhOwn.push(...own);
    }

    tickFronts(w, frontSpawnEngageTicks() + 20, () => bleedAll(w));

    // 6 本立って打ち止め。
    expect(ownFronts(w, 0).length).toBe(MAX_FRONTS);
    // 7 個目の戦闘の兵は戦域外のまま（= 令が届かない。戦闘そのものは起きる）。
    for (const i of seventhOwn) expect(w.entities.frontId[i]).toBe(0);
  });
});

// ---------------------------------------------------------------- T-M8-10

describe('T-M8-10 戦域の視界例外', () => {
  it('視界外でも自軍の戦域は取得でき、敵戦域は輪（中心と半径）だけが見える', () => {
    const w = makeWorld();
    const f0 = getFront(w, 0, 1)!;
    const f1 = getFront(w, 1, 3)!;
    for (const [f, cx] of [
      [f0, 30],
      [f1, 150],
    ] as const) {
      f.active = true;
      f.x = fxFromInt(cx);
      f.y = fxFromInt(30);
      f.radius = fxFromInt(18);
      f.order = 'charge';
      f.memberCount = 12;
      f.advantage = fx(0.4);
    }

    // 自軍の戦域は（視界の状態と無関係に）中身まで見える。
    const mine = ownFronts(w, 0);
    expect(mine.length).toBe(1);
    expect(mine[0]!.order).toBe('charge');

    // 敵の戦域は輪の数と位置のみ。中身のキーが存在しない。
    const rings = visibleEnemyFronts(w, 0);
    expect(rings.length).toBe(1);
    expect(rings[0]!.slot).toBe(3);
    expect(fxToInt(rings[0]!.x)).toBe(150);
    expect(fxToInt(rings[0]!.radius)).toBe(18);
    expect(Object.keys(rings[0]!).sort()).toEqual(['owner', 'radius', 'slot', 'x', 'y']);
  });
});
