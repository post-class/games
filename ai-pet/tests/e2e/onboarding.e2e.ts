/**
 * 最初の案内と音のE2E（docs 09章 M8）。
 *
 * 確かめたいのは「説明なしで遊び始められるか」の入口部分:
 * - 島に入ると案内が出る
 * - 実際に操作すると次の案内へ進む（読んだかどうかではなく、やったかどうかで進む）
 * - 案内をクリックすると消え、再読込でも出てこない
 * - 音は既定OFFで、押すとONになり、次に開いたときもONのまま
 */
import { expect, test } from '@playwright/test';
import { collectConsoleErrors, ensurePet, gotoGame, meaningfulErrors } from './helpers.ts';

const TUT = '[data-testid=tutorial]';
const AUDIO = '[data-testid=audio-toggle]';

test.describe('最初の案内と音', () => {
  test('案内は操作するたびに次へ進み、クリックで消える', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    // `tut=1` で案内の完了記録を消してから始める
    await gotoGame(page, { tut: '1' });
    await ensurePet(page);

    const tut = page.locator(TUT);
    await expect(tut).toBeVisible();
    await expect(tut).toContainText('WASD');

    // 歩く → 話しかけの案内へ
    await page.keyboard.down('s');
    await page.waitForTimeout(400);
    await page.keyboard.up('s');
    await expect(tut).toContainText('Enter', { timeout: 5_000 });

    // 話しかける → 撫でる案内へ
    await page.click('[data-testid=chat-input]');
    await page.fill('[data-testid=chat-input]', 'おはよう');
    await page.press('[data-testid=chat-input]', 'Enter');
    await expect(tut).toContainText('撫で', { timeout: 5_000 });

    // クリックで全部飛ばせる
    await tut.click();
    await expect(tut).toHaveClass(/hidden/);

    // 開き直しても出てこない（一度終わった案内は二度出さない）。
    // `tut=1` は付けない（付けると記録を消してやり直す指定なので、当然また出る）
    await page.goto('/?debug=1');
    await page.waitForTimeout(2_000);
    await expect(page.locator(TUT)).toHaveClass(/hidden/);

    expect(meaningfulErrors(errors)).toEqual([]);
  });

  test('音は既定OFFで、切り替えると次回も残る', async ({ page }) => {
    await gotoGame(page);
    await ensurePet(page);

    const btn = page.locator(AUDIO);
    await expect(btn).toHaveText('🔇 音なし');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');

    await btn.click();
    await expect(btn).toHaveText('🔊 音あり');
    await expect(btn).toHaveAttribute('aria-pressed', 'true');

    // 次に開いてもONのまま（AudioContextは最初の操作で起こす作りなので、表示で確認する）
    await page.reload();
    await expect(page.locator(AUDIO)).toHaveText('🔊 音あり', { timeout: 30_000 });

    // 戻しておく（他のテストの既定状態を汚さない）
    await page.locator(AUDIO).click();
    await expect(page.locator(AUDIO)).toHaveText('🔇 音なし');
  });
});
