import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDom, type FakeElement } from './fake-dom';
import { PROTAGONISTS } from '../../src/content/veil/people';
import { PilotSelectScene, protagonistDisplayName } from '../../src/ui/PilotSelectScene';

describe('主人公選択画面 (T7-1)', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
  });

  afterEach(() => {
    dom.restore();
  });

  const build = (onSelect = vi.fn()) => {
    const scene = new PilotSelectScene({ onSelect });
    scene.start();
    return { scene, onSelect, root: scene.el as unknown as FakeElement };
  };

  it('F-54専任パイロット5名を、肖像・二つ名・戦闘級・役割・実績つきで描画する', () => {
    const { root } = build();
    const cards = dom.findAll(root, 'mc-pilot-card');
    expect(PROTAGONISTS).toHaveLength(5);
    expect(cards).toHaveLength(5);

    // 肖像は人物ごとに用意された画像を使う。
    // 別人の顔が出るのが最悪の失敗なので、src に本人の人物id が入っていることを検証する。
    const faces = dom.findAll(root, 'mc-pilot-face');
    expect(faces).toHaveLength(5);
    faces.forEach((f, i) => {
      const person = PROTAGONISTS[i];
      expect(f.innerHTML).toContain(`face-${person.id}-neutral.jpg`);
    });

    const text = dom.text(root);
    for (const person of PROTAGONISTS) {
      // 表記は speakerName() に統一したので、名簿の生の `name`（括弧つき）ではなく
      // 表示名で照合する（T3-⑬-3）
      expect(text).toContain(protagonistDisplayName(person));
      expect(text).toContain(person.epithet);
      expect(text).toContain(person.role);
      expect(text).toContain(person.achievement);
    }
    expect(dom.findAll(root, 'mc-pilot-grade').map((e) => e.textContent).join(' ')).toContain('級');
  });

  it('クリックした人物のidでコールバックが呼ばれる', () => {
    const { onSelect, root } = build();
    const cards = dom.findAll(root, 'mc-pilot-card');
    cards[2].fire('click');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(PROTAGONISTS[2].id);
  });

  it('←→で選択が動き、Enterで選択中の人物idを返す', () => {
    const { scene, onSelect, root } = build();
    expect(scene.selectedId).toBe(PROTAGONISTS[0].id);
    dom.key('ArrowRight');
    dom.key('ArrowRight');
    expect(scene.selectedId).toBe(PROTAGONISTS[2].id);
    dom.key('ArrowLeft');
    expect(scene.selectedId).toBe(PROTAGONISTS[1].id);
    expect(dom.findAll(root, 'mc-pilot-card')[1].classNames()).toContain('sel');

    dom.key('Enter');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(PROTAGONISTS[1].id);
  });

  it('Enterのキーリピートでも決定は1回しか発火しない', () => {
    const { onSelect } = build();
    dom.key('Enter');
    dom.key('Enter', { repeat: true });
    dom.key('Enter', { repeat: true });
    dom.key('Enter');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('決定後はクリックでも二重に発火しない', () => {
    const { scene, onSelect, root } = build();
    const cards = dom.findAll(root, 'mc-pilot-card');
    cards[0].fire('click');
    cards[3].fire('click');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(PROTAGONISTS[0].id);
    expect(scene.isDecided).toBe(true);
  });

  it('initialId を渡すと、その人物が選択状態で始まる', () => {
    const onSelect = vi.fn();
    const scene = new PilotSelectScene({ onSelect, initialId: PROTAGONISTS[4].id });
    scene.start();
    expect(scene.selectedId).toBe(PROTAGONISTS[4].id);
    dom.key('Enter');
    expect(onSelect).toHaveBeenCalledWith(PROTAGONISTS[4].id);
  });
});
