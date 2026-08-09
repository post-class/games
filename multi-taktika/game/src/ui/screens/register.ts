/**
 * ui/screens/register.ts — 画面の登録簿
 *
 * `main.ts` はこの 1 関数を呼ぶだけ。**画面を 1 つ足すときに触るのはここだけ**なので、
 * 画面を並行して実装しても `main.ts` が編集競合の的にならない。
 *
 * 各画面のモジュールは `Screen` を実装したオブジェクトを 1 つ default 以外の名前で
 * export する（例 `export const titleScreen: Screen`）。
 * まだ実装されていない画面はここに書かない（`router.go` が警告を出して何もしない）。
 *
 * 対戦画面（`match`）は `main.ts` が登録する（シムのループを持つ唯一の画面なので）。
 */

import type { ScreenRouter } from './router';
import { titleScreen } from './Title';
import { matchSetupScreen } from './MatchSetup';
import { civSelectScreen } from './CivSelect';
import { campaignScreen } from './Campaign';
import { resultScreen } from './Result';
import { replayScreen } from './Replay';
import { settingsScreen } from './Settings';

export function registerScreens(router: ScreenRouter): void {
  // ---- 試合前（`05§2`〜`05§5`）----
  router.register('title', titleScreen);
  router.register('matchSetup', matchSetupScreen);
  router.register('civSelect', civSelectScreen);
  router.register('campaign', campaignScreen);

  // ---- 試合後（`05§13`, `05§14`）----
  router.register('result', resultScreen);
  router.register('replay', replayScreen);

  // ---- 設定（`06§12`）----
  router.register('settings', settingsScreen);

  // 実装が入ったら上のコメントを外す。
  void router;
}
