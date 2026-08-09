import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDom, type FakeElement } from './fake-dom';
import { VEIL_CHAPTERS } from '../../src/content/veil/chapters';
import { ChoiceScene } from '../../src/ui/ChoiceScene';

const chapterOf = (n: number) => {
  const chapter = VEIL_CHAPTERS.find((c) => c.chapter === n);
  if (!chapter) throw new Error(`第${n}章が見つからない`);
  return chapter;
};

describe('章末の選択画面 (T7-4)', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
  });

  afterEach(() => {
    dom.restore();
  });

  const build = (chapterNo: number, onSelect = vi.fn()) => {
    const chapter = chapterOf(chapterNo);
    const scene = new ChoiceScene({
      choice: chapter.choice,
      chapterLabel: `第${chapter.chapter}章`,
      onSelect,
    });
    scene.start();
    return { chapter, scene, onSelect, root: scene.el as unknown as FakeElement };
  };

  it('各章の選択肢数を描画する（第9章=4、第10章=3、他=2）', () => {
    for (const chapter of VEIL_CHAPTERS) {
      const expected = chapter.chapter === 9 ? 4 : chapter.chapter === 10 ? 3 : 2;
      expect(chapter.choice.options).toHaveLength(expected);
      const { root } = build(chapter.chapter);
      expect(dom.findAll(root, 'mc-choice-option')).toHaveLength(expected);
      expect(dom.findAll(root, 'mc-choice-options')[0].dataset.count).toBe(String(expected));
    }
  });

  it('見出し・問い・補足と、各選択肢の label と consequence を出す', () => {
    const { chapter, root } = build(9);
    const text = dom.text(root);
    expect(text).toContain(chapter.choice.kind);
    expect(text).toContain(chapter.choice.question);
    expect(text).toContain(chapter.choice.note);
    for (const opt of chapter.choice.options) {
      expect(text).toContain(opt.label);
      expect(text).toContain(opt.consequence);
    }
    // 4状態の増減はこの画面では出さない（数値の開示はデブリーフ側）
    expect(text).not.toContain('帰還者 +');
    expect(text).not.toContain('航路信頼 +');
  });

  it('クリックで選んだ選択肢idを1回だけ返す', () => {
    const { chapter, onSelect, root } = build(10);
    const options = dom.findAll(root, 'mc-choice-option');
    expect(options).toHaveLength(3);
    options[1].fire('click');
    options[2].fire('click');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(chapter.choice.options[1].id);
  });

  it('←→で選択が動き、Enterで確定する', () => {
    const { chapter, scene, onSelect } = build(9);
    expect(scene.selectedId).toBe(chapter.choice.options[0].id);
    dom.key('ArrowRight');
    dom.key('ArrowRight');
    dom.key('ArrowRight');
    expect(scene.selectedId).toBe(chapter.choice.options[3].id);
    dom.key('ArrowLeft');
    expect(scene.selectedId).toBe(chapter.choice.options[2].id);
    dom.key('Enter');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(chapter.choice.options[2].id);
  });

  it('Enterのキーリピート・連打・決定後のクリックでも applyChoice 相当の通知は1回だけ', () => {
    const { scene, onSelect, root } = build(1);
    dom.key('Enter', { repeat: true });
    expect(onSelect).not.toHaveBeenCalled();
    dom.key('Enter');
    dom.key('Enter', { repeat: true });
    dom.key('Enter');
    dom.findAll(root, 'mc-choice-option')[1].fire('click');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(scene.isDecided).toBe(true);
    expect(root.classNames()).toContain('decided');
  });
});
