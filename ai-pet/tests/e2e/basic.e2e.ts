/**
 * 起動・描画・操作の基本（docs/02_ゲーム実装プラン/10_テストと品質.md §4）
 *
 * 「島が出て、歩けて、ズームできて、リロードしても同じ島」までを1人ぶんで確認する。
 */
import { expect, test } from '@playwright/test';
import {
  chunkHash,
  collectConsoleErrors,
  gotoGame,
  meaningfulErrors,
  readDebug,
  readTap,
  selfPos,
  shotCanvas,
  waitForTick,
  walk,
  wheelZoom,
  ensurePet,
} from './helpers.ts';

/** チャンクが焼成されるまで待つ（250msごとに要求される） */
async function waitForTerrain(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(async () => (await readDebug(page)).chunks, { timeout: 20_000 })
    .toBeGreaterThan(0);
}

test.describe('基本動作（1人）', () => {
  test('起動して地形が描画され、fpsが出て、コンソールエラーが無い', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await gotoGame(page);
    await waitForTerrain(page);

    // fpsはパネルが500msごとに更新する。最初の窓は計測が荒いので数回ぶん待つ
    await expect.poll(async () => (await readDebug(page)).fps, { timeout: 20_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1500);

    const d = await readDebug(page);
    expect(d.fps, `fpsが低すぎます: ${JSON.stringify(d)}`).toBeGreaterThanOrEqual(30);
    expect(d.net, `接続状態が open ではありません: ${JSON.stringify(d)}`).toBe('open');
    expect(d.chunks).toBeGreaterThan(0);
    expect(d.actors, '自分のアバターが1体もいません').toBeGreaterThanOrEqual(1);
    expect(d.drawn).toBeGreaterThanOrEqual(1);

    const bad = meaningfulErrors(errors);
    expect(bad, `コンソールエラー:\n${bad.join('\n')}`).toEqual([]);
  });

  test('サーバのtickが進み続ける（4Hz）', async ({ page }) => {
    await gotoGame(page);
    const before = (await readTap(page)).lastTick;
    // 8tick（=2秒ぶん）進めば「止まっていない」と言える
    await waitForTick(page, before + 8);
    expect((await readTap(page)).lastTick).toBeGreaterThan(before);
  });

  test('WASDで移動できる', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await gotoGame(page);
    await waitForTerrain(page);
    // 地形が届く前に歩くと予測が滑るので、少し落ち着かせる
    await page.waitForTimeout(500);

    const from = await selfPos(page);
    expect(from, '自機の位置が取得できません（WSタップが動いていない可能性）').not.toBeNull();
    const beforeShot = await shotCanvas(page);

    // 4方向すべて試し、どれかで確実に動くようにする
    // （spawnが広場の中心なので、いずれの方向にも歩ける）
    await walk(page, 'KeyD', 1200);
    await walk(page, 'KeyS', 1200);

    const to = await selfPos(page);
    expect(to).not.toBeNull();
    const moved = Math.hypot((to?.x ?? 0) - (from?.x ?? 0), (to?.y ?? 0) - (from?.y ?? 0));
    expect(moved, `位置が動いていません from=${JSON.stringify(from)} to=${JSON.stringify(to)}`)
      .toBeGreaterThan(0.5);

    // 画面にも反映されていること（カメラ追従 or アバターの移動でピクセルが変わる）
    const afterShot = await shotCanvas(page);
    expect(afterShot.equals(beforeShot), '画面が全く変化していません').toBe(false);

    const bad = meaningfulErrors(errors);
    expect(bad, `コンソールエラー:\n${bad.join('\n')}`).toEqual([]);
  });

  test('ホイールでズームが3段変わる', async ({ page }) => {
    await gotoGame(page);
    await waitForTerrain(page);
    // タマゴ選択のモーダルが前面にあるとキャンバスにホイールが届かないので先に片付ける
    await ensurePet(page);

    // 既定は 1.00（ZOOM_STEPS = [0.75, 1.0, 1.5] の中央）
    await expect.poll(async () => (await readDebug(page)).zoom).toBeCloseTo(1.0, 2);

    // 寄る → 1.50（上限なのでもう1回回しても変わらない）
    await wheelZoom(page, 1);
    await expect.poll(async () => (await readDebug(page)).zoom).toBeCloseTo(1.5, 2);

    // 引く → 1.00 → 0.75
    await wheelZoom(page, -1);
    await expect.poll(async () => (await readDebug(page)).zoom).toBeCloseTo(1.0, 2);
    await wheelZoom(page, -1);
    await expect.poll(async () => (await readDebug(page)).zoom).toBeCloseTo(0.75, 2);

    // 下限を超えて回しても壊れない
    await wheelZoom(page, -1);
    await expect.poll(async () => (await readDebug(page)).zoom).toBeCloseTo(0.75, 2);
  });

  test('リロードしても同じ島（seedと地形ハッシュが一致する）', async ({ page }) => {
    await gotoGame(page);
    await waitForTerrain(page);
    // 受信チャンクが増える途中で撮ると比較対象がズレるので、増えなくなるまで待つ
    const first = await settleChunks(page);

    await gotoGame(page);
    await waitForTerrain(page);
    const second = await settleChunks(page);

    expect(second.seed, 'seedが変わっています').toBe(first.seed);
    expect(second.islandId).toBe(first.islandId);

    // 両方が受信したチャンクだけを比べる（受信タイミングで枚数は前後する）
    const common = Object.keys(first.chunks).filter((k) => k in second.chunks);
    expect(common.length, '比較できるチャンクがありません').toBeGreaterThan(0);
    expect(chunkHash(second.chunks, common), '地形が変わっています').toBe(
      chunkHash(first.chunks, common),
    );
  });
});

/** チャンク受信が落ち着くまで待ってからタップ内容を返す */
async function settleChunks(page: import('@playwright/test').Page): Promise<
  Awaited<ReturnType<typeof readTap>>
> {
  let previous = -1;
  await expect
    .poll(
      async () => {
        const count = Object.keys((await readTap(page)).chunks).length;
        const stable = count > 0 && count === previous;
        previous = count;
        return stable;
      },
      { timeout: 20_000, intervals: [500, 500, 500, 700] },
    )
    .toBe(true);
  return readTap(page);
}
