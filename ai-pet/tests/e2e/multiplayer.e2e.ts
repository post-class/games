/**
 * 2ブラウザ同時接続（docs/02_ゲーム実装プラン/10_テストと品質.md §4、09章 M2 の完了条件）
 *
 * 別々の BrowserContext（= 別の localStorage / 別プレイヤー）で同じ島に入り、
 * 互いのアバターが同期されていることを確認する。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  actorIds,
  actorPos,
  chunkHash,
  collectConsoleErrors,
  dist,
  gotoGame,
  meaningfulErrors,
  readDebug,
  readTap,
  walk,
} from './helpers.ts';

interface Player {
  page: Page;
  errors: string[];
}

async function openPlayer(context: BrowserContext): Promise<Player> {
  const page = await context.newPage();
  const errors = collectConsoleErrors(page);
  await gotoGame(page);
  return { page, errors };
}

/** 両者が互いを認識する（actors >= 2）まで待つ */
async function waitForEachOther(players: readonly Player[]): Promise<void> {
  for (const p of players) {
    await expect
      .poll(async () => (await readDebug(p.page)).actors, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
  }
}

function assertNoErrors(players: readonly Player[]): void {
  for (const p of players) {
    const bad = meaningfulErrors(p.errors);
    expect(bad, `コンソールエラー:\n${bad.join('\n')}`).toEqual([]);
  }
}

test.describe('マルチユーザー同期', () => {
  test('2ブラウザが同じ島に入り、互いを認識する', async ({ browser }) => {
    const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
    try {
      const a = await openPlayer(ca);
      const b = await openPlayer(cb);
      await waitForEachOther([a, b]);

      // サーバから見ても互いのIDを保持している
      const ta = await readTap(a.page);
      const tb = await readTap(b.page);
      expect(ta.selfId).not.toBeNull();
      expect(tb.selfId).not.toBeNull();
      expect(ta.selfId, '別プレイヤーとして扱われていません').not.toBe(tb.selfId);
      expect(actorIds(ta), `Aが見ているID=${actorIds(ta)}`).toContain(tb.selfId);
      expect(actorIds(tb), `Bが見ているID=${actorIds(tb)}`).toContain(ta.selfId);

      // 描画にも出ている（cullingを通ってスプライトが立っている）
      for (const p of [a, b]) {
        await expect
          .poll(async () => (await readDebug(p.page)).drawn, { timeout: 20_000 })
          .toBeGreaterThanOrEqual(2);
      }

      assertNoErrors([a, b]);
    } finally {
      await Promise.all([ca.close(), cb.close()]);
    }
  });

  test('相手の移動がもう片方に同期されて見える', async ({ browser }) => {
    const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
    try {
      const a = await openPlayer(ca);
      const b = await openPlayer(cb);
      await waitForEachOther([a, b]);

      const bId = (await readTap(b.page)).selfId;
      expect(bId).not.toBeNull();
      const id = bId as number;

      // A視点で見えているBの位置
      const before = await actorPos(a.page, id);
      expect(before, 'AがBの位置を持っていません').not.toBeNull();

      // Bを右へ歩かせる
      await walk(b.page, 'KeyD', 1500);

      // Aの手元のBの位置が動くまで待つ（4Hzのdeltaで届く）
      await expect
        .poll(async () => dist(await actorPos(a.page, id), before), { timeout: 20_000 })
        .toBeGreaterThan(0.5);

      // Bの自己申告位置とAが見ている位置がほぼ一致していること（同じ島の同じ座標系）
      const bSelf = (await readTap(b.page)).actors[id] ?? null;
      expect(dist(bSelf, await actorPos(a.page, id)), 'AとBで位置が食い違っています').toBeLessThan(2);

      assertNoErrors([a, b]);
    } finally {
      await Promise.all([ca.close(), cb.close()]);
    }
  });

  test('片方を閉じると、もう片方の actors が減る', async ({ browser }) => {
    const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
    let bClosed = false;
    try {
      const a = await openPlayer(ca);
      const b = await openPlayer(cb);
      await waitForEachOther([a, b]);

      const peak = (await readDebug(a.page)).actors;
      const bId = (await readTap(b.page)).selfId;

      await cb.close();
      bClosed = true;

      // 切断はサーバのdeltaで rm として届く
      await expect
        .poll(async () => (await readDebug(a.page)).actors, { timeout: 20_000 })
        .toBeLessThan(peak);
      await expect
        .poll(async () => actorIds(await readTap(a.page)), { timeout: 20_000 })
        .not.toContain(bId);

      // A自身は残っている
      expect((await readDebug(a.page)).actors).toBeGreaterThanOrEqual(1);
      assertNoErrors([a]);
    } finally {
      await ca.close();
      if (!bClosed) await cb.close();
    }
  });

  test('2人が同じ島（同じseed・同じ地形）を見ている', async ({ browser }) => {
    const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
    try {
      const a = await openPlayer(ca);
      const b = await openPlayer(cb);

      // どちらもチャンクが増えていく
      for (const p of [a, b]) {
        await expect
          .poll(async () => (await readDebug(p.page)).chunks, { timeout: 20_000 })
          .toBeGreaterThan(0);
      }

      const ta = await readTap(a.page);
      const tb = await readTap(b.page);
      expect(tb.seed, 'seedが違います（別の島に入っている）').toBe(ta.seed);
      expect(tb.islandId).toBe(ta.islandId);

      // 両方が受け取った共通チャンクの地形が完全一致すること
      const common = Object.keys(ta.chunks).filter((k) => k in tb.chunks);
      expect(common.length, '共通チャンクがありません').toBeGreaterThan(0);
      expect(chunkHash(tb.chunks, common), '同じ座標の地形が食い違っています').toBe(
        chunkHash(ta.chunks, common),
      );

      assertNoErrors([a, b]);
    } finally {
      await Promise.all([ca.close(), cb.close()]);
    }
  });
});
