/**
 * 木の実の木のバリエーション（B-5）と小オブジェクトの描画サイズ（C-4）のテスト。
 *
 * ここで守りたいのは3つ:
 * - 在庫量から状態が決まること（0 → 実なし）
 * - **同じ木は常に同じ状態**（座標ハッシュなので `Math.random` に依らない）
 * - 状態アセットが1枚も無くても基本の `obj_berry_tree` に落ちること
 */
import { describe, expect, it } from 'vitest';
import { MAP_H, MAP_W } from '@ai-pet/shared';
import {
  OBJECT_SCALE,
  ObjectTextureSet,
  berryTreeState,
  treeSeasonOf,
  type BerryTreeState,
} from '../../packages/client/src/render/objects.ts';
import { berryTreeStateNames } from '../../packages/client/src/render/assets.ts';

const MAX = 6;

/** 島の陸のあたりを一様に走査する（1タイル刻みだと16384件で遅いので3タイル刻み） */
function eachTile(fn: (x: number, y: number) => void): void {
  for (let y = 2; y < MAP_H; y += 3) for (let x = 2; x < MAP_W; x += 3) fn(x + 0.5, y + 0.5);
}

/** 在庫が満杯の木の状態を島全体ぶん数える */
function stateHistogram(amount: number): Record<BerryTreeState, number> {
  const hist: Record<BerryTreeState, number> = { full: 0, empty: 0, young: 0, dead: 0 };
  eachTile((x, y) => {
    hist[berryTreeState(amount, MAX, x, y)]++;
  });
  return hist;
}

describe('berryTreeState: 在庫から状態を選ぶ', () => {
  it('在庫0の木は「実なし」になる（若木・枯れ木に当たった木を除く）', () => {
    const hist = stateHistogram(0);
    expect(hist.full).toBe(0);
    expect(hist.empty).toBeGreaterThan(0);
  });

  it('在庫があれば「実つき」になる（若木・枯れ木に当たった木を除く）', () => {
    const hist = stateHistogram(MAX);
    expect(hist.empty).toBe(0);
    expect(hist.full).toBeGreaterThan(0);
  });

  it('在庫1でも「実つき」（1個でも実があるなら採りに行ける、と読めること）', () => {
    // 若木・枯れ木に当たらない座標を1つ見つけて比べる
    let found = false;
    eachTile((x, y) => {
      if (found) return;
      if (berryTreeState(MAX, MAX, x, y) !== 'full') return;
      found = true;
      expect(berryTreeState(1, MAX, x, y)).toBe('full');
      expect(berryTreeState(0, MAX, x, y)).toBe('empty');
    });
    expect(found).toBe(true);
  });

  it('max が0の木は枯死', () => {
    expect(berryTreeState(0, 0, 10.5, 10.5)).toBe('dead');
    expect(berryTreeState(3, 0, 10.5, 10.5)).toBe('dead');
  });
});

describe('berryTreeState: 決定論と分布', () => {
  it('同じ座標なら何度呼んでも同じ状態', () => {
    eachTile((x, y) => {
      expect(berryTreeState(MAX, MAX, x, y)).toBe(berryTreeState(MAX, MAX, x, y));
    });
  });

  it('若木・枯れ木は在庫では絵を変えない（同じ木が若木↔大木に化けない）', () => {
    eachTile((x, y) => {
      const s = berryTreeState(MAX, MAX, x, y);
      if (s !== 'young' && s !== 'dead') return;
      expect(berryTreeState(0, MAX, x, y)).toBe(s);
    });
  });

  it('タイル内のどこを指しても同じ木として扱う（サーバが送る座標のゆらぎに強い）', () => {
    expect(berryTreeState(MAX, MAX, 40.1, 55.9)).toBe(berryTreeState(MAX, MAX, 40.9, 55.1));
  });

  it('4状態が並んでも反復に見えないだけの粗密がある（若木・枯れ木が1〜3割）', () => {
    const hist = stateHistogram(MAX);
    const total = hist.full + hist.empty + hist.young + hist.dead;
    const variety = (hist.young + hist.dead) / total;
    expect(variety).toBeGreaterThan(0.1);
    expect(variety).toBeLessThan(0.3);
    // 若木のほうが枯れ木より多い（枯れ木が目立ちすぎると島が荒れて見える）
    expect(hist.young).toBeGreaterThan(hist.dead);
  });

  it('隣り合う木がぜんぶ同じ状態にはならない（縞や塊にならないこと）', () => {
    const row: BerryTreeState[] = [];
    for (let x = 20; x < 60; x++) row.push(berryTreeState(MAX, MAX, x + 0.5, 40.5));
    expect(new Set(row).size).toBeGreaterThan(1);
  });
});

