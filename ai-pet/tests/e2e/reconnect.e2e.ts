/**
 * WS切断と自動再接続（docs/02_ゲーム実装プラン/10_テストと品質.md §4、09章 M2 の完了条件）
 *
 * 切断の作り方について:
 * Chromium の `context.setOffline(true)` は **新規接続を止めるだけ**で、
 * すでに確立しているWebSocketは切らない（実測）。
 * そのため「オフラインにする → 開いているソケットを明示的に閉じる」の2段構えで、
 * 「回線が落ちて、繋ぎ直そうとしても繋がらない」状況を再現している。
 * オンラインに戻したら指数バックオフ（500ms → 最大8秒）で自動復帰することを確認する。
 */
import { expect, test } from '@playwright/test';
import {
  HUD_NET,
  actorIds,
  collectConsoleErrors,
  forceDisconnect,
  gotoGame,
  meaningfulErrors,
  readDebug,
  readTap,
} from './helpers.ts';

/** バックオフ最大8秒＋接続にかかる時間を見込んだ余裕 */
const RECONNECT_TIMEOUT = 30_000;

/** 回線を落として、開いているWSを切る */
async function goOffline(page: import('@playwright/test').Page, context: import('@playwright/test').BrowserContext): Promise<void> {
  await context.setOffline(true);
  const closed = await forceDisconnect(page);
  expect(closed, '閉じられるWSが見つかりませんでした（WSタップが動いていない）').toBeGreaterThan(0);
  // 「クライアントが切断に気づいた」ことを確認する。
  //
  // 判定を**履歴だけに頼らない**のが要点。DOMの変化履歴（netLabels）は
  // 「再接続中…」が数百msしか出ない場合に取りこぼすことがあり、実測で3〜6回に1回落ちていた。
  // `setOffline(true)` の間は再接続に失敗し続けるので**現在の状態も reconnecting/connecting のまま**。
  // そこで「履歴に出た」か「いまその状態にある」のどちらかで通す。
  // （履歴側は main.ts の renderNet が発生源で push する `__netTrace` も合流させてある）
  let seen: string[] = [];
  let liveNet = '';
  await expect
    .poll(
      async () => {
        seen = (await readTap(page)).netLabels;
        liveNet = (await readDebug(page)).net;
        return seen.some((l) => /再接続中…|切断/.test(l)) || /reconnecting|closed|connecting/.test(liveNet);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  // 落ちたときに何が観測できていたのか分かるようにする（原因の切り分けで毎回ここを疑うため）
  expect(
    seen.some((l) => /再接続中…|切断/.test(l)) || /reconnecting|closed|connecting/.test(liveNet),
    `切断を観測できませんでした。netLabels=${JSON.stringify(seen)} net=${liveNet}`,
  ).toBe(true);
}

test.describe('再接続', () => {
  test('切断で「再接続中…」になり、復帰すると「接続OK」に戻る', async ({ page, context }) => {
    const errors = collectConsoleErrors(page);
    await gotoGame(page);

    await expect(page.locator(HUD_NET)).toContainText('接続OK');
    // HUDのtickは切断中もクライアント側で進む（main.ts が1秒ごとに+4する）ので、
    // 「サーバから届いたtick」を見る必要がある
    const beforeTick = (await readTap(page)).lastTick;
    const beforeWelcome = (await readTap(page)).welcomeCount;

    // ---- 切断 ----
    await goOffline(page, context);
    // 切断状態の観測は取りこぼしうる（デバッグパネルは500msごと更新・再接続は最短500ms）。
    // 「切断が見えた」か「再接続してwelcomeを受け直した」のどちらかで判定する。
    await expect
      .poll(
        async () => {
          const net = (await readDebug(page)).net;
          if (/reconnecting|closed|connecting/.test(net)) return true;
          return (await readTap(page)).welcomeCount > beforeWelcome;
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // ---- 復帰 ----
    await context.setOffline(false);

    await expect(page.locator(HUD_NET)).toContainText('接続OK', { timeout: RECONNECT_TIMEOUT });
    await expect
      .poll(async () => (await readDebug(page)).net, { timeout: RECONNECT_TIMEOUT })
      .toBe('open');

    // サーバから届くtickが再び進む
    await expect
      .poll(async () => (await readTap(page)).lastTick, { timeout: RECONNECT_TIMEOUT })
      .toBeGreaterThan(beforeTick);

    // 再接続後もアバターが表示されている
    await expect
      .poll(async () => (await readDebug(page)).actors, { timeout: RECONNECT_TIMEOUT })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(async () => (await readDebug(page)).drawn, { timeout: RECONNECT_TIMEOUT })
      .toBeGreaterThanOrEqual(1);

    // WS失敗のログは「テストが意図して起こしたもの」なので除外して判定する
    const bad = meaningfulErrors(errors);
    expect(bad, `コンソールエラー:\n${bad.join('\n')}`).toEqual([]);
  });

  test('再接続後もwelcomeを受け直して同じ島に戻る', async ({ page, context }) => {
    await gotoGame(page);
    // ⚠️ **切る前に「繋がりきった」ことを待つ。**
    // これが無いと接続が落ち着く前に切ってしまい、goOffline が切断を観測できずに落ちる
    // （同じ helper を使うもう一方のテストにはこの待機があり、そちらだけ安定していた）。
    await expect(page.locator(HUD_NET)).toContainText('接続OK');
    const before = await readTap(page);
    expect(before.welcomeCount).toBe(1);
    expect(before.seed).not.toBeNull();

    await goOffline(page, context);
    await context.setOffline(false);

    // 2回目のwelcomeが届く
    await expect
      .poll(async () => (await readTap(page)).welcomeCount, { timeout: RECONNECT_TIMEOUT })
      .toBeGreaterThanOrEqual(2);

    const after = await readTap(page);
    expect(after.seed, '再接続で別の島になっています').toBe(before.seed);
    expect(after.islandId).toBe(before.islandId);
    expect(after.selfId).not.toBeNull();
    expect(actorIds(after), '再接続後に自機がいません').toContain(after.selfId);

    // 地形も届き続ける（チャンク再要求が働いている）
    await expect
      .poll(async () => (await readDebug(page)).chunks, { timeout: RECONNECT_TIMEOUT })
      .toBeGreaterThan(0);
  });

  /**
   * docs 09章 M2 の完了条件「サーバを再起動しても、リロードで元の位置・同じ島に戻る」。
   *
   * skip の理由: サーバは `playwright.config.ts` の `webServer` が管理しているので、
   * テストから止めて起動し直せない（PIDを持っていない）。
   * また、このシナリオで確かめたいのはサーバの永続化とプロトコルであって描画ではないため、
   * ブラウザを介さない統合テストのほうが速く確実。
   *
   * → **`tests/integration/restart.spec.ts` に実装済み**
   *   （子プロセスで実サーバを起こし、移動→SIGINT→再起動→同じsecretで再接続して位置を検証する）
   *   サーバに再起動用のデバッグエンドポイントを足す案は、本番に不要な操作口を増やすので採らなかった。
   */
  test.skip('サーバ再起動をまたいでも元の位置・同じ島に戻る（tests/integration/restart.spec.ts に移設）', () => {
    // ここでは実施しない（上のコメント参照）
  });
});
