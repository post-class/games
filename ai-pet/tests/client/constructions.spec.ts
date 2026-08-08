/**
 * 共同建設の見た目（G-1 / G-2）。
 *
 * ここで守りたいのは「サーバが持っているのに画面に何も出ない」状態に戻らないこと。
 * `objects.ts` は資源と設置物しか見ていないので、
 * **未完成の予定地には足場、完成物には専用の設置物**という2本立てが必要になる。
 */
import { describe, expect, it } from 'vitest';
import { BAR_HIGH, BAR_LOW, barColor } from '../../packages/client/src/render/constructions.ts';
import { OBJECT_SCALE } from '../../packages/client/src/render/objects.ts';

describe('G-1 建設中の足場', () => {
  it('進捗バーは半分を境に桃→緑へ変わる', () => {
    expect(barColor(0)).toBe(BAR_LOW);
    expect(barColor(49)).toBe(BAR_LOW);
    expect(barColor(50)).toBe(BAR_HIGH);
    expect(barColor(100)).toBe(BAR_HIGH);
  });

  it('足場の描画サイズが登録されている（未登録だと1タイルで見落とす）', () => {
    expect(OBJECT_SCALE['scaffold']).toBeGreaterThan(1.5);
  });
});

describe('G-2 完成物', () => {
  it('天文台と井戸の描画サイズが登録されている', () => {
    // 天文台は島の名所なので、ベンチ（1.2）よりはっきり大きいこと
    expect(OBJECT_SCALE['observatory']).toBeGreaterThan(OBJECT_SCALE['bench'] as number);
    expect(OBJECT_SCALE['well']).toBeGreaterThan(1);
  });
});
