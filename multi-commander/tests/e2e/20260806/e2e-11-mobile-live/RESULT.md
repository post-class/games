# E2E-11 モバイル／タッチ相当・自然プレイ戦闘確認

結果: PASS（横画面の表示欠けを修正後に再確認。自然戦闘・任務失敗も確認済み）

実施方式: Playwright headless MCP / `http://127.0.0.1:4173/`

## 実施済み

- viewport `390x844` でタイトル画面を確認。
- タイトルから「新しい戦役を始める」をクリックし、母艦画面を確認。
- 母艦の「設定」をクリックし、設定画面を確認。
- 設定の「操作」をPlaywright mouse相当（`page.mouse.move/down/up`）でクリック。
- 設定の「オーディオ」を`PointerEvent(pointerType: "touch")`相当で操作し、オーディオ設定表示を確認。
- 母艦の「ブリーフィング室」をクリックし、ブリーフィング画面を確認。
- 各確認画面についてfullPage PNGとアクセシビリティsnapshot MDを保存。
- 画面のoverflow／スクロールを確認。`390x844`では`scrollWidth=390`、`scrollHeight=844`、`scrollY=0`で、検出できるスクロール可能要素はなかった。マウスホイール操作後もスクロール位置は変化しなかった。調査結果は`06-scrollable-elements-briefing.json`に保存。
- viewport `844x390`でタイトル、母艦、設定、ブリーフィング、訓練室を確認し、`scrollWidth=844`で横方向のはみ出しがないことを確認。
- 母艦から`patrol`訓練を開始し、自然発生した敵のターゲット表示、被弾による機体状態変化、任務失敗画面を確認。証跡は`09-natural-patrol-combat`に保存。

## 初回レビューで判明した表示不具合と修正後確認

- 初回は上記4画面で表示欠けを検出した。
- CSS修正後、`844x390`でタイトル、母艦、設定、ブリーフィング、訓練室を再撮影し、全メニュー項目がviewport内に表示され、横方向overflowがないことを確認した。
- 初回レビューの詳細と修正後の証跡は`../../20260807/evidence-review/RESULT.md`に記録。

## 未完了

- 自然戦闘での正常な`A`帰投からデブリーフ到達は未実施（任務失敗は確認済み）。

## サーバー／console

確認中に`127.0.0.1:4173`のVite接続が一度切断されたため、同URLのpreview serverを再起動して確認を継続した。`console-errors.txt`に記録された27件は、切断中のWebSocket接続拒否／再起動後のHMR handshakeエラーのみで、アプリ由来のJavaScript errorは確認されなかった。

## 証跡

- `01-title-390x844`〜`05-briefing-390x844`: PNG / accessibility snapshot MD
- `07-title-844x390` / `08-mothership-844x390`: 横画面のPNG / accessibility snapshot MD
- `10-settings-844x390` / `11-briefing-844x390` / `12-training-room-844x390`: 横画面の設定・ブリーフィング・訓練室のPNG / accessibility snapshot MD
- `09-natural-patrol-combat`: 自然戦闘・被弾・任務失敗のPNG / accessibility snapshot MD
- `04-settings-audio-touch-390x844`: mouse／touch相当PointerEvent後の設定画面
- `06-scrollable-elements-briefing.json`: スクロール可能要素の調査結果
- `console-errors.txt`: Playwright console error出力
- `console-errors-final.txt`: 再起動前に残ったVite HMR WebSocket接続拒否のみ（アプリ由来のJavaScript errorなし）

アプリコードは変更していない。
