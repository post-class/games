# E2E-12 ESCポーズ画面の視覚的なボタン表示

結果: PASS（CSS修正後に再確認）

## 初回確認

- Playwright headless MCPで訓練戦闘を開始。
- viewport `1152x549`（報告画像のブラウザ表示領域相当）で`Escape`を押下。
- ポーズ画面の6項目がアクセシビリティツリー／DOMに存在することを確認。
- fullPageスクリーンショットで、下段の項目が戦闘コクピットに重なって視覚的に隠れることを確認した。

## 修正後再テスト

- `.mc-screen`にHUD／コクピットより前面の`z-index`を設定。
- viewport `1152x549`で6項目すべてがviewport内に表示され、各項目の中心点がメニュー要素自身として取得できることを確認。
- `設定`、`操作方法`、`再開`、`ミッションをやり直す`、`タイトルへ戻る`を実際にクリックし、期待する画面遷移を確認。
- `844x390`でタイトル、母艦、設定、ブリーフィングのメニュー全項目がviewport内に収まることを確認。
- `console-errors-final.txt`はアプリ由来のエラー0件。

## 原因の切り分け

- ポーズメニューのDOM矩形は画面内に収まっている。
- 戦闘コクピットは`z-index: 4`、ポーズ画面の内容は`z-index: 1`で、コクピットが前面に描画される。
- コクピットは`pointer-events: none`のため、DOMクリックや`elementFromPoint`だけではこの表示不具合を検出できない。

## 証跡

- [pause-1152x549.png](./pause-1152x549.png)
- [pause-accessibility.md](./pause-accessibility.md)
- [pause-visibility.json](./pause-visibility.json)
- 修正後: [07-pause-final.png](./07-pause-final.png) / [07-pause-final.md](./07-pause-final.md)
- 修正後の横画面: [03-title-844x390-fixed.png](./03-title-844x390-fixed.png)、[04-hub-844x390-fixed.png](./04-hub-844x390-fixed.png)、[05-settings-844x390-fixed.png](./05-settings-844x390-fixed.png)、[06-briefing-844x390-fixed.png](./06-briefing-844x390-fixed.png)
- [console-errors-final.txt](./console-errors-final.txt)

アプリコード（`src/styles/ui.css`）を修正し、再テストでPASS。
