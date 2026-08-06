# 『ぽこもふ島』 実装進捗

このファイルは**中断・再開のための唯一の信頼できる情報源**です。
作業を始めるとき・終えるときに必ず読み書きしてください。

- 計画: `docs/02_ゲーム実装プラン/`（README.md が索引）
- 最終更新: 2026-08-06

---

## 再開手順（中断から戻ってきたとき）

1. このファイルの「現在地」と「次にやること」を読む
2. `cd ai-pet && npm install`（初回のみ / package.json が変わったとき）
3. `npm run typecheck && npm test` で健全性を確認
4. 動作確認: `npm run dev` → http://localhost:5173/?debug=1
5. 「次にやること」の先頭から着手する

---

## 現在地

| 項目 | 値 |
|---|---|
| 現在のマイルストーン | **M3 生態シミュレーション** |
| 状態 | 未着手 |
| 直近の作業 | M2完了（永続化・2ブラウザ同期・E2E基盤） |

---

## マイルストーン一覧

| M | 内容 | 状態 | 完了日 |
|---|---|---|---|
| M0 | 環境構築 | ✅ 完了 | 2026-08-06 |
| M1 | 島と歩行（シングル） | ✅ 完了 | 2026-08-06 |
| M2 | マルチユーザー同期 | ✅ 完了 | 2026-08-06 |
| M3 | 生態シミュレーション | ⬜ 未着手 | - |
| M4 | ペットとの会話（MVP） | ⬜ 未着手 | - |
| M5 | ペットの自律行動と記憶 | ⬜ 未着手 | - |
| M6 | ペット同士の会話と噂 | ⬜ 未着手 | - |
| M7 | 建築・オフライン進行 | ⬜ 未着手 | - |
| M8 | 仕上げ・アセット・デプロイ | ⬜ 未着手 | - |

凡例: ⬜未着手 / 🚧進行中 / ✅完了 / ⚠️問題あり

---

## M0 完了記録（2026-08-06）

- [x] npm workspaces（shared / server / client）
- [x] tsconfig（strict / noUncheckedIndexedAccess）
- [x] shared: constants / types / rng / protocol(zod)
- [x] server: Hono + ws、tickループ（4Hz）、WorldClock、hello/welcome、ping/pong、graceful shutdown
- [x] client: Vite + Pixi v8 ステージ、WS再接続、HUD（島日・季節・時間帯・天気・RTT）
- [x] Vitest 33件（rng決定論・protocol検証・秘密情報漏洩防止）
- [x] `tools/llm-smoke.ts` で Azure OpenAI 疎通と capability 確認

### 動作確認済み
- `curl localhost:8787/healthz` → `{"ok":true,"tick":…}`、tickは4Hzで進行
- ブラウザで島時間HUDが表示、RTT 1ms、fps 120（Playwright headless）
- `npm run typecheck` / `npm test` すべて通過、`npm audit` 脆弱性0

### ⚠️ 判明した重要な制約（設計に反映済み）

1. **`temperature` が使えない**（`gpt-5.6-luna` は既定値1のみ）
   → 発話の多様性はプロンプト（ペルソナ・記憶・気分）で作る
2. **`max_tokens` は不可**。`max_completion_tokens` を使う
3. `json_schema`(strict) / `json_object` / `stream` は利用可。初トークン 約0.7〜0.9秒
4. **Node の type-stripping で動かすため TS の一部構文が使えない**
   - parameter property（`constructor(private x: T)`）→ 使用禁止
   - enum / namespace → 使用禁止（`as const` + union type で代替）
   - 相対importは拡張子 `.ts` 込みで書く

---

## M1 完了記録（2026-08-06）

### 完了条件（docs 09章 M1）
- [x] 島が表示され、水に入れず、島の端で止まる（海岸まで歩いて砂浜で停止するのを実機確認）
- [x] 60fps維持 → **実測 126fps**（1280×720 / WebGL / ズーム1.0）
- [x] リロードしても同じ島 → **サーバ再起動をまたいでチャンクのハッシュが完全一致**、spawnも同一
- [x] 島日・季節・時間帯・天気が時間経過で変わる → `tests/sim/clock.spec.ts` 10件で検証
  （1島日=60分かかるため実機では待てない。時間帯の順序・7島日で季節・28島日で春に戻る・天気の決定論をテストで担保）

### テスト: 163件パス / typecheck エラー0 / `npm run build` 成功（js+css+html gzip 186KB）

### M2以降への申し送り（M1で判明）

1. **A*の `maxNodes` 4000 は、島が幅1タイルの通路で大きく分断されると失敗する**
   → M7で橋建設（分断地形）を入れるなら、docs 04章§4の「フローフィールドを島日ごとに共有」を実装する。現状未実装
