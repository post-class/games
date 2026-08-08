# ai-pet（『ぽこもふ島』）のコーディング規約と落とし穴

`ai-pet/` 配下を触るときに**必ず先に読む**ファイル。
ここに書いてあるものはすべて**実際に踏んだ**罠です（出典は `docs/02_ゲーム実装プラン/PROGRESS.md` の各マイルストーンの申し送り）。

- 実装進捗と経緯: `docs/02_ゲーム実装プラン/PROGRESS.md`
- 宣伝資料との乖離是正の進捗: `docs/03_宣伝用との乖離是正プラン/02_是正プラン.md`
- アートの基準: `docs/03_宣伝用との乖離是正プラン/04_スタイルガイド.md`

---

## 1. 言語とビルド

サーバは **Node の type-stripping で TS を直接実行**している（ビルドステップを持たない）。
そのため次の構文が**使えない**。

- **parameter property 禁止**（`constructor(private x: T)`）→ 明示的にフィールドへ代入する
- **`enum` / `namespace` 禁止** → `as const` + union type で代替する
- **相対 import は拡張子 `.ts` 込み**で書く（`import { x } from './stage.ts'`）

その他:

- 型検査は `npm run typecheck`（`tsc --noEmit`）のみ。project references は使っていない
- `strict` / `noUncheckedIndexedAccess` が有効。配列アクセスは `as T` か存在チェックが必要
- クライアントのビルドは Vite。**APIキーをクライアントへ渡さない**（`env.ts` はサーバ専用）

## 2. コメントと文章

- コメントは**日本語**。周囲の密度に合わせる
- このリポジトリの作法は「**なぜそうしたか**を書く」。とくに
  「素直に書くとこうなるが、実測でこう困ったのでこうした」を残す
- 定数には根拠を書く（`MAX_CRITTERS = 120`（150だと冬に崩壊した）のように）

## 3. 決定論（最重要）

「リロードしても同じ島」「サーバ再起動をまたいでチャンクのハッシュが完全一致」が完了条件になっている。

- **見た目や世界生成を決めるところで `Math.random()` / `Date.now()` を使わない。**
  座標などから整数ハッシュを作る（`packages/shared/src/rng.ts`）
- 天気の抽選位相・ID採番・RNG状態を DB に保存している。無いと再起動で決定論が崩れる
- `tools/placeholder.ts` は決定論（2回走らせて同じバイト列になること）

## 4. テストを壊しやすい箇所

| 触るもの | 注意 |
|---|---|
| デバッグパネルの `pos` 行 | **フォーマットを変えない。** E2Eヘルパが正規表現で読んでいる |
| E2Eのファイル名 | `*.e2e.ts` にする（`*.spec.ts` だと Vitest が拾う） |
| タマゴ選択モーダル | **意図的にゲーム操作を止めている。** E2Eは `ensurePet` ヘルパ経由で開く |
| `tests/e2e/reset-db.ts` | `.tmp/` 配下以外を消さない安全弁つき（`data/island.db` の誤削除防止） |
| 再接続のE2E | **ソケットを閉じてから オフラインにする**（逆順だと close ハンドシェイクが完了できず `onclose` が飛ばない＝15〜25%落ちた）。判定は履歴（`MutationObserver`）＋発生源の記録（`__netTrace`）＋現在値の3つで行う |
| E2E全般 | **間欠失敗の履歴がある**（M7・M8で2回対処済み）。マシンが混んでいると顕著。落ちたら負荷のない状態で単独再実行して切り分ける |

`findPath` は作業領域をモジュールで使い回すため**再入不可**（1tick内で逐次呼ぶ前提）。

## 5. LLM（Azure OpenAI / `gpt-5.6-luna`）

実測で判明した制約。**外すと回帰テストが落ちる**。

- **`temperature` が使えない**（既定値1のみ）。発話の多様性はプロンプト側で作る
- **`max_tokens` は不可**。`max_completion_tokens` を使う
- 上記2つを「送らないこと」がテストで固定されている
- `json_schema`(strict) / `json_object` / `stream` は使える。初トークンは約0.7〜0.9秒
- 予算制限は `mode:'real'` のときだけ効く（mock は無料なので E2E を詰まらせない判断）
- 予算のウィンドウはプロセス内メモリのみ。**再起動でリセットされる**
- `--llm=mock` でもペット間会話は起きる（`llm/mock.ts` がプロンプトから話者名を読む）
- `--llm=fail` で「LLMが落ちても遊べる」ことを確認できる

