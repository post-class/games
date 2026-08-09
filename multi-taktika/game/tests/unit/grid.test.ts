/**
 * T-M2-05: 8×8 マス均一グリッドの近傍検索（実装手順書 §4.4 末尾）
 *
 * 検証: 総当たりと結果集合が一致すること（**順序を含む**）。
 * 順序まで一致していないと、「グリッドを使う経路」と「使わない経路」で
 * 目標選択が変わり、デシンクの温床になる。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { createEntities, flushDead, markDead, spawnEntity } from '@/sim/core/entity';
import { fx, fxFromInt } from '@/sim/core/fx';
import {
  GRID_CELL_TILES,
  cellIndexAt,
  createGrid,
  queryCircle,
  queryCircleBruteForce,
  rebuildGrid,
} from '@/sim/core/grid';
import { Rng } from '@/sim/core/rng';

const MAP = 200;

function makeScene(seed: number, n: number) {
  const e = createEntities(Math.max(n, 16));
  const g = createGrid(MAP, MAP, Math.max(n, 16));
  const rng = new Rng(seed);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      spawnEntity(e, {
        kind: EntityKind.Unit,
        owner: i % 8,
        typeId: 1,
        // 1/256 マス刻みまでばらけさせる（セル境界ちょうども出る）
        x: rng.nextInt(MAP * 256),
        y: rng.nextInt(MAP * 256),
        hpMax: fxFromInt(40),
      })
    );
  }
  rebuildGrid(g, e, 0);
  return { e, g, rng, ids };
}

describe('グリッドの構造', () => {
  it('セルは 8 マス角', () => {
    expect(GRID_CELL_TILES).toBe(8);
    const g = createGrid(200, 200, 16);
    expect(g.cols).toBe(25);
    expect(g.rows).toBe(25);
    expect(g.cellCount).toBe(625);
  });

  it('端数のあるサイズは切り上げ', () => {
    const g = createGrid(201, 199, 16);
    expect(g.cols).toBe(26);
    expect(g.rows).toBe(25);
  });

  it('範囲外座標はクランプされる（例外にしない）', () => {
    const g = createGrid(200, 200, 16);
    expect(cellIndexAt(g, fx(-100), fx(-100))).toBe(0);
    expect(cellIndexAt(g, fx(10000), fx(10000))).toBe(g.cellCount - 1);
  });

  it('rebuildGrid はセル内を index 昇順に詰める', () => {
    const { e, g } = makeScene(1, 300);
    for (let cell = 0; cell < g.cellCount; cell++) {
      let prev = -1;
      for (let k = g.cellStart[cell]!; k < g.cellStart[cell + 1]!; k++) {
        const i = g.items[k]!;
        expect(i).toBeGreaterThan(prev);
        prev = i;
        expect(cellIndexAt(g, e.x[i]!, e.y[i]!)).toBe(cell);
      }
    }
    expect(g.itemCount).toBe(e.count);
  });
});

describe('T-M2-05: queryCircle は総当たりと完全一致（順序含む）', () => {
  it('多数の乱数シーンと半径で一致', () => {
    const a: number[] = [];
    const b: number[] = [];
    for (const n of [0, 1, 2, 50, 500, 2000]) {
      const { e, g, rng } = makeScene(n + 1000, n);
      for (let t = 0; t < 200; t++) {
        const cx = rng.nextInt(MAP * 256);
        const cy = rng.nextInt(MAP * 256);
        // 0 マス〜40 マスまで。セル 1 個以内から複数セルにまたがる範囲を網羅する
        const r = rng.nextInt(fxFromInt(40) + 1);
        const na = queryCircle(g, e, cx, cy, r, a);
        const nb = queryCircleBruteForce(e, cx, cy, r, b);
        expect(na).toBe(nb);
        expect(a).toEqual(b); // 順序を含めて一致
      }
    }
  });

  it('マップ外の中心・巨大半径でも一致', () => {
    const { e, g } = makeScene(77, 400);
    const a: number[] = [];
    const b: number[] = [];
    const centers = [
      [0, 0],
      [fxFromInt(-50), fxFromInt(-50)],
      [fxFromInt(400), fxFromInt(400)],
      [fxFromInt(100), fxFromInt(100)],
    ] as const;
    for (const [cx, cy] of centers) {
      for (const r of [0, fx(0.5), fxFromInt(8), fxFromInt(300)]) {
        expect(queryCircle(g, e, cx, cy, r, a)).toBe(queryCircleBruteForce(e, cx, cy, r, b));
        expect(a).toEqual(b);
      }
    }
  });

  it('半径の境界は「以下」で含む（平方距離比較）', () => {
    const e = createEntities(4);
    const g = createGrid(MAP, MAP, 4);
    spawnEntity(e, {
      kind: EntityKind.Unit,
      owner: 0,
      typeId: 1,
      x: fxFromInt(3),
      y: fxFromInt(4),
      hpMax: fxFromInt(10),
    });
    rebuildGrid(g, e, 0);
    const out: number[] = [];
    expect(queryCircle(g, e, 0, 0, fxFromInt(5), out)).toBe(1);
    expect(queryCircle(g, e, 0, 0, fxFromInt(5) - 1, out)).toBe(0);
  });

  it('死亡したエンティティは返さない（rebuild 前でも）', () => {
    const { e, g, ids } = makeScene(5, 100);
    markDead(e, ids[0]!);
    markDead(e, ids[50]!);
    const a: number[] = [];
    const b: number[] = [];
    // rebuild していない = items には死体が残っている状態でも一致すること
    expect(queryCircle(g, e, fxFromInt(100), fxFromInt(100), fxFromInt(300), a)).toBe(
      queryCircleBruteForce(e, fxFromInt(100), fxFromInt(100), fxFromInt(300), b)
    );
    expect(a).toEqual(b);

    flushDead(e);
    rebuildGrid(g, e, 1);
    expect(queryCircle(g, e, fxFromInt(100), fxFromInt(100), fxFromInt(300), a)).toBe(
      queryCircleBruteForce(e, fxFromInt(100), fxFromInt(100), fxFromInt(300), b)
    );
    expect(a).toEqual(b);
  });

  it('同一座標に大量に重なっていても一致（セル内順序の検証）', () => {
    const n = 500;
    const e = createEntities(n);
    const g = createGrid(MAP, MAP, n);
    for (let i = 0; i < n; i++) {
      spawnEntity(e, {
        kind: EntityKind.Unit,
        owner: 0,
        typeId: 1,
        x: fxFromInt(64),
        y: fxFromInt(64),
        hpMax: fxFromInt(10),
      });
    }
    rebuildGrid(g, e, 0);
    const a: number[] = [];
    const b: number[] = [];
    expect(queryCircle(g, e, fxFromInt(64), fxFromInt(64), fxFromInt(1), a)).toBe(n);
    queryCircleBruteForce(e, fxFromInt(64), fxFromInt(64), fxFromInt(1), b);
    expect(a).toEqual(b);
    expect(a).toEqual(Array.from({ length: n }, (_, i) => i));
  });
});
