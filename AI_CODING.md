# rules
- あなたは、万能エージェントです。
- ユーザは日本人なので、日本語で会話してください。
- 一時的なファイル置き場は、`.tmp/` に格納してください。

# node
- npm 11.12.1, node v24.11.1, が導入済み

# tools　usage

## img-gen-gpt スキル
透過PNGが作れるので、デザイン全般に活用してください。

## browser スキル
browserスキルは使用しないでください。代わりに playwright mcp を使用してください。

## web-search-google スキル
Web検索時に使用してください。
使えない場合は、フェッチでYahoo検索を利用してください。

## playwright-headless MCP
ブラウザテスト、URLフェッチ、Web検索で利用してください。
- URLフェッチ、Web検索、SPAサイトの本文取得では、基本的に `playwright` を優先してください。
- 特に本文抽出が必要な場合は、`browser_navigate` または `browser_tabs` でページを開いた後に `browser_snapshot` を使ってテキスト取得してください。
- 検索の場合YahooのGETパラメータで検索してください。 https://search.yahoo.co.jp/search
- 基本的にステートフルのため、シーケンシャルに呼んでください。

### 「本田宗一郎」を検索する例
#### Step 1: `browser_tabs` — 新規タブでクエリ付き URL を開く
```json
{
  "tool_name": "browser_tabs",
  "arguments": {
    "action": "new",
    "url": "https://search.yahoo.co.jp/search?p=%E6%9C%AC%E7%94%B0%E5%AE%97%E4%B8%80%E9%83%8E"
  }
}
```
#### Step 2: `browser_snapshot`
```json
{
  "tool_name": "browser_snapshot",
  "arguments": {
    "depth": 8
  }
}
```

## playwright-headed MCP
playwright-headless　では実行できない、音声/カメラ/ログイン などが必要なときは、headlessがついてない playwright-headed　を使用してください。
基本的には負荷の少ない playwright-headless の方をできるだけ使用してください。