## 6. クライアント描画

- 地形は**チャンク（16×16）を RenderTexture へ焼いて Sprite 1枚**として置く。
  焼き直しは受信時と `invalidate()` 時だけ。毎フレームのコストを増やさない
- レイヤ順は `render/stage.ts` の1か所で決まる:
  `ground → decal → shadow → entities → light → bubbles → weather`（+ カメラ非依存の `overlayRoot`）
- **`entities` は y座標でソート**する1つの層（オブジェクトとアクターが混在し、木の後ろに動物が回り込む）
- アクターのアンカーは `ANCHOR_Y = 43/48`（足元）。接地影は同じ位置に描く
- パーティクルや多数の図形は「**1枚の Graphics にまとめる**」（`weather.ts` が260本の線でやっている）
- ⚠️ **1枚にまとめても「重なった図形を半透明で塗る」はできない。**
  Pixi は図形ごとに三角形へ分けるので、`fill` を1回にしても**重なった部分は2回塗られる**。
  円を重ねて有機的な面を作る手（`snow.ts` の雪）は**不透明でしか成立しない**
  （alpha 0.82 で試したら円の輪郭が全部見えて「石けんの泡」になった）。
  半透明の面が要るなら、レイヤごと RenderTexture に描いてから alpha を掛ける
- 「見えている整数タイル範囲」が鍵になる静的な装飾（雪など）は**範囲が変わったときだけ積み直す**。
  毎フレーム900個の図形を積むのは無駄（`snow.ts` の `key`）
- スマホは粒を1/3にし、`prefers-reduced-motion` では動かさない
- **加算ブレンドは明るい地面や光源の重なりで白飛びする。** 強さは控えめに
- 未受信チャンクの扱いを決めておく（`chunkReq` はタイムアウト再要求あり。
  隣チャンクを知らないと遷移タイルが欠けるので「同じ地形とみなす」等の方針が必要）

### 既知のハック（絵を直したら消すもの）

- ~~いのししは絵が横長なので描画側で1.3倍~~ → **2026-08-08 撤去済み**（正方寄りに描き直した。`BOAR_SCALE = 1.0`）
- ~~睡眠は `alpha = 0.75` だけ~~ → **睡眠ポーズ11枚を導入済み**。ただし**アセットが無い種は `alpha 0.75` に落ちる**仕組みは残っている
- ~~歩行は上下バウンドで代用~~ → **2026-08-08 に `walkPose()` へ置き換え済み**（跳ね2回＋傾き1往復で足踏みに見せる。コマ画像は足していない）
- 季節で絵が変わるのは木だけ（`obj_berry_tree_<状態>_<秋|冬>`）。**春夏は基本の緑をそのまま使う**

## 7. UI / CSS

- **`.hud` に `pointer-events: none` が掛かっている。** 中に足したボタンは
  `pointer-events: auto` を明示しないとクリックが canvas に取られる
- `.hud` は `left/right: 10px` の折返し flex。**1個のチップが行幅を超えると折返さずはみ出す**。
  長くなる要素は `max-width` と三点リーダで切る
- 狭い画面では案内バナーをチャット欄の中へ流し込んでいる
  （絶対配置だと通知が溜まってチャットログが伸びたとき必ず重なる）
- 会話の入力欄はフォーカスが残るとWASDが文字入力に食われる。送信時に `blur()` する
- **短すぎる表示は「無い」のと同じ。** 吹き出しは下限5秒（3.2秒では目を離すと読めなかった）

## 8. サーバ / シミュレーション

- tick順序は `clock → nav → movement → hooks → delta送信`（`sim/island.ts` で配線）
- `deltaMessage` に `clock` を渡すと「変化なしでも送信」になる。**clockは変化時＋4秒ごとだけ**
- snapshot の資源・設置物は**興味範囲内のみ**。範囲外は `chunk` メッセージで届くので
  クライアントは chunk を捨ててはいけない
- **地形はスナップショットに保存していない**（seed から作り直す設計）。
  完成した橋は `BuildSystem.restore()` が張り直す。資源・設置物の復元より**後**に呼ぶ
- 地形が変わると `terrainChanged` が飛び、周辺アクターの経路を捨ててチャンクを再取得する
- **オーナーが切断してもペットは島に残る**（不在中に見聞きさせるため。これが宣伝資料の核心）
- 無音になった接続は30秒で切る（`CLIENT_IDLE_TIMEOUT_MS`）。クライアントは5秒ごとに ping
- ~~巣（nest）タイルは WeakMap 保持なので再起動すると忘れる~~ → **2026-08-08 に `Actor.nest` へ移して永続化済み**（`critters_json` に入る）。巣は `nest` 設置物として描画され、`syncNestPlaceables()` が40tickごとに死んだ個体の巣を掃除する

