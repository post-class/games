/**
 * T-M2-03: エンティティ SoA + free list + generation（実装手順書 §4.4）
 *
 * 検証:
 *  - 1 万体の追加 / 削除を 1000 回繰り返しても index 順序が保たれる
 *  - swap-remove が起きていない（生き残ったエンティティの index が動かない）
 *  - generation により古い EntityId が無効化される
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import {
  ENTITY_CAPACITY_MAX,
  createEntities,
  entityGeneration,
  entityIndex,
  flushDead,
  idOfIndex,
  isAlive,
  makeEntityId,
  markDead,
  spawnEntity,
} from '@/sim/core/entity';
import { FX_ONE, fxFromInt } from '@/sim/core/fx';
import { Rng } from '@/sim/core/rng';

function spawnUnit(
  e: ReturnType<typeof createEntities>,
  owner: number,
  x: number,
  y: number
): number {
  return spawnEntity(e, {
    kind: EntityKind.Unit,
    owner,
    typeId: 1,
    x: fxFromInt(x),
    y: fxFromInt(y),
    hpMax: fxFromInt(40),
  });
}

/** 生存 index を昇順で集める。 */
function aliveIndices(e: ReturnType<typeof createEntities>): number[] {
  const out: number[] = [];
  for (let i = 0; i < e.highWater; i++) if (e.alive[i] === 1) out.push(i);
  return out;
}

describe('EntityId のビット詰め', () => {
  it('index と generation を往復する', () => {
    for (const i of [0, 1, 255, 4096, 65535]) {
      for (const g of [0, 1, 255, 65535]) {
        const id = makeEntityId(i, g);
        expect(entityIndex(id)).toBe(i);
        expect(entityGeneration(id)).toBe(g);
      }
    }
  });

  it('容量上限は 65536（index 16bit）', () => {
    expect(ENTITY_CAPACITY_MAX).toBe(65536);
    expect(() => createEntities(0)).toThrow();
    expect(() => createEntities(ENTITY_CAPACITY_MAX + 1)).toThrow();
  });
});

describe('spawn / markDead / flushDead', () => {
  it('spawn は index 0 から昇順に割り当てる', () => {
    const e = createEntities(16);
    for (let i = 0; i < 5; i++) {
      expect(entityIndex(spawnUnit(e, 0, i, i))).toBe(i);
    }
    expect(e.count).toBe(5);
    expect(e.highWater).toBe(5);
  });

  it('初期値: hp = hpMax, morale = FX_ONE, frontId = 0', () => {
    const e = createEntities(4);
    const id = spawnUnit(e, 3, 10, 20);
    const i = entityIndex(id);
    expect(e.hp[i]).toBe(fxFromInt(40));
    expect(e.morale[i]).toBe(FX_ONE);
    expect(e.frontId[i]).toBe(0);
    expect(e.owner[i]).toBe(3);
    expect(e.x[i]).toBe(fxFromInt(10));
  });

  it('markDead は即座に反復から外すが index は再利用しない（flushDead まで）', () => {
    const e = createEntities(8);
    const a = spawnUnit(e, 0, 0, 0);
    const b = spawnUnit(e, 0, 1, 1);
    expect(markDead(e, a)).toBe(true);
    expect(e.count).toBe(1);
    expect(isAlive(e, a)).toBe(false);
    expect(isAlive(e, b)).toBe(true);
    // flushDead 前は free list が空なので新規は index 2 に入る
    const c = spawnUnit(e, 0, 2, 2);
    expect(entityIndex(c)).toBe(2);
    // flush 後に index 0 が再利用される
    expect(flushDead(e)).toBe(1);
    const d = spawnUnit(e, 0, 3, 3);
    expect(entityIndex(d)).toBe(0);
  });

  it('二重 markDead は無害', () => {
    const e = createEntities(4);
    const a = spawnUnit(e, 0, 0, 0);
    expect(markDead(e, a)).toBe(true);
    expect(markDead(e, a)).toBe(false);
    expect(e.count).toBe(0);
    expect(e.pendingDeadCount).toBe(1);
  });

  it('generation により古い EntityId は無効になる', () => {
    const e = createEntities(4);
    const a = spawnUnit(e, 0, 0, 0);
    markDead(e, a);
    flushDead(e);
    const b = spawnUnit(e, 1, 5, 5);
    expect(entityIndex(b)).toBe(entityIndex(a));
    expect(entityGeneration(b)).toBe(entityGeneration(a) + 1);
    expect(isAlive(e, a)).toBe(false); // 古い ID は無効
    expect(isAlive(e, b)).toBe(true);
    expect(idOfIndex(e, entityIndex(b))).toBe(b);
  });

  it('容量を超えた spawn は明確な例外', () => {
    const e = createEntities(2);
    spawnUnit(e, 0, 0, 0);
    spawnUnit(e, 0, 1, 1);
    expect(() => spawnUnit(e, 0, 2, 2)).toThrow(/capacity exhausted/);
  });

  it('解放されたスロットは初期化される（残留値でハッシュが汚れない）', () => {
    const e = createEntities(4);
    const a = spawnUnit(e, 5, 111, 222);
    markDead(e, a);
    flushDead(e);
    const i = entityIndex(a);
    expect(e.x[i]).toBe(0);
    expect(e.y[i]).toBe(0);
    expect(e.hp[i]).toBe(0);
    expect(e.kind[i]).toBe(EntityKind.None);
    expect(e.target[i]).toBe(-1);
  });
});