2. **snapshot の資源・設置物は興味範囲内のみ**。範囲外の資源は `chunk` メッセージで届くので、
   クライアントは chunk を捨ててはいけない
3. `deltaMessage` に `clock` を渡すと「変化なしでも送信」になる。**clockは変化時＋4秒ごとだけ**渡す（hub側で制御済み）
4. 釣り場・水場のバランス定数が `worldgen.ts` 内にある（並列作業中の `constants.ts` 編集禁止のため）。
   **M3のバランス調整前に `constants.ts` へ移すこと**
5. `findPath` は作業領域をモジュールで使い回すため**再入不可**（1tick内で逐次呼ぶ前提）
6. **`chunkReq` は一度要求したチャンクを再要求しない**（メッセージ欠落時に地形に穴が残る）→ M2でタイムアウト再要求を追加
7. 経路の平滑化なし（8方向A*でタイル中心を刻む）。気になれば `hasLineOfWalk` で間引く
8. アニメは歩行時の上下バウンドで代用（コマ画像が無いため）。本番スプライトシート導入はM8
9. プレースホルダPNGは `node tools/placeholder.ts` で再生成できる（決定論。55ファイル）

---

## M2 完了記録（2026-08-06）

### 完了条件（docs 09章 M2）
- [x] 2つのブラウザで同じ島に入り、互いのアバターが動いて見える
  → E2E「2ブラウザが同じ島に入り、互いを認識する」「相手の移動が同期されて見える」「片方を閉じるとactorsが減る」
- [x] サーバを再起動しても、リロードで元の位置・同じ島に戻る
  → `tests/integration/restart.spec.ts`（子プロセスで実サーバを起動 → 移動 → SIGINT → 再起動 → 同じsecretで復元）
- [x] WSを強制切断しても自動再接続して復帰する → E2E「切断で再接続中→接続OKに戻る」
- [x] Playwrightの2ブラウザE2Eが通る → **11件パス / 1件skip（統合テストへ移設したもの）44秒**

### 実装したもの

- `db/schema.sql` / `db/repo.ts`：docs 03章のスキーマ＋`last_weather_roll_tick` / `next_entity_id` / `rng_state_json`
  （天気の抽選位相・ID採番・RNG状態がないと再起動で決定論が崩れるため）
- `sim/persistence.ts`：起動時の復元・30秒ごとの自動保存・停止時の保存
- `net/hub.ts`：`secret` からのプレイヤー復元（立てない位置なら広場へ）、切断時・定期・停止時の位置保存
- クライアント：`chunkReq` のタイムアウト再要求（3秒）＋再接続時の要求記録リセット、デバッグパネルに自機座標
- `playwright.config.ts` / `tests/e2e/**`：E2E基盤（サーバ8788・クライアント5199で開発用ポートと分離）
- `tests/integration/restart.spec.ts`：サーバ再起動をまたぐ復帰（ポート8791）

### 実測

- スナップショット保存: 平均 **0.25ms**（資源200件＋動物120体＋荒廃度16KB。20ms目標に対し余裕）
- E2E: 11件44秒、headless fps 48〜78
- テスト合計 **202件**（unit 198 + integration 4）、E2E 11件は別枠

### ⚠️ M2の申し送り

1. **E2Eのファイル名は `*.e2e.ts`**（`*.spec.ts` にすると Vitest が拾う）。
   `vitest.config.ts` 側にも `exclude: ['tests/e2e/**']` を入れてある
2. **`tests/e2e/reset-db.ts` は `.tmp/` 配下以外を消さない安全弁つき**（開発用 `data/island.db` の誤削除防止）
3. **デバッグパネルの `pos` 行のフォーマットを変えないこと**（E2Eヘルパが正規表現で読んでいる）
4. `context.setOffline(true)` は既存WSを切らないため、E2Eは `/ws` のソケットだけを明示的に閉じている。
   **ViteのHMRソケットを閉じるとページが固まる**ので、閉じる対象を広げないこと
5. デバッグパネルの `tick` は切断中もクライアントが+4/秒で進める（サーバ生存確認には使えない）
6. `pruneOldEvents` は importance に関わらず古い島日を全削除する
   （docs では `importance <= 3` のみ削除。必要になったら引数を足す）
7. **M3で動物が入るとE2Eの `actors >= 2` 判定がゆらぐ可能性がある** → `actorIds` ベースの判定に寄せる

---

## 次にやること（M3 生態シミュレーション）