### 世界生成

- 既定 seed は **`pokomofu-2`**。`pokomofu-1` は島が分断されておらず橋の予定地が生まれなかった。
  **橋ができる seed は13個中3個だけ**
- `worldgen` は flood fill で孤島を沈め「到達不能な陸 0」を保証している。
  **歩行不可のものを置いたら、置いた後にもう一度この検査を通す**
- A*の `maxNodes` は4000。**幅1タイルの通路を作らない**

### バランス定数を触るときの鉄則

**`npm run sim:long` で長期を回す。** M3では長時間シミュレーションで初めて8件の実装バグが見つかり、
**単体テストでは1件も見つからなかった**（ほぼ空の資源に通い続けて餓死する、長雨で木の下から出ずに餓死する、
寝ているいのししから逃げ続ける等）。

定数は `packages/shared/src/constants.ts` に集約する方針。主要な値と理由:

| 項目 | 値 | 理由 |
|---|---|---|
| `INITIAL_CRITTERS` | 70 | 90だと収容力超過で開始直後に40体が餓死した |
| `MAX_CRITTERS` | 120 | 150だと秋に増えすぎて冬に崩壊した（性能の安全弁でもある） |
| `berryRegenPerIslandHour` | 0.15 | 0.6だと供給が需要の5倍で取り合いが起きない |
| `starvationHealthPerIslandHour` | 4 | 8だと冬に死が連鎖して下限40を割った |

`critter.ts` の `WEIGHTS` は **2026-08-08 に `CRITTER_WEIGHTS` として `constants.ts` へ移設済み**。

## 9. アセット

### ⚠️ 画像生成は `.env` と依存でつまずく（毎回ここで詰まる）

`tools/gen-assets.md` に実行方法の台帳がある。**先にそれを読むこと。** 要点:

- **使う `.env` はリポジトリ直下の `games/.env`。** 画像用の `AZURE_OPENAI_US_*` が3つ揃っている
  （スキルの既定の env 名もこれ）。**`ai-pet/.env` は存在しない**ので、
  `ai-pet/` から実行するときは **`--env-file ../.env`** を必ず渡す
  （既定の `.env` は cwd 基準で解決されるため、渡さないと見つからない）。
  2026-08-08 に疎通確認済み（`--env-file ../.env` で `status: ok`）
- ⚠️ `AZURE_OPENAI_ENDPOINT`（`US` が付かないほう）は**ペットのLLM用**で画像モデルのデプロイが無い。
  そちらを見せると `DeploymentNotFound (404)` になる
- スキルのスクリプトに PEP 723 の依存宣言が無いので、`uv run` に**依存を明示**する。
  `ai-pet/` から実行する定型はこれ:
  ```bash
  UV_CACHE_DIR="$PWD/.uv_cache" uv run --with httpx --with pyyaml --with python-dotenv --with openai python \
    /Users/ryosato/.claude/skills/img-gen-gpt/scripts/generate_image.py \
    --operation generate --prompt "<プロンプト>" \
    --output-dir "$PWD/.tmp/asset-<名前>/<一意な名前>" \
    --env-file ../.env \
    --model gpt-image-1-mini --quality medium --size 1024x1024 \
    --background transparent --output-format png
  ```
- **並列実行するときは `--output-dir` を1回ごとに分ける**（出力名がタイムスタンプなので衝突する）
- 1枚 medium/1024x1024 で約 $0.011、所要1〜2分
- `gpt-image-1-mini` は `--input-fidelity high` を受け付けない

### ⚠️ 1024px で生成したものは 32px タイルにすると模様が消える

タイル（32×32）を 1024px で生成して縮小すると、**細かい模様は平均化されて単色になる**。
実測（`--quality medium / 1024x1024` → 32px）:

| 生成した内容 | 32pxでの結果 |
|---|---|
| 「小さな丸石の石畳」 | ○ 石畳として読める（石が1辺に20個ほど＝ぎりぎり） |
| 「苔のある森の地面」 | ○ 緑の斑として読める |
| 「細く短い草のストローク」 | **× ほぼ単色**（既存の `tile_grass.png` より情報量が減った） |
| 「非常に細かい粒の土」 | **× 完全に単色** |

