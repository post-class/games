/**
 * 重なるパネルの CSS の約束（T-M18-06 の目視レビューで見つけた 4 件の回帰）。
 *
 * ■ なぜ CSS をテストするのか
 * この 4 件はどれも**単体テストが全部緑のまま**実機で壊れていた。
 * 型でも lint でも捕まらず、DOM を組む単体テストでも（jsdom は
 * ブラウザ既定のスタイルを完全には持たないので）気付けない。
 * 「実機で 1 回見る」以外に見つける方法が無かったものを、
 * **せめて二度と戻らないように CSS の文面で固定する**。
 *
 * 見つかった 4 件:
 *  1. `hidden` 属性が効かない（`display: flex` がクラス指定なので勝ってしまう）
 *     → 試合中メニューが**常に開いたまま盤面を覆っていた**
 *  2. パネルの下地が 0.94 で、下にある箱の**文字が透けて重なって読めた**
 *  3. 情報パネルが**小地図の上に重なっていた**
 *  4. 画面本文に `overflow-y` が無く、下端のボタン列が本文に重なっていた
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const STYLES = new URL('../../src/styles/', import.meta.url);

async function css(name: string): Promise<string> {
  return readFile(new URL(name, STYLES), 'utf-8');
}

/**
 * `.cls { ... }` の宣言ブロックを取り出す。
 *
 * **コメントは落とす。** ここでは「なぜその値なのか」を長いコメントで残しているので、
 * 落とさないとコメント中の `left: 20px`（＝以前の値の説明）を実際の値だと誤読する
 * （このテストを書いたときに実際に踏んだ）。
 */
function block(source: string, selector: string): string | null {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = bare.indexOf(`${selector} {`);
  if (at < 0) return null;
  const end = bare.indexOf('}', at);
  return end < 0 ? null : bare.slice(at, end);
}

describe('1. hidden 属性が効くこと', () => {
  it('`display` を持つ重なり要素には `[hidden]` の規則が要る', async () => {
    // `hidden` の `display: none` はブラウザ既定のスタイルなので、
    // クラス指定の `display` に**負ける**。効かせるには明示が必要。
    const gameMenu = await css('gameMenu.css');
    expect(block(gameMenu, '.mt-gmenu')).toContain('display: flex');
    expect(gameMenu, '.mt-gmenu[hidden] の規則が無い').toContain('.mt-gmenu[hidden]');
    expect(block(gameMenu, '.mt-gmenu[hidden]')).toContain('display: none');
  });

  it('学舎の注記も同じ（列の中に混ぜないので独立した要素になった）', async () => {
    const panels = await css('panels.css');
    expect(panels).toContain('.mt-tech-empty[hidden]');
  });

  it('情報パネルにも `[hidden]` がある', async () => {
    const result = await css('result.css');
    expect(result).toContain('.mt-info-panel[hidden]');
  });
});

describe('2. パネルの下地は「ほぼ不透過」', () => {
  /** `rgba(r,g,b,a)` の a を取り出す。 */
  function alphaOf(text: string): number | null {
    const m = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/.exec(text);
    return m === null ? null : Number(m[1]);
  }

  it('共通のパネル下地の不透明度が 0.98 以上', async () => {
    const panels = await css('panels.css');
    const line = panels.split('\n').find((l) => l.includes('--mt-panel-bg'));
    expect(line, '--mt-panel-bg が見つからない').toBeDefined();
    const a = alphaOf(line!);
    expect(a, '下地が透けすぎ（下の文字が重なって読めなくなる）').toBeGreaterThanOrEqual(0.98);
  });

  it('情報パネルの下地も同じ基準', async () => {
    const b = block(await css('result.css'), '.mt-info-panel');
    expect(b).not.toBeNull();
    const a = alphaOf(b!.slice(b!.indexOf('background')));
    expect(a).toBeGreaterThanOrEqual(0.98);
  });
});

describe('3. 情報パネルは小地図を避ける', () => {
  it('左端が小地図の右側から始まる', async () => {
    const b = block(await css('result.css'), '.mt-info-panel');
    expect(b).not.toBeNull();
    const m = /left:\s*(\d+)px/.exec(b!);
    expect(m, 'left が px 指定でない').not.toBeNull();
    // 小地図は左端 20px から 200px 弱を占める。それより右から始めること。
    expect(Number(m![1]), '小地図に重なる位置から始まっている').toBeGreaterThan(213);
  });

  it('右端は 20px で止める（左右の余白 20px の規約）', async () => {
    const b = block(await css('result.css'), '.mt-info-panel');
    expect(b).toContain('right: 20px');
  });
});

describe('4. 画面本文は中でスクロールする', () => {
  it('`.mt-screen-body` に overflow-y がある（フッタが本文に重ならない）', async () => {
    const b = block(await css('result.css'), '.mt-screen-body');
    expect(b).not.toBeNull();
    expect(b, 'min-height:0 だけでは足りない（本文が伸びきってフッタと重なる）').toContain(
      'overflow-y: auto',
    );
  });
});

describe('左右の余白 20px（コーディング規約）', () => {
  it('重なるパネルの横位置は 20px 起点で、固定幅にしない', async () => {
    const gameMenu = await css('gameMenu.css');
    // メニューの箱は「画面幅 - 40px」を上限に伸び縮みする
    expect(block(gameMenu, '.mt-gmenu-box')).toContain('calc(100vw - 40px)');
  });
});
