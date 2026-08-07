/**
 * スマホ画面のレイアウトと操作のE2E（docs 09章 M8）。
 *
 * `mobile` プロジェクト（iPhone 14相当・タッチあり）でだけ回る。
 * ここで見たいのは「狭い縦長画面でしか出ない崩れ」なので、
 * fpsのような環境依存の数値ではなく、位置関係と操作の結果を見る。
 *
 * 横スクロールと要素の重なりは、実機で触ったときに最初に気づく類の崩れなので
 * 数値で固定しておく（過去に卵選択で横スクロールが出た）。
 */
import { expect, test } from '@playwright/test';
import { collectConsoleErrors, ensurePet, gotoGame, meaningfulErrors, readDebug } from './helpers.ts';

/** 重なりを見る相手（案内バナーが隠してはいけないもの） */
const OTHERS = '.hud-chip, .chat, .pad-btn';

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

async function boxOf(page: import('@playwright/test').Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`要素が見つかりません: ${selector}`);
  return { top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width };
}

test.describe('スマホ画面', () => {
  test('横スクロールが出ず、案内バナーがHUDや操作ボタンに重ならない', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    // pad=1 でバーチャルパッドを必ず出す（タッチ判定に依存させない）
    await gotoGame(page, { pad: '1', tut: '1' });
    await ensurePet(page);

    // 横スクロールが出ていない
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(widths.scroll).toBe(widths.inner);

    // タッチ端末にキーの名前を出しても伝わらないので、言い換えられていること
    const tutText = await page.locator('[data-testid=tutorial]').textContent();
    expect(tutText).not.toContain('WASD');
    expect(tutText).toContain('タップ');

    // 案内バナーが他のUIと重なっていない
    const tut = await boxOf(page, '[data-testid=tutorial]');
    const hits = await page.evaluate(
      ({ t, sel }) => {
        const out: string[] = [];
        const tut = document.querySelector('[data-testid=tutorial]');
        for (const el of document.querySelectorAll(sel)) {
          // 狭い画面では案内バナーはチャット欄の中に入る。
          // 入れ物との「重なり」は当然なので、祖先は数えない
          if (tut && el.contains(tut)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const overlap = t.left < r.right && r.left < t.right && t.top < r.bottom && r.top < t.bottom;
          if (overlap) out.push(`${el.className}「${(el.textContent ?? '').trim().slice(0, 12)}」`);
        }
        return out;
      },
      { t: tut, sel: OTHERS },
    );
    expect(hits, `案内バナーが重なっている相手:\n${hits.join('\n')}`).toEqual([]);

    expect(meaningfulErrors(errors)).toEqual([]);
  });

  test('バーチャルパッドで実際に移動できる', async ({ page }) => {
    await gotoGame(page, { pad: '1' });
    await ensurePet(page);

    const before = (await readDebug(page)).pos;
    expect(before).not.toBeNull();

    // スティックの中心から右下へ押し込んだままにする
    const stick = await boxOf(page, '[data-testid=pad-stick]');
    const cx = (stick.left + stick.right) / 2;
    const cy = (stick.top + stick.bottom) / 2;
    await page.touchscreen.tap(cx, cy); // 先に触れてスティックを起こす
    await page.locator('[data-testid=pad-stick]').dispatchEvent('pointerdown', {
      pointerId: 1,
      clientX: cx,
      clientY: cy,
      isPrimary: true,
    });
    await page.locator('[data-testid=pad-stick]').dispatchEvent('pointermove', {
      pointerId: 1,
      clientX: cx + 40,
      clientY: cy,
      isPrimary: true,
    });

    // 4Hzのサーバtickを何回かまたぐまで押し続ける
    await expect
      .poll(async () => {
        const now = (await readDebug(page)).pos;
        return now && before ? now.x - before.x : 0;
      }, { timeout: 15_000 })
      .toBeGreaterThan(1);

    await page.locator('[data-testid=pad-stick]').dispatchEvent('pointerup', {
      pointerId: 1,
      clientX: cx + 40,
      clientY: cy,
      isPrimary: true,
    });

    // 離したら止まる。
    // デバッグパネルは500msごとにしか書き換わらないので、
    // 離した直後の値は「押していたころの位置」を指している。1周期待ってから測る
    await page.waitForTimeout(800);
    const stopped = (await readDebug(page)).pos;
    await page.waitForTimeout(1500);
    const after = (await readDebug(page)).pos;
    expect(Math.abs((after?.x ?? 0) - (stopped?.x ?? 0))).toBeLessThan(0.6);
  });
});