対策:

- **模様の要素を「1辺に3〜6個」の粗さで指定する**（"a few large ..." / "only 4 or 5 ..."）。
  「fine」「very small」「subtle」は 32px では消える
- 生成したら**必ず 32px に落として8倍拡大で確認**してから採用する:
  ```bash
  UV_CACHE_DIR="$PWD/.uv_cache" uv run --with pillow python - <<'PY'
  from PIL import Image
  im = Image.open('<生成物>').convert('RGBA').resize((32,32), Image.LANCZOS)
  im.resize((256,256), Image.NEAREST).save('.tmp/check.png')
  PY
  ```
- 既存アセットより情報量が減るなら**採用しない**（絵が退化する）
- キャラクター（48px）と大きい設置物（家・風車）はこの問題が出にくい（形が大きいため）

### 命名と後処理

- 命名: `tile_<terrain>.png` / `<kind>_<species>_<dir>.png` / `obj_<type>.png` / `decal_<name>.png` /
  `edge_<from>_<to>_<mask>.png`
  （拡張は `docs/03_宣伝用との乖離是正プラン/04_スタイルガイド.md` §8）
- 生成は `img-gen-gpt` スキル → 後処理は `tools/install-assets.py`
  （切り出し → 48px/32pxへ縮小 → 足元揃え → `_w` は `_e` の反転生成）
- 採用プロンプト・再試行回数・スタイル句は `tools/gen-assets.md` に追記する
- **手直しはまず Pillow の後処理で解決を試す**（M8では接地影の除去と彩度調整を追加生成なしで解決した）
- **焼き込まれた地面の除去は `tools/strip-ground.py`**（フラッドフィル方式）。
  ⚠️ **色だけで判定してはいけない。** 「下半分の緑を消す」実装にしたら**茂みの葉が消えた**
  （地面 h=0.135/s=0.37 と葉 h=0.207/s=0.59 は色相も彩度も近い）。
  いまは「画像の縁から塗り広げ、`--ink` の輪郭線に当たったら止まる」ので、
  輪郭で囲まれた本体は構造的に消えない。**処理後は必ず並べて目で見る**
- `render/assets.ts` は本番（`/assets/game/`）を優先し、無い分だけプレースホルダに落ちる。
  **1枚ずつ受け止めるので1枚欠けても全部落ちない**
- 新しいアセット名を足したら `tools/placeholder.ts` にも足す（欠けたまま気づかないのを避ける）
- ⚠️ **タイルのバリエーションは4枚まとめて `game/` に入れる。** 1枚だけ置くとそれが全面に使われる

## 10. 守るべき数値（完了条件）

| 項目 | 基準 | 直近の実測 |
|---|---|---|
| tick処理時間 | p95 < 40ms | p95 0.87ms（動物86体） |
| fps | スマホ30fps以上 | 1280×720 で120fps |
| 初回ロード | 5MB以内・10秒以内 | 画像239KB + JS 187KB ≒ 430KB / 0.65秒 |
| 型検査 | エラー0 | 0 |
| ユニットテスト | 全件パス | 819件 |

## 11. 開発中に使うコマンド

```bash
cd ai-pet
npm run dev            # サーバ8787 + Viteクライアント（ポートは起動ログで確認）
npm run typecheck
npm test
npx playwright test    # E2E（サーバ8788 / クライアント5199 で開発用と分離）
npm run sim:long       # 長時間シミュレーション（バランス調整時は必須）
npm run llm:smoke      # Azure OpenAI の疎通と capability 確認
```

動作確認は `?debug=1` を付けて開き、タマゴ選択の「この子とくらす」を押すとプレイ状態になる。

### 島の時間帯・天気を再現する（1島日=実時間60分なので待てない）

DBの `tick` を書き換えてサーバを再起動する。`DB_PATH` は**絶対パス**で渡す
（相対だと `packages/server/` 基準になって新規作成されてしまう）。

```bash
cd ai-pet
pkill -f "src/main.ts"; sleep 4     # ⚠️ pkill -f vite / node のような広いパターンは使わない
cp data/island.db .tmp/scratch.db
python3 -c "
import sqlite3,time
c=sqlite3.connect('.tmp/scratch.db')
t=c.execute('select tick from island').fetchone()[0]
day=t//14400
target=day*14400+int(14400*0.80)    # 0.0朝 / 0.25昼 / 0.55夕 / 0.75夜
if target<=t: target+=14400
c.execute('update island set tick=?,weather=?,last_weather_roll_tick=?,updated_at=?',
          (target,'rain',target,int(time.time()*1000)))
c.execute('update island_snapshot set tick=?',(target,))
c.commit()"
cd packages/server && DB_PATH=/absolute/path/to/ai-pet/.tmp/scratch.db node src/main.ts &
```

