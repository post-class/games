import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDom, type FakeElement } from './fake-dom';
import { PROTAGONISTS } from '../../src/content/veil/people';
import { speakerName } from '../../src/content/veil/missions/shared';
import {
  PilotSelectScene,
  PROTAGONIST_EFFECTS,
  protagonistDisplayName,
} from '../../src/ui/PilotSelectScene';

/**
 * T3-⑬-3 / -4 主人公選任。
 *
 * - 表記の混在（`朝倉 澪（アサクラ ミオ）` と `Amina Okafor（アミナ・オカフォー）`）を潰す
 * - 「選ぶと何が変わるのか」を画面に出す。**実際に変わるものだけ**を書く
 */

describe('T3-⑬ 主人公選任の表記と「変わること」', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
  });
  afterEach(() => {
    dom.restore();
  });

  it('主人公5名の表記が統一されている（英字と括弧が混ざらない）', () => {
    expect(PROTAGONISTS).toHaveLength(5);
    for (const person of PROTAGONISTS) {
      const shown = protagonistDisplayName(person);
      expect(shown, person.id).not.toMatch(/[（）()]/);
      expect(shown, person.id).not.toMatch(/[A-Za-z]/);
      expect(shown.length, person.id).toBeGreaterThan(0);
    }
    // 5名すべて別の表示名（読みへ潰したせいで同名になっていない）
    expect(new Set(PROTAGONISTS.map(protagonistDisplayName)).size).toBe(5);
  });

  it('表記の整形は speakerName() を使う（各所で括弧の剥がし方を再実装しない）', () => {
    for (const person of PROTAGONISTS) {
      expect(protagonistDisplayName(person)).toBe(speakerName(person.id));
    }
  });

  it('選択画面のカードと詳細に、統一した表記の名前が出る', () => {
    const scene = new PilotSelectScene({ onSelect: vi.fn() });
    const root = scene.el as unknown as FakeElement;
    const names = dom.findAll(root, 'mc-pilot-name').map((e) => e.textContent);
    expect(names).toEqual(PROTAGONISTS.map(protagonistDisplayName));
    // 名簿の生表記（括弧つき）はどこにも出さない
    const text = dom.text(root);
    for (const person of PROTAGONISTS) expect(text).not.toContain(person.name);
    expect(dom.findAll(root, 'mc-pilot-detail-head')[0]?.textContent).toContain(
      protagonistDisplayName(PROTAGONISTS[0]),
    );
  });

  it('「選ぶと何が変わるか／変わらないか」が詳細に出る', () => {
    const scene = new PilotSelectScene({ onSelect: vi.fn() });
    const root = scene.el as unknown as FakeElement;
    const effects = dom.findAll(root, 'mc-pilot-detail-effects')[0]?.textContent ?? '';
    expect(effects).toContain('この選択で変わる');
    expect(effects).toContain('変わらない');
    for (const line of PROTAGONIST_EFFECTS.changes) expect(effects).toContain(line);
    for (const line of PROTAGONIST_EFFECTS.unchanged) expect(effects).toContain(line);
  });

  it('「変わらない」側に、実際に選択で動かない項目が挙がっている', () => {
    // 調査結果: save.protagonistId は表示（ブリーフィングの搭乗者）にしか効かない。
    // ここを緩めるなら、先に実挙動を変えること。
    const unchanged = PROTAGONIST_EFFECTS.unchanged.join(' ');
    expect(unchanged).toContain('技量');
    expect(unchanged).toContain('僚機');
    expect(unchanged).toContain('難易度');
    expect(PROTAGONIST_EFFECTS.changes.join(' ')).toContain('搭乗');
  });
});
