/**
 * ミニマップのE2E（docs 06章 §2, §5）。
 *
 * 見たいのは「歩いた場所が地図に出るか」「開閉が残るか」「他のUIを隠さないか」。
 * 描画の中身はcanvasなので、ピクセルを直接数えて判定する。
 */
import { expect, test } from '@playwright/test';
import { collectConsoleErrors, ensurePet, gotoGame, meaningfulErrors } from './helpers.ts';

const MAP = '[data-testid=minimap]';
const CANVAS = '[data-testid=minimap-canvas]';
const TOGGLE = '[data-testid=minimap-toggle]';

/** ミニマップに塗られているピクセル数（不透明なもの）を数える */
async function paintedPixels(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!c) return -1;
    const ctx = c.getContext('2d');
    if (!ctx) return -1;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 8) n++;
    return n;
  }, CANVAS);
}

test.describe('ミニマップ', () => {
  test('歩いた範囲が地図に出て、開閉の状態が残る', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await gotoGame(page);
    await ensurePet(page);

    // PCでは既定で開いている
    await expect(page.locator(MAP)).not.toHaveClass(/closed/);

    // 最初の視界ぶんは塗られている
    await expect.poll(async () => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(500);
    const before = await paintedPixels(page);

    // 歩いてチャンクを開くと、塗られた面積が増える。
    // 1チャンク16タイルなので、数タイルでは視界が同じチャンクに収まって増えない。
    // 3秒（≒9タイル）以上歩いて、確実に新しいチャンク列へ入る
    for (const key of ['d', 'd', 's', 's']) {
      await page.keyboard.down(key);
      await page.waitForTimeout(1800);
      await page.keyboard.up(key);
    }
    await expect.poll(async () => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(before);

    // 閉じると地図が消える
    await page.click(TOGGLE);
    await expect(page.locator(MAP)).toHaveClass(/closed/);
    await expect(page.locator(CANVAS)).toBeHidden();

    // 開き直しても閉じたまま（覚えている）
    await page.goto('/?debug=1');
    await page.waitForTimeout(2_000);
    await expect(page.locator(MAP)).toHaveClass(/closed/);

    // 元に戻す（他のテストの既定状態を汚さない）
    await page.click(TOGGLE);
    await expect(page.locator(MAP)).not.toHaveClass(/closed/);

    expect(meaningfulErrors(errors)).toEqual([]);
  });

  test('ミニマップを開いていてもペット情報パネルと重ならない', async ({ page }) => {
    await gotoGame(page);
    await ensurePet(page);
    await expect(page.locator(MAP)).not.toHaveClass(/closed/);

    // Space でペット情報パネルを開く
    await page.keyboard.press('Space');
    await expect(page.locator('.petpanel')).not.toHaveClass(/hidden/);

    const overlaps = await page.evaluate((sel) => {
      const m = document.querySelector(sel)?.getBoundingClientRect();
      const p = document.querySelector('.petpanel')?.getBoundingClientRect();
      if (!m || !p) return null;
      return m.left < p.right && p.left < m.right && m.top < p.bottom && p.top < m.bottom;
    }, CANVAS);
    expect(overlaps).toBe(false);
  });
});