1. ⬜ `constants.ts` に釣り場・水場の定数を移す（M1申し送り 4。バランス調整の前に）
2. ⬜ `sim/needs.ts`：欲求の増減
3. ⬜ `sim/resource.ts`：資源の回復と荒廃度の減衰（季節倍率）
4. ⬜ `sim/critter.ts`：ユーティリティAI（採食・水飲み・就寝・交流・逃走・巣づくり・徘徊）＋ time slicing
5. ⬜ `sim/relation.ts`：好感度・繁殖・寿命（島日境界）
6. ⬜ `sim/events.ts`：EventBus → `island_event` へ記録
7. ⬜ 動物の初期散布（worldgenは資源までしか作らない）
8. ⬜ 決定論テスト（7島日回して不変条件、fastForward一致）＋ バランス調整
9. ⬜ 完了条件: 動物100体が自律生活／7島日で破綻しない／冬にケンカ増／tick p95<40ms

### 並列作業の分担（M3・予定）

| 担当 | 所有ファイル | 内容 |
|---|---|---|
| F | `sim/{needs,resource}.ts`, `shared/constants.ts`, `tests/sim/{needs,resource}.spec.ts` | 欲求と資源 |
| G | `sim/critter.ts`, `tests/sim/critter.spec.ts` | ユーティリティAI |
| H | `sim/{relation,events}.ts`, `tests/sim/{relation,events}.spec.ts` | 関係性・世代交代・イベント |
| メイン | `island.ts`, `hub.ts`, `persistence.ts`, `PROGRESS.md`, 結合と不変条件テスト | 配線・バランス調整 |

---

## 決定・変更のログ

| 日付 | 内容 |
|---|---|
| 2026-08-06 | 実装プラン（docs/02）を確定し、実装に着手 |
| 2026-08-06 | **project references を採用せず**、ルート1つの tsconfig で `--noEmit` 型検査に変更（ビルドはVite、サーバはNodeのtype-strippingで直接実行。ビルドステップを持たない方が再開しやすい） |
| 2026-08-06 | 依存を最新の安全なバージョンへ（vite 8 / vitest 4 / zod 4 / hono 4.13 / @hono/node-server 2 / pixi 8.19）。`npm audit` 脆弱性0 |
| 2026-08-06 | LLM: `temperature` 非対応・`max_tokens` 非対応が判明。docs 07章に実測表を追記 |

---

## M1 の実装記録

### サーバ側

- `sim/world.ts`：世界の器（タイル・アクター・資源・設置物とアクセサ）
- `sim/worldgen.ts`：value noise → radial falloff → しきい値 → 広場 → 土 → flood fillで孤島を沈める → 資源配置
  - 実測: 生成 約30ms、歩けるタイル率 39.7〜48.4%（20 seed）、到達不能な陸 0、資源は全種類配置
- `sim/actors.ts`：プレイヤー/動物/ペットの生成、traits の生成と遺伝、`actorToWire`
- `sim/nav.ts`：8方向A*（角抜け禁止・octile）、12タイル以内は直進、1tick最大8件のキュー
- `sim/movement.ts`：経路追従・軸入力・押し出し衝突・地形と境界の制約
- `net/sync.ts`：興味管理つき chunk / snapshot / delta 生成
- `sim/island.ts` / `net/hub.ts`：上記の配線（tick順序 = clock → nav → movement → hooks → delta送信）

### 結合の実測（サーバ単体）

- WS接続 → welcome（spawn=広場の中心 64.5,64.5）→ chunk 2枚 → snapshot → delta 4Hz
- `move` を送ると A* で経路が引かれ、実際に 9.6タイル移動した
- 切断で アクター・nav・sync のクリーンアップが動作（actors=0 に戻る）
- tick処理時間 p50 0.02ms / p95 0.19ms（アクター1体）
- サブエージェント計測: 120体+16接続で 合計 p50 0.26ms / p95 1.33ms、帯域 約5.4KB/秒/人

### クライアント側

- `render/tilemap.ts`：チャンク（16×16）をRenderTextureへ焼成。荒廃度フックあり（M3で実装）
- `render/camera.ts`：デッドゾーン追従・ズーム3段（0.75/1.0/1.5）・島端クランプ・座標変換
- `render/sprites.ts`：150ms補間バッファ・y座標での深度ソート・culling・自機のクライアント予測
  （ズレ0.5タイルで0.2秒補正、3タイルで即スナップ、**入力中は補正しない**）
- `render/effects.ts`：時間帯の色被せ
- `state/world.ts`：snapshot/delta/chunk の適用（Pixi非依存なのでテストしやすい）
- `input.ts`：WASD・クリック移動・ホイールズーム
- `dev/mock.ts`：`?mock=1` でサーバなしに描画だけ検証できる（本番バンドルには入らない動的import）
- `tools/placeholder.ts`：PNGを自力エンコード（依存追加なし・決定論）。本番アセットは同じパスに差し替えるだけ

## 詰まっていること / 申し送り

- Vite の `/ws` プロキシ経由で接続している（クライアントは同一オリジンの `/ws` を見る）。
  本番では同一ホストから配信するため同じ形で動く。
- `.tmp/llm-capabilities.json` に capability の実測結果がある。M4の `llm/client.ts` はこれを前提に実装する。
