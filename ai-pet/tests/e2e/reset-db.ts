/**
 * E2E用DBの初期化。**サーバを起動する直前に**実行する。
 *
 * `playwright.config.ts` の webServer コマンドの前段に置いている。
 * globalSetup ではなくここでやる理由:
 * Playwright は **webServer を globalSetup より先に起動する**ため、
 * globalSetup で消すと「サーバが開いた直後のDBファイルを消す」ことになり、
 * サーバは unlink 済みの inode に書き続けて永続化が効かなくなる（実測）。
 *
 * 実行: `node tests/e2e/reset-db.ts`
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { E2E_DB_PATH } from './constants.ts';

const target = resolve(process.cwd(), process.env['DB_PATH'] ?? E2E_DB_PATH);

// 安全弁: `.tmp/` 配下以外は消さない。
// DB_PATH を渡し間違えたときに開発用の島（data/island.db）を消してしまうのを防ぐ。
if (!target.includes('/.tmp/')) {
  console.error(`[e2e] DB_PATH が .tmp/ 配下ではないため中止します: ${target}`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
// WAL / SHM / journal も残っていると前回の状態を引きずるので一緒に消す
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  rmSync(target + suffix, { force: true });
}
console.log(`[e2e] DBを初期化しました: ${target}`);