describe('T-M2-03: 1 万体の追加 / 削除を 1000 回繰り返しても index 順序が保たれる', () => {
  it('生存 index は常に昇順、swap-remove が起きていない', () => {
    const N = 10000;
    const ROUNDS = 1000;
    const e = createEntities(N);
    const rng = new Rng(0xbeef);

    // 1 万体まで埋める
    const ids: number[] = [];
    for (let i = 0; i < N; i++) ids.push(spawnUnit(e, i % 8, i % 400, (i * 7) % 400));
    expect(e.count).toBe(N);
    expect(e.highWater).toBe(N);
    expect(aliveIndices(e)).toEqual(Array.from({ length: N }, (_, i) => i));

    // 「一部を削除 → 同数を追加」を 1000 回。合計 1000 万回の追加/削除に相当する
    // 反復を毎回するのは時間がかかるので、1 ラウンドあたり 10000 体を削除 → 10000 体を追加する。
    for (let round = 0; round < ROUNDS; round++) {
      // 全削除
      for (let i = 0; i < ids.length; i++) markDead(e, ids[i]!);
      expect(e.count).toBe(0);
      flushDead(e);
      expect(e.freeCount).toBe(N);

      // 同数を再追加
      ids.length = 0;
      for (let i = 0; i < N; i++) ids.push(spawnUnit(e, i % 8, i % 400, (i * 7) % 400));

      // index 領域は伸びていない（free list が使われている）
      expect(e.highWater).toBe(N);
      expect(e.count).toBe(N);

      // 反復が index 昇順であること。
      // expect() を 1000 万回呼ぶと遅いので、ラウンドごとに 1 回だけ検証する。
      let prev = -1;
      let alive = 0;
      let ascending = true;
      for (let i = 0; i < e.highWater; i++) {
        if (e.alive[i] !== 1) continue;
        if (i <= prev) ascending = false;
        prev = i;
        alive++;
      }
      expect(ascending, `round ${round}: index 昇順`).toBe(true);
      expect(alive).toBe(N);

      // ランダムに 1 体選び、その index が固定されていること（swap-remove 検出）
      const k = rng.nextInt(N);
      const id = ids[k]!;
      const idx = entityIndex(id);
      expect(isAlive(e, id)).toBe(true);
      expect(e.owner[idx]).toBe(k % 8);
    }

    // 世代は 1000 回転している
    expect(e.generation[0]).toBe(ROUNDS % 0x10000);
  });

  it('部分削除でも生存エンティティの index は動かない', () => {
    const N = 5000;
    const e = createEntities(N);
    const ids: number[] = [];
    for (let i = 0; i < N; i++) ids.push(spawnUnit(e, 0, i, i));

    // 偶数番だけ削除
    const survivorIndex = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      if (i % 2 === 0) markDead(e, ids[i]!);
      else survivorIndex.set(i, entityIndex(ids[i]!));
    }
    flushDead(e);

    for (const [i, idx] of survivorIndex) {
      expect(entityIndex(ids[i]!)).toBe(idx); // ID の index が変わっていない
      expect(isAlive(e, ids[i]!)).toBe(true);
      expect(e.x[idx]).toBe(fxFromInt(i)); // 中身も動いていない
    }
    expect(aliveIndices(e)).toEqual(
      Array.from({ length: N / 2 }, (_, k) => k * 2 + 1) // 奇数 index のみ
    );
  });

  it('flushDead は index 昇順で free list に返す（呼び出し順に依存しない）', () => {
    const build = (order: readonly number[]): number[] => {
      const e = createEntities(8);
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) ids.push(spawnUnit(e, 0, i, i));
      for (const i of order) markDead(e, ids[i]!);
      flushDead(e);
      return Array.from(e.freeList.subarray(0, e.freeCount));
    };
    expect(build([0, 2, 4])).toEqual(build([4, 2, 0]));
    expect(build([0, 2, 4])).toEqual([0, 2, 4]);
  });
});