⚠️ サーバは**停止時にスナップショットを保存する**ので、
「サーバを止める → 十分待つ → DBを書き換える → 起動する」の順を守る。逆だと上書きされる。
⚠️ 使い終わった `.tmp/*.db` は消す。

## 12. 並行作業とマシン負荷

リポジトリ全体の方針は `../AI_CODING.md` の「マシンの負荷を上げすぎない」を見ること。
ここは ai-pet 固有の実測値と手順。

### ファイルの衝突

- **同じファイルを複数人／複数エージェントで同時に触らない。** 担当ファイルを先に割る
- 衝突しやすい箇所: `packages/client/src/main.ts`（配線の集約点）、
  `packages/shared/src/constants.ts`、`packages/client/src/ui/style.css`、`tools/placeholder.ts`、
  `packages/client/src/render/tilemap.ts`、`packages/client/src/render/objects.ts` の `OBJECT_SCALE`
- `main.ts` は配線だけなので、機能側はクラスを export して**配線は最後にまとめて1人がやる**のが安全

### 負荷（実測）

| やること | 単独 | 他と同時 |
|---|---|---|
| `npm test`（ユニット881件） | 約15秒 | — |
| `npm run typecheck` | 約5秒 | — |
| `npx playwright test`（E2E 24件） | **約2.5分** | **34分**（13倍） |
| `npm run sim:long` | 数十秒〜 | — |

- **E2E とブラウザ確認を同時に走らせない。** E2E は `webServer` で自前のサーバ（8788/5199）を起こすので、
  開発用（8787/5173）と**ポートは衝突しないが CPU で衝突する**
- ブラウザを使わない作業（アセット生成・型検査・ユニットテスト・ドキュメント）は同時に回してよい
- 終わったら必ず止める。自分が起動したPIDだけを止める:
  ```bash
  lsof -nP -iTCP:8787 -sTCP:LISTEN -t | xargs -r kill
  lsof -nP -iTCP:5173 -sTCP:LISTEN -t | xargs -r kill
  ```
- ⚠️ `pkill -f vite` / `pkill -f node` / `pkill -f main.ts` は**他の作業を巻き込む**ので使わない
  （実際にサブエージェントが親の dev サーバを落とした）

### 間欠失敗を追うとき

**繰り返し実行しない。** `tests/e2e/reconnect.e2e.ts` を `--repeat-each` で5回追いかけたが、
失敗率が 2/6 → 1/6 → 3/8 → 5/8 → 4/8 と振れるだけで原因に近づかなかった（負荷を除いても約50%）。

正しい手順:

```bash
npx playwright test tests/e2e/reconnect.e2e.ts --workers=1 --trace on   # 1回だけ
npx playwright show-trace test-results/<...>/trace.zip                   # 中身を見る
```

- `test-results/<...>/error-context.md` に**失敗時のページ状態（HUDの文字を含む）**が入るので先に読む
- **trace.zip は unzip して直接読める。** `0-trace.network` に WebSocket のハンドシェイクが
  `resource-snapshot` として残るので「再接続の2本目が張られたか」が分かる。
  `0-trace.trace` には console のログが入っている（`[client] welcome` の回数を数えられる）
- ⚠️ **`expect.poll` は失敗時に自前のメッセージを出せない**（タイムアウトの汎用文になる）。
  観測内容を見たいときは**自前ポーリングに書き換える**。これが間欠失敗の特定の決め手になった
- **発生源で記録する仕組みがある。** `socket.ts` の `wsTrace()`（connect/onopen/onclose/setState）と
  `main.ts` の `__netTrace`（接続状態の文字）は、**テストが `window.__wsTrace` / `__netTrace` を
  作ったときだけ push する**。本番では optional chaining が空振りするのでコストは無い。
  ネットワークまわりの間欠失敗はまずこれを出力に入れる
- 判定を「DOMの変化履歴」だけに頼ると数百msの中間表示を取りこぼす。
  **現在値も併せて見る**か、状態遷移を発生源で記録する
  （`main.ts` の `renderNet` は `window.__netTrace` があれば push する。作るのはE2Eの初期化スクリプトだけ）
