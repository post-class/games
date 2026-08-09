import { describe, expect, it } from 'vitest';
import { VEIL_CHAPTERS } from '../../src/content/veil/chapters';

/**
 * 章ごとのブリーフィング背景（`public/art/tex/story-chNN.jpg`）が実在することを確かめる。
 *
 * 背景の 404 は画面が黒くなるだけでコンソールにしか出ないため、
 * ここで実ファイルを列挙して回帰を止める（`node:fs` は型が入っていないので
 * Vite の `import.meta.glob` を使う。既存の portrait-assets.test.ts と同じ流儀）。
 */
const files = import.meta.glob('../../public/art/tex/story-ch*.jpg', { eager: true, query: '?url' });
const names = new Set(
  Object.keys(files).map((path) => path.slice(path.lastIndexOf('/') + 1)),
);

describe('章ごとのブリーフィング背景', () => {
  it('十章ぶんの画像が揃っている', () => {
    expect(names.size).toBe(VEIL_CHAPTERS.length);
  });

  it('各章に対応するファイルが実在する', () => {
    for (const chapter of VEIL_CHAPTERS) {
      const file = `story-ch${String(chapter.chapter).padStart(2, '0')}.jpg`;
      expect(names.has(file), `${file} が見つからない（第${chapter.chapter}章の背景）`).toBe(true);
    }
  });

  it('章データ側の元画像パスも章番号と対応している', () => {
    for (const chapter of VEIL_CHAPTERS) {
      expect(chapter.image).toContain(`ch${String(chapter.chapter).padStart(2, '0')}/`);
    }
  });
});
