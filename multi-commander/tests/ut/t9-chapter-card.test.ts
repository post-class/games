import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDom, type FakeElement } from './fake-dom';
import { ChapterCard } from '../../src/ui/ChapterCard';
import { VEIL_CHAPTERS } from '../../src/content/veil/chapters';

/**
 * 章の導入カード（`src/ui/ChapterCard.ts`）のテスト。
 *
 * 章本文（`VeilChapter.body`）は長いので2段落ずつ送る。ここで見るのは
 * 「全段落に到達できるか」「最後まで送ると1回だけ終わりを通知するか」。
 * 送り漏れがあると、書いた文章がプレイヤーに届かないまま終わる。
 */

const chapterOf = (n: number) => {
  const chapter = VEIL_CHAPTERS.find((c) => c.chapter === n);
  if (!chapter) throw new Error(`第${n}章が見つからない`);
  return chapter;
};

describe('章の導入カード', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
  });

  afterEach(() => {
    dom.restore();
  });

  const build = (chapterNo: number, onFinish = vi.fn()) => {
    const chapter = chapterOf(chapterNo);
    const card = new ChapterCard({
      chapter,
      image: 'art/tex/story-ch01.jpg',
      totalChapters: VEIL_CHAPTERS.length,
      onFinish,
    });
    return { card, chapter, onFinish, root: card.el as unknown as FakeElement };
  };

  it('章の見出し・タグライン・戦域・主目標がカードに出る', () => {
    const { chapter, root } = build(1);
    const text = dom.text(root);
    expect(text).toContain(chapter.title);
    expect(text).toContain(chapter.tagline);
    expect(text).toContain(chapter.theaterName);
    expect(text).toContain(chapter.objective);
    expect(text).toContain(`第${chapter.chapter}章 / 全${VEIL_CHAPTERS.length}章`);
  });

  it('登場人物が名前で並ぶ', () => {
    const { chapter, root } = build(1);
    const text = dom.text(root);
    for (const person of chapter.cast) expect(text).toContain(person.name);
  });

  it('送っていくと本文の全段落に到達する（書いた文章が届かない事故を防ぐ）', () => {
    const { card, chapter } = build(1);
    const seen: string[] = [];
    for (let i = 0; i < chapter.body.length; i++) {
      seen.push(dom.text(card.el as unknown as FakeElement));
      if (card.finished) break;
      card.next();
    }
    seen.push(dom.text(card.el as unknown as FakeElement));
    const all = seen.join('\n');
    for (const para of chapter.body) {
      // 先頭 20 文字で照合する（escapeHtml で記号が変換されるため）
      expect(all).toContain(para.slice(0, 20));
    }
  });

  it('最後のページで送ると読み終わりを通知する', () => {
    const { card, onFinish } = build(1);
    card.skip();
    expect(card.finished).toBe(true);
    expect(onFinish).not.toHaveBeenCalled();
    card.next();
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('全10章がカードに必要なデータを持つ', () => {
    expect(VEIL_CHAPTERS).toHaveLength(10);
    for (const chapter of VEIL_CHAPTERS) {
      expect(chapter.body.length).toBeGreaterThanOrEqual(2);
      expect(chapter.cast.length).toBeGreaterThanOrEqual(1);
      expect(chapter.tagline.length).toBeGreaterThan(2);
      expect(chapter.objective.length).toBeGreaterThan(2);
      const card = new ChapterCard({
        chapter,
        image: 'x.jpg',
        totalChapters: VEIL_CHAPTERS.length,
      });
      // 送り切れば必ず終わりに着く（無限に送り続けない）
      let guard = 0;
      while (!card.finished && guard++ < 20) card.next();
      expect(card.finished).toBe(true);
    }
  });
});
