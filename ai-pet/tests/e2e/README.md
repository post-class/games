# E2E テスト（Playwright）

『ぽこもふ島』のブラウザE2E。`docs/02_ゲーム実装プラン/10_テストと品質.md` §4 のシナリオを実装している。

## 実行

```bash
cd ai-pet
npm run test:e2e                       # 全部
npm run test:e2e -- --grep マルチ       # テスト名で絞る
npm run test:e2e -- --headed           # 画面を見ながら
npm run test:e2e -- --debug            # Inspectorで1手ずつ
```

初回だけ: `npx playwright install chromium`

## 前提と仕組み

- `playwright.config.ts` の `webServer` が **サーバとViteの両方を自動起動**する。手動で `npm run dev` を上げておく必要はない（むしろ上げないこと）。
- ポートは開発用と分けている: **サーバ 8788 / クライアント 5199**（開発用は 8787 / 5173）。
  `packages/client/vite.config.ts` のproxy先は 8787 固定なので、
  `tests/e2e/vite.e2e.config.ts` がその設定を読み込んで **ポートとproxy先だけ上書き**している。
  クライアント側のコードは一切変更していない。
- サーバは `--llm=mock` で起動（LLMを呼ばない）。`ISLAND_SEED=e2e-seed`、`DB_PATH=.tmp/e2e-island.db`。
- `tests/e2e/reset-db.ts` が **サーバ起動の直前に** `.tmp/e2e-island.db` を消す（毎回まっさらな島から始める）。
  globalSetup ではやらない: Playwright は webServer を globalSetup より先に起動するので、
  globalSetup で消すと「サーバが開いた直後のDBファイルを消す」ことになり永続化が効かなくなる（実測）。
- テストは `workers: 1` の直列。1つのサーバ（= 1つの島）を共有するため。

### 検証の主要な窓口

| 窓口 | 何が読めるか |
|---|---|
| `[data-testid=debug-panel]`（`?debug=1`） | fps / renderer / net / tick / actors / drawn / chunks / zoom / pos |
| `[data-testid=hud-net]` | 接続表示（接続中… / 接続OK / 再接続中… / 切断） |
| WSタップ（`installWsTap`） | サーバ真値（seed / islandId / 自分と他人の位置 / 地形RLE / 受信tick） |

WSタップは `page.addInitScript` で `window.WebSocket` を包んで受信メッセージを覗く仕込み。
**テスト側だけの仕掛けで、製品コードは変更していない**。
これによりクライアントの内部状態に依存せず、「2人が同じ島を見ているか」を
地形RLEのハッシュで厳密に比較できる。

## ファイル

| ファイル | 内容 |
|---|---|
| `helpers.ts` | `gotoGame` / `readDebug` / `readTap` / `walk` / `wheelZoom` / `forceDisconnect` など |
| `constants.ts` | ポート・DBパス・seed（`playwright.config.ts` と共有） |
| `reset-db.ts` | E2E用DBの削除（サーバ起動の前段で実行） |
| `vite.e2e.config.ts` | E2E用Vite設定（ポートとproxy先の上書きだけ） |
| `basic.e2e.ts` | 起動・描画・fps・移動・ズーム・リロードで同じ島 |
| `multiplayer.e2e.ts` | 2ブラウザの相互認識・移動同期・切断で減る・同じ島 |
| `reconnect.e2e.ts` | 強制切断 → 自動再接続 |

> ファイル名が `*.spec.ts` ではなく `*.e2e.ts` なのは、
> `vitest.config.ts` の `include` が `tests/**/*.spec.ts` で、`npm test`（Vitest）に
> 拾われてしまうのを避けるため。Vitest側で `tests/e2e/**` を除外したら `*.spec.ts` に戻してよい
> （`playwright.config.ts` の `testMatch` も合わせて変える）。

## 落ちたときの調べ方

1. **まずレポートを見る**（失敗時はスクリーンショットとtraceが自動で残る）

   ```bash
   npx playwright show-trace test-results/<テスト名>/trace.zip
   ```

   traceにはDOMスナップショット・コンソール・ネットワークが全部入っている。

2. **サーバのログを見る**。`webServer` の出力は `[WebServer]` プレフィックス付きで
   テスト出力に混ざっている。`[hub] 新規 …` が出ていなければWSが繋がっていない。

3. **手で再現する**

   ```bash
   PORT=8788 ISLAND_SEED=e2e-seed DB_PATH=.tmp/e2e-island.db node packages/server/src/main.ts --llm=mock
   npx vite --config tests/e2e/vite.e2e.config.ts --port 5199
   # → http://localhost:5199/?debug=1
   ```

4. **ポートが埋まっている**（`strictPort` で即エラーになる）

   ```bash
   lsof -ti:5199,8788 | xargs kill
   ```

### よくある原因

| 症状 | 原因 |
|---|---|
| 起動オーバーレイが消えない | `welcome` が来ていない。サーバが落ちている / `/ws` proxyの向き先が違う |
| `chunks` が 0 のまま | `chunkReq` の往復が失敗している。サーバログの `[hub]` を確認 |
| fps が 30 未満 | ヘッドレスのWebGLが落ちてCanvasになっている（パネルの `render` を見る） |
| `actors` が 2 にならない | 興味管理の範囲外に出た / 相手のwelcomeがまだ来ていない |
| 再接続テストが固まる | ViteのHMRソケットを閉じるとViteが `location.reload()` する。`forceDisconnect` は `/ws` だけを閉じているので、勝手に対象を広げないこと |

## 書くときの決めごと

- `page.waitForTimeout` の固定待ちは「キーを押し続ける時間」など**意味のある時間**だけ。
  状態の待ちは `expect.poll` / `waitForFunction` にする（4Hz tick なので数秒待つ設計）。
- `Math.random()` は使わない。
- コンソールエラーは各テストで集め、失敗時にメッセージへ出す。
  ただしオフライン化で必然的に出るWSエラーは `meaningfulErrors()` で除外する。
- テスト名・コメントは日本語。
