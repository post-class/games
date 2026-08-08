/**
 * 眠っているアクターの zzz（D-3 の残り）。
 *
 * ここで守りたいのは「**うるさくならない**」こと。
 * 常時出ていたり、全個体が同じ拍で点いたりすると夜の画面が賑やかになりすぎる。
 */
import { describe, expect, it } from 'vitest';
import { ZZZ_PERIOD_SEC, zzzOffsetFor, zzzPhase } from '../../packages/client/src/render/zzz.ts';

describe('D-3 zzz', () => {
  it('周期の4割は何も出さない（出しっぱなしにしない）', () => {
    let hidden = 0;
    const n = 100;
    for (let i = 0; i < n; i++) {
      if (zzzPhase(i / n).alpha <= 0) hidden++;
    }
    // 0.6 より後ろは必ず非表示なので、4割前後が隠れているはず
    expect(hidden).toBeGreaterThanOrEqual(35);
    expect(hidden).toBeLessThanOrEqual(45);
  });

  it('出ている間は「現れて消える」山になる（点きっぱなしにしない）', () => {
    expect(zzzPhase(0).alpha).toBeCloseTo(0, 5);
    expect(zzzPhase(0.3).alpha).toBeGreaterThan(zzzPhase(0.05).alpha);
    expect(zzzPhase(0.3).alpha).toBeGreaterThan(zzzPhase(0.55).alpha);
  });

  it('浮かぶ量は単調に増える（出た位置から上へ動く）', () => {
    let prev = -1;
    // 0.05 ずつ足すと 0.6000000000000001 になり非表示区間に入ってしまうので、割り算で刻む
    for (let i = 0; i <= 12; i++) {
      const r = zzzPhase(i / 20).rise;
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it('周期の外（1を超える値）でも折り返して同じ結果になる', () => {
    expect(zzzPhase(1.25)).toEqual(zzzPhase(0.25));
    expect(zzzPhase(-0.75).alpha).toBeCloseTo(zzzPhase(0.25).alpha, 10);
  });

  it('個体ごとに位相がずれる（全部が同じ拍で点かない）', () => {
    const offs = [1, 2, 3, 10, 42, 300].map(zzzOffsetFor);
    expect(new Set(offs).size).toBe(offs.length);
    for (const o of offs) {
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(1);
    }
  });

  it('位相は決定論（同じIDなら同じ値）', () => {
    for (let i = 0; i < 10; i++) expect(zzzOffsetFor(7)).toBe(zzzOffsetFor(7));
  });

  it('周期は3秒（うるさくならない間隔）', () => {
    expect(ZZZ_PERIOD_SEC).toBe(3);
  });
});
