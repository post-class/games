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
describe('W6 章内ミッション位置', () => {
  // ① veil は 1章 = 1ミッションなので、全10章で index/total が 1/1 になる
  it('veil の全10章で index/total が 1/1、totalChapters が 10', () => {
    expect(totalChapters('veil')).toBe(10);
    const ids = Object.keys(campaignGraph('veil'));
    expect(ids).toHaveLength(10);
    const chapters: number[] = [];
    for (const id of ids) {
      const p = chapterPosition(id, 'veil');
      expect(p.index).toBe(1);
      expect(p.total).toBe(1);
      expect(p.totalChapters).toBe(10);
      chapters.push(p.chapter);
    }
    expect([...chapters].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  // ② expanded の敗北ルートを含む章は、勝ちルートが 1/2、敗北ルートが 2/2
  it('expanded の敗北ルートを持つ章で勝ち 1/2・負け 2/2', () => {
    for (const [win, lose] of [
      ['m2b-recon', 'l1-retreat'],
      ['m4-defend', 'l2-last-stand'],
    ] as const) {
      const w = chapterPosition(win, 'expanded');
      const l = chapterPosition(lose, 'expanded');
      expect(campaignGraph('expanded')[lose].losingRoute).toBe(true);
      expect(w.chapter).toBe(l.chapter);
      expect([w.index, w.total]).toEqual([1, 2]);
      expect([l.index, l.total]).toEqual([2, 2]);
    }
    // 敗北ルートを含まない章は 1/1 のまま
    expect(chapterPosition('m1-patrol', 'expanded').total).toBe(1);
  });

  // ③ 並びが安定していること（同じノードを何度呼んでも同じ番号）
  it('同じノードを何度呼んでも同じ値を返す', () => {
    for (const id of ['m2b-recon', 'l1-retreat', 'm4-defend', 'l2-last-stand']) {
      const first = chapterPosition(id, 'expanded');
      for (let i = 0; i < 5; i += 1) {
        expect(chapterPosition(id, 'expanded')).toEqual(first);
      }
    }
  });

  // ④ 章数は既存の totalChapters と一致する
  it('canon の章数が 7、expanded が 9', () => {
    expect(totalChapters('canon')).toBe(7);
    expect(totalChapters('expanded')).toBe(9);
    expect(chapterPosition('canon-gateway-intercept', 'canon').totalChapters).toBe(7);
    expect(chapterPosition('m6-flagship', 'expanded').totalChapters).toBe(9);
  });

  // ⑤ 表示文の組み立て（progressLabel と同じロジック）
  it('total が 1 のときは章内表記を出さない', () => {
    expect(chapterProgressText(chapterPosition('veil-ch01', 'veil'))).toBe('第1章 / 全10章');
    expect(chapterProgressText(chapterPosition('veil-ch10', 'veil'))).toBe('第10章 / 全10章');
    expect(chapterProgressText(chapterPosition('m1-patrol', 'expanded'))).toBe('第1章 / 全9章');
    // 章内に複数ある章だけ「ミッション i/total」が付く
    expect(chapterProgressText(chapterPosition('m2b-recon', 'expanded'))).toBe(
      '第3章 / 全9章　ミッション 1/2',
    );
    expect(chapterProgressText(chapterPosition('l1-retreat', 'expanded'))).toBe(
      '第3章 / 全9章　ミッション 2/2',
    );
    // 章内表記を省いた文には「ミッション」が現れない
    expect(chapterProgressText(chapterPosition('canon-enyo-patrol', 'canon'))).not.toContain(
      'ミッション',
    );
  });

  it('存在しないノードは例外になる（呼び出し側が isTerminal を先に見る前提）', () => {
    expect(() => chapterPosition('victory', 'veil')).toThrow();
  });
});
