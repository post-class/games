import { describe, expect, it } from 'vitest';
import {
  campaignGraph,
  chapterPosition,
  chapterProgressText,
  totalChapters,
} from '../../src/content/campaign';

// W6「いま何章の何番目のミッションか」の表示に使う純関数のテスト。
// App 側の progressLabel() は DOM に触るので、文言の組み立ては
// chapterProgressText() として切り出し、ここで検証する。
//
// 戦役は THE VEIL FRONT の十章だけ（canon / expanded は削除済み）で、
// 1章 = 1ミッションなので index/total は常に 1/1 になる。
describe('W6 章内ミッション位置', () => {
  it('全10章で index/total が 1/1、totalChapters が 10', () => {
    expect(totalChapters()).toBe(10);
    const ids = Object.keys(campaignGraph());
    expect(ids).toHaveLength(10);
    const chapters: number[] = [];
    for (const id of ids) {
      const p = chapterPosition(id);
      expect(p.index).toBe(1);
      expect(p.total).toBe(1);
      expect(p.totalChapters).toBe(10);
      chapters.push(p.chapter);
    }
    expect([...chapters].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('同じノードを何度呼んでも同じ値を返す（並びが安定している）', () => {
    for (const id of ['veil-ch01', 'veil-ch05', 'veil-ch10']) {
      const first = chapterPosition(id);
      for (let i = 0; i < 5; i += 1) {
        expect(chapterPosition(id)).toEqual(first);
      }
    }
  });

  it('章内が1本のときは章内表記を出さない', () => {
    expect(chapterProgressText(chapterPosition('veil-ch01'))).toBe('第1章 / 全10章');
    expect(chapterProgressText(chapterPosition('veil-ch10'))).toBe('第10章 / 全10章');
    // 章内表記を省いた文には「ミッション」が現れない
    for (const id of Object.keys(campaignGraph())) {
      expect(chapterProgressText(chapterPosition(id))).not.toContain('ミッション');
    }
  });

  it('存在しないノードは例外になる（呼び出し側が isTerminal を先に見る前提）', () => {
    expect(() => chapterPosition('victory')).toThrow();
    // 削除した旧キャンペーンのノードも当然例外になる
    expect(() => chapterPosition('m1-patrol')).toThrow();
  });
});