describe('ObjectTextureSet.resolve: 状態アセットが無ければ基本に落ちる', () => {
  const dummy = { source: { scaleMode: 'nearest' } } as never;

  it('状態アセットが1枚も無ければ obj_berry_tree を返す', () => {
    const set = new ObjectTextureSet([['obj_berry_tree', dummy]], dummy);
    expect(set.resolve('obj_berry_tree_empty', 'obj_berry_tree')).toBe('obj_berry_tree');
  });

  it('状態アセットがあればそちらを優先する', () => {
    const set = new ObjectTextureSet(
      [
        ['obj_berry_tree', dummy],
        ['obj_berry_tree_empty', dummy],
      ],
      dummy,
    );
    expect(set.resolve('obj_berry_tree_empty', 'obj_berry_tree')).toBe('obj_berry_tree_empty');
    // 用意されていない状態は基本に落ちる（1枚ずつ受け止める）
    expect(set.resolve('obj_berry_tree_dead', 'obj_berry_tree')).toBe('obj_berry_tree');
  });
});

describe('OBJECT_SCALE: 小オブジェクトと木の状態差分', () => {
  it('木の4状態にサイズがある。若木は大木より小さい', () => {
    for (const s of ['full', 'empty', 'young', 'dead'] as const) {
      expect(OBJECT_SCALE[`berry_tree_${s}`], s).toBeGreaterThan(0);
    }
    const full = OBJECT_SCALE['berry_tree_full'] as number;
    expect(OBJECT_SCALE['berry_tree_young']).toBeLessThan(full);
    expect(OBJECT_SCALE['berry_tree_dead']).toBeLessThanOrEqual(full);
    // 接地影は状態を知らず `berry_tree` を引くので、基本と実つきは同寸にしておく
    expect(full).toBe(OBJECT_SCALE['berry_tree']);
  });

  it('小オブジェクトは1タイル強に収まる（草地が茂みで埋まらないこと）', () => {
    for (const k of ['campfire', 'rock', 'stump', 'bush'] as const) {
      const s = OBJECT_SCALE[k] as number;
      expect(s, k).toBeGreaterThan(0.5);
      expect(s, k).toBeLessThanOrEqual(1.4);
    }
    // 焚き火は夜の広場の主役なので、岩や切り株より大きい
    expect(OBJECT_SCALE['campfire']).toBeGreaterThan(OBJECT_SCALE['rock'] as number);
  });
});

describe('F-4 木の季節差分', () => {
  it('絵が変わるのは秋と冬だけ（春夏は基本の緑を使う）', () => {
    expect(treeSeasonOf('autumn')).toBe('autumn');
    expect(treeSeasonOf('winter')).toBe('winter');
    expect(treeSeasonOf('spring')).toBeNull();
    expect(treeSeasonOf('summer')).toBeNull();
    // 知らない値が来ても落ちない（サーバの季節名が増えたときに基本へ落ちる）
    expect(treeSeasonOf('rainy')).toBeNull();
  });

  it('季節の絵が無ければ状態の絵へ、それも無ければ基本の1枚へ落ちる', () => {
    const base = new ObjectTextureSet([['obj_berry_tree', null as never]], null as never);
    expect(base.resolve('obj_berry_tree_full_winter', 'obj_berry_tree_full', 'obj_berry_tree')).toBe(
      'obj_berry_tree',
    );
    const withState = new ObjectTextureSet(
      [
        ['obj_berry_tree', null as never],
        ['obj_berry_tree_full', null as never],
      ],
      null as never,
    );
    expect(
      withState.resolve('obj_berry_tree_full_winter', 'obj_berry_tree_full', 'obj_berry_tree'),
    ).toBe('obj_berry_tree_full');
  });

  it('季節差分にも寸法がある（無いと木が急に1タイルへ縮む）', () => {
    for (const st of ['full', 'empty', 'young'] as const) {
      for (const se of ['autumn', 'winter'] as const) {
        expect(OBJECT_SCALE[`berry_tree_${st}_${se}`], `${st}_${se}`).toBe(
          OBJECT_SCALE[`berry_tree_${st}`],
        );
      }
    }
  });

  it('読み込み対象の名前に季節差分が入っている（枯れ木は季節差分を作らない）', () => {
    const names = berryTreeStateNames();
    for (const st of ['full', 'empty', 'young'] as const) {
      for (const se of ['autumn', 'winter'] as const) {
        expect(names, `${st}_${se}`).toContain(`obj_berry_tree_${st}_${se}.png`);
      }
    }
    expect(names).not.toContain('obj_berry_tree_dead_autumn.png');
    expect(names).not.toContain('obj_berry_tree_dead_winter.png');
  });
});
