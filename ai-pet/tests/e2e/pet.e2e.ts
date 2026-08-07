/**
 * ペット周りのE2E（docs 09章 M4 の完了条件をブラウザから確認する）。
 *
 * LLMは webServer 側で `--llm=mock` なので応答は決定論的。
 * 「LLMが賢いか」ではなく「UIとサーバの配線が通っているか」を見る。
 */
import { expect, test } from '@playwright/test';
import { collectConsoleErrors, gotoGame, meaningfulErrors, readDebug, walk } from './helpers.ts';

const EGG = '[data-testid=egg-select]';
const CHAT_INPUT = '[data-testid=chat-input]';
const CHAT_LOG = '[data-testid=chat-log]';
const HUD_PET = '[data-testid=hud-pet]';
const PET_PANEL = '[data-testid=pet-panel]';

/** タマゴ選択を済ませてペットを作る */
async function hatch(page: import('@playwright/test').Page, species = 'mizune', name = 'みずね'): Promise<void> {
  await expect(page.locator(EGG)).toBeVisible({ timeout: 20_000 });
  await page.click(`[data-testid=egg-card-${species}]`);
  await page.locator('.egg-tag').first().click();
  await page.fill('[data-testid=egg-name]', name);
  await page.click('[data-testid=egg-decide]');
  await expect(page.locator(EGG)).toHaveCount(0);
  await expect(page.locator(HUD_PET)).toContainText(name, { timeout: 20_000 });
}

test.describe('ペット', () => {
  test('初回はタマゴ選択が出て、選ぶとペットが島に現れる', async ({ browser }) => {
    const context = await browser.newContext(); // localStorageを空にするため新規contextで
    try {
      const page = await context.newPage();
      const errors = collectConsoleErrors(page);
      await gotoGame(page);

      await hatch(page, 'hakka', 'はっか');

      // ペットのアクターが増えている（自分＋ペット）
      await expect.poll(async () => (await readDebug(page)).actors, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
      // 誕生の挨拶が吹き出しで出る
      await expect(page.locator('.bubble')).toHaveCount(1, { timeout: 10_000 });

      expect(meaningfulErrors(errors)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('話しかけると応答が返り、会話ログと吹き出しに出る', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await gotoGame(page);
      await hatch(page);

      await page.fill(CHAT_INPUT, 'おはよう');
      await page.press(CHAT_INPUT, 'Enter');

      // 自分の発言はすぐ出る
      await expect(page.locator(CHAT_LOG)).toContainText('おはよう', { timeout: 5_000 });
      // ペットの応答（mockなので必ず返る）
      await expect.poll(async () => (await page.locator(CHAT_LOG).textContent()) ?? '', { timeout: 25_000 })
        .toMatch(/みずね/);
      await expect(page.locator('.bubble')).toHaveCount(1, { timeout: 10_000 });
    } finally {
      await context.close();
    }
  });

  test('会話のあともWASDで歩ける（入力欄にフォーカスが残らない）', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await gotoGame(page);
      await hatch(page);

      await page.fill(CHAT_INPUT, 'やあ');
      await page.press(CHAT_INPUT, 'Enter');
      await expect(page.locator(CHAT_LOG)).toContainText('やあ');

      const before = (await readDebug(page)).pos;
      await walk(page, 'KeyD', 2000);
      const after = (await readDebug(page)).pos;
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      const moved = Math.hypot((after?.x ?? 0) - (before?.x ?? 0), (after?.y ?? 0) - (before?.y ?? 0));
      expect(moved, `移動距離 ${moved.toFixed(2)}`).toBeGreaterThan(1);
    } finally {
      await context.close();
    }
  });

  test('ペットが歩いてついてくる', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await gotoGame(page);
      await hatch(page, 'momona', 'ももな');

      // 少し歩いて、ペットが画面内に居続けることを確認する
      await walk(page, 'KeyS', 2500);
      await page.waitForTimeout(1500);
      await expect.poll(async () => (await readDebug(page)).drawn, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    } finally {
      await context.close();
    }
  });

  test('Spaceでペット情報パネルが開き、なつき度が見える', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await gotoGame(page);
      await hatch(page, 'hoshira', 'ほしら');

      await page.keyboard.press('Space');
      await expect(page.locator(PET_PANEL)).toBeVisible();
      await expect(page.locator(PET_PANEL)).toContainText('なつき度');
      await expect(page.locator(PET_PANEL)).toContainText('ほしら');

      // もう一度押すと閉じる
      await page.keyboard.press('Space');
      await expect(page.locator(PET_PANEL)).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test('リロードしてもペットが残る（DBに保存されている）', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await gotoGame(page);
      await hatch(page, 'mofi', 'もふぃ');

      await page.reload();
      await expect(page.locator(HUD_PET)).toContainText('もふぃ', { timeout: 20_000 });
      // 2回目はタマゴ選択が出ない
      await expect(page.locator(EGG)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
