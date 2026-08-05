import { describe, expect, it } from 'vitest';
import { wrapText } from '../src/render/textWrap.js';

/** 1文字 = 10px として測る（Canvas を使わずにテストする）。 */
const measure = (charWidth = 10) => (text: string) => text.length * charWidth;

const wrap = (ctxWidth: number, text: string, maxWidth: number): string[] =>
  wrapText(text, maxWidth, measure(ctxWidth));

describe('wrap', () => {
  it('幅に収まる文はそのまま', () => {
    expect(wrap(10, 'あいうえお', 100)).toEqual(['あいうえお']);
  });

  it('あふれたら折り返す', () => {
    expect(wrap(10, 'あいうえおかきくけこ', 50)).toEqual(['あいうえお', 'かきくけこ']);
  });

  it('改行を尊重する', () => {
    expect(wrap(10, 'あい\nうえ', 100)).toEqual(['あい', 'うえ']);
  });

  it('句読点を行頭に落とさない（禁則処理）', () => {
    // 5文字で折り返す幅。6文字目が「、」なら5文字目の行にぶら下げる。
    const lines = wrap(10, 'あいうえお、かきくけこ', 50);
    for (const line of lines) {
      expect(line.startsWith('、')).toBe(false);
    }
    expect(lines[0]).toBe('あいうえお、');
  });

  it('閉じ括号も行頭に落とさない', () => {
    const lines = wrap(10, 'あいうえお」かきく', 50);
    expect(lines[0]).toBe('あいうえお」');
  });

  it('空文字でも1行返す', () => {
    expect(wrap(10, '', 100)).toEqual(['']);
  });

  it('1文字が幅を超えても無限ループしない', () => {
    const lines = wrap(100, 'あいう', 10);
    expect(lines).toEqual(['あ', 'い', 'う']);
  });
});
