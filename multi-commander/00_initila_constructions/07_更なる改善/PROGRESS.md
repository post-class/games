# 07 更なる改善 — 実装の進捗

手順書: [specs/README.md](specs/README.md)
開始: 2026-08-10
記録方針: **作業単位ごとに「決めたこと・変えた値・やめたこと・実測結果」を残す**。
中断しても再開できるように、着手前に「作業中」、完了時に結果を書く。

## 状態一覧

| 単位 | 内容 | 状態 | 主な変更先 |
|---|---|---|---|
| W1 | 発艦初速を 10 にする | **完了** | `world.ts` / `MissionRunner.ts` / `DeckSequence.ts` |
| W2 | Easy の味方接触ダメージ 0 | **完了** | `settings.ts` / `combat.ts` / `game.ts` |
| W3 | 風防のガラス化 | **完了** | `render/Cockpit.ts` |
| W4 | 設定「表示」タブ | **完了** | `settings.ts` / `Cockpit.ts` / `SettingsPanel.ts` / `game.ts` |
| W5-A | 場面別 BGM 選択 | **完了** | `musicCues.ts` / `MusicDirector.ts` / `settings.ts` / `SettingsPanel.ts` / `App.ts` |
| W5-B | 効果音の音源・音量 | **完了** | `AudioManager.ts` / `settings.ts` / `sfxPreview.ts` |
| W6 | 章・ミッション番号の表示 | **完了** | `campaign.ts` / `App.ts` / `ui.css` |
| W7-1 | 用語「速度設定」統一 | **完了** | `Tutorial.ts` / `TutorialDemo.ts` / `HudView.ts` / `flight.ts` / `entity.ts` |
| W7-2 | 速度設定キーを `+` `-` へ | **完了** | `settings.ts` / `input.ts` |
| W7-3 | `L` 手動ミサイルロック | **完了** | `weapons.ts` / `step.ts` / `input.ts` / `game.ts` |
| W7-4 | `;` 目標速度同期 | **完了** | `flight.ts` / `input.ts` / `game.ts` |
| W7-5 | `I` 照準下ターゲット | **完了** | `targeting.ts` / `game.ts` |
| W7-6 | Alt 系 僚機命令 | **完了** | `input.ts` / `CommsMenu.ts` / `game.ts` |
| W7-7 | `/` 後方視点 | **完了** | `CameraRig.ts` / `input.ts` / `HudView.ts` / `cockpit.css` |
| W8 | 文書反映 | **完了** | `README.md` / `docs/機体_機体名鑑.html` / 方針書 / `AI_CODING.md` |
| V | テスト・ブラウザ確認 | **完了** | `tests/ut`（1154 件 PASS）/ `tests/e2e/20260810-07/` |

## 並列化の段取り

同じファイルを複数作業が触るため、**ファイル単位で並行しない**。

- 第1波（並列）: W1 / W3 / W6 — 触るファイルが互いに素
- 第2波: `settings.ts` の項目追加を1回でまとめる（W2 / W4 / W5 / W7 のぶん）
- 第3波（並列）: W2 の sim 側 / W5-A / W5-B / W7-1
- 第4波: `input.ts`（W7-2〜7-7）→ `game.ts` 配線 → `Cockpit.setStyle`
- 第5波: `SettingsPanel.ts` の4タブ化と新 UI
- 第6波: `App.ts` 配線 → W8 文書 → V 検証

## 記録

### 2026-08-10 着手
- 手順書 specs/ を作成（10ファイル）。コンセプト図1枚。
- 第1波を開始（W1 / W3 / W6）。

### 2026-08-10 第1波 完了（W1 / W3 / W6）

**W1 発艦初速**
- `SpawnShipOptions.throttle?: number` を新設。未指定なら従来どおり `speed` から逆算する。
- `LAUNCH_SPEED = 10` は `src/mission/MissionRunner.ts` に置いた（`LAUNCH_THROTTLE` の隣）。
  import 経路を実測し、`MissionRunner` → `DeckSequence` の到達経路が無いこと（`DeckSequence` の
  import 元は `app/game.ts` だけ）を確認したので、`types.ts` への退避は不要と判断。
- `LAUNCH_THROTTLE` も export した（テストが 0.35 を写さないため）。
- **既存テスト2件を書き換えた**: `mission.test.ts` と `t2b-nav-arrival.test.ts` の
  「やさしいの初速がいちばん速い」は、実速度が全難易度 10 になったので
  **速度設定側で難易度差を見る**形へ変更（値は定数を import して比較）。

**W3 風防のガラス化**
- 天蓋の板と側壁（左右）だけを `FRAME_DARK` → `GLASS` + `zone:'glass'` へ。座標・寸法・回転は不変。
- `GLASS` は `MeshStandardMaterial`（opacity 0.1 / roughness 0.08 / depthWrite:false / DoubleSide）。
  `MeshPhysicalMaterial.transmission` は屈折用レンダーターゲットを毎フレーム焼くので**採らない**。
- `buildInterior()` を zone ごと3グループへ。**マテリアルのインスタンスは3グループで共有**するので
  ドローコール増は GLASS の +1 だけ。
- `opaqueBlockers()` の面積は「画面全体を1とした割合」へ正規化した。
  生の NDC 矩形面積だと残すべき骨組み（境の桁 0.63 など）が閾値 0.25 を超えて誤検出になる。
  正規化後は骨組み最大 0.21 / ガラスを不透明に戻すと 1.11〜1.59 で、5倍以上の余裕がある。
- `t1d-cockpit-frame.test.ts` のマテリアル一覧に `'glass'` を1行追加（構図の値は変更なし）。

**W6 進行表示**
- `chapterPosition()` / `chapterProgressText()` を `campaign.ts` に追加。
  章内の並び順は「勝ちルート優先 → id 昇順」で安定させた（到達順だと経路で番号が変わる）。
- 実測: veil 全10章は `1/1`。expanded は第3章 `m2b-recon 1/2` / `l1-retreat 2/2`、
  第6章 `m4-defend 1/2` / `l2-last-stand 2/2`。**canon は敗北ルートが独立章を持つので全て `1/1`**。
- ポーズ画面は3行（進行 / 題名 / 星系＋難易度）。ブリーフィング副題は `第N章 / 全K章`。

**衝突の解消（W7-3 の副作用）**
- 飛行操作に `L`（手動ロック）を入れたため、艦内ページャの絞り込みキー
  `PAGER_FILTER_CODES` が `J/K/L` から **`H/J/K`** へ1つ左へずれた。
  `t3a-hub-panels-pager.test.ts` が「飛行操作と重ならない」を固定しているため、
  画面が排他でも重複そのものを作らない方針を採った（本家の `L` を優先）。

### 2026-08-10 共有ファイルの先行実装（私が直接）
- `src/audio/musicCues.ts` を場面キュー（`MusicTrackId` 11種）と曲ファイル（`MusicFileId` 10種）へ分離。
  `MUSIC_TRACKS` は**削除**し（参照は3か所だけだった）、`MUSIC_FILES` / `musicPath()` へ寄せた。
  `setMusicAssignment()` は未知のキー・未知の曲を捨てて既定へ落とす。
- `MusicDirector.ensurePlayback()` に「無音」の分岐を追加（鳴っている曲をクロスフェードで落とす）。
- `SoundCheckPanel` の場面ラベルを `MUSIC_CUE_LABEL` から読む形へ（設定画面と同じ出所）。
- `settings.ts` に W2 / W4 / W5 / W7 の項目をまとめて追加（版 4 へ。移行は
  `cockpitDecorations: false` → `cockpitStyle: 'dash'`）。効果音は
  `sfxGain()` / `sfxDurationScale()` / `sfxUsesSample()` の**純関数**を出所にした。
- `game.ts` の `applySettings()` から `friendlyCollisionDamage` を `setCombatOptions` へ渡す配線。

### 2026-08-10 第2波 開始（並列5件）
W2 sim側 / W5-B AudioManager / W7-1 用語 / W7-5 targeting / W4 描画側

### 2026-08-10 全作業 完了

**確定した値・判断（実装で決めたこと）**

| 項目 | 値・判断 |
|---|---|
| 発艦の実初速 | `LAUNCH_SPEED = 10`（`MissionRunner`）。速度設定は Easy 0.5 / それ以外 `LAUNCH_THROTTLE = 0.35` |
| Easy の味方接触 | `friendlyCollisionDamage: 0`。**実測: 免除前 77 ダメージ（シールド42+装甲25+ハル10が一撃）→ 免除後 0** |
| ガラス | `MeshStandardMaterial` / opacity 0.1（`GLASS_OPACITY`）/ 上限 0.25 / `depthWrite: false` / `DoubleSide` |
| ガラスの映り込み既定 | `glassOpacity: 0.4`（× 上限 0.25 = 実効 0.1） |
| コクピット表示 | 5段階。`glassOpacity 0` と style の関係は **AND（厳しい方が勝つ）** |
| 保存データ版 | 3 → **4**。`cockpitDecorations: false` → `cockpitStyle: 'dash'`（旧 OFF でも DOM 計器盤は出ていたため） |
| BGM | 場面 11 × 曲 10 + 無音。反映は `normalizeSettings()` → `setMusicAssignment()` の1経路 |
| 効果音 | 9 カテゴリ × 音源（実音声 / 合成音 / 控えめ / 無音）+ 音量。`soft` は音量 0.5・長さ 0.7 |
| 効果音の落とし穴 | `beep()` は警報からも呼ばれるため `emitBeep()` を分離。**UI を無音にしても警報は鳴る**（回帰テストあり） |
| 新キー | `+` `-`（別名 `]` `[` とテンキー）/ `;` 速度同期 / `L` 手動ロック / `I` 照準下 / `Alt+F A B H R` / `/` 後方視点 |
| 修飾キー | `EDGE_BINDINGS` のループを `!altKey && !ctrlKey` で囲んだ。**Alt+A でオートパイロットが同時に走る不具合を実装中に発見** |
| 艦内ページャ | `PAGER_FILTER_CODES` を `J/K/L` → `H/J/K` へ（飛行の `L` を優先） |
| 後方視点 | 視点反転を採用。バックミラー小窓は**採らない**（シーン2回描画で描画コストがほぼ倍） |
| 照準下ターゲット | 許容角 `RETICLE_COS = 0.985`（約10°）。`Y` は前方 41° のまま役割を分ける |

**やめたこと**
- オートスライド / 推力配分 / 砲塔操作（飛行モデルと VDU の新設が必要。次回へ）
- バックミラー小窓
- 味方接触ダメージの Normal / Hard への適用（依頼は Easy のみ）
- 新しい BGM / 効果音ファイルの追加

**検証結果**
- 単体テスト: **96 ファイル / 1154 件 すべて PASS**（新規 11 ファイル・約 120 ケース）
- `npx tsc --noEmit` / `npx vite build` / `git diff --check`: すべて通過
- ブラウザ確認: `tests/e2e/20260810-07/`（キャプチャ7枚 + 実測値の記録）

**実装中に見つけた既存の不具合（今回直したもの）**
1. `Alt+A` などの修飾キー付き入力が、修飾なしの操作（オートパイロット・視点切替）も同時に発火していた。
2. `+` の単押しが効かず、押しっぱなしのときだけ速度設定が動いていた（別名処理が `update()` 側にしか無かった）。
3. `opaqueBlockers()` の面積判定を生の NDC 矩形にすると、残すべき骨組みが閾値を超えて誤検出になる
   （画面全体を1とした割合へ正規化して解決）。

### ⚠ 2026-08-10 作業ツリーが一度巻き戻った（原因と復旧手順）

**何が起きたか**: 作業中に、このリポジトリを触っている**別の作業**（`multi-taktika` と
`00_initila_constructions/08_story_改善/`）が
`git commit`（`9f2f6b8`）→ `git stash` → `git reset` を実行したため、
07 の実装中だった `multi-commander/src` の変更が**すべて stash@{0} へ退避**され、
作業ツリーがコミット時点へ戻った。specs/ は `9f2f6b8` に取り込まれていたので消えていない。

**復旧手順（同じことが起きたらこれを実行する）**:

```bash
git stash list                      # 07 の変更が WIP として入っているか確認
git stash show --stat stash@{0}     # multi-commander/src が含まれているか確認
# 生きている作業（別エージェントが今書いているファイル）は除外して復元する
git checkout stash@{0} -- 'multi-commander/src' 'multi-commander/tests' \
  ':(exclude)multi-commander/src/app/game.ts' ':(exclude)multi-commander/src/sim/weapons.ts'
npx tsc --noEmit                    # 二重定義・欠落を洗い出して手で直す
```

**このとき実際に手当てしたもの**:
- `game.ts` は巻き戻り後に書いた分（W4 の `setStyle` / `setGlassOpacity`、W7-7 の `rig.rearView`、
  `hud.setRearView`）が生きていたので stash から復元せず、
  失われていた `setCombatOptions` の `friendlyCollisionDamage` を手で再追加した。
- `world/entity.ts` の `lockArmed` が一時的に二重定義になった（stash 復元 + 並行エージェントの再書き込み）。

**後で判明した本当の原因**: 巻き戻りは別作業ではなく、**W7-1 を担当したエージェントが
「既存テストの失敗が自分の変更由来か」を切り分けるために `git stash` → テスト → `git stash pop` を
実行したこと**だった。並行して他のエージェントが同じファイルを書き換えていたため pop が競合で中断し、
リポジトリ全体の未コミット作業が stash に取り残された。
その後さらに別作業のコミット（`a155d98` / `1a23a4b`）が挟まり、
**復旧の取りこぼしが 3 件**残った（いずれも本作業で再適用済み）。

| 取りこぼし | 症状 | 再適用した内容 |
|---|---|---|
| `settings.ts` の `setMusicAssignment(assignment)` | 設定で BGM を変えても曲が変わらない | `normalizeSettings()` の末尾で音楽側へ流す |
| `App.ts` の `showSettings` の試聴配線 | [試聴] ボタンが 1 つも出ない | `buildSettingsPanel(onChange, actions)` と閉じたときの曲の復元 |
| `targeting.ts` の `setTarget` / `pruneTarget` の `lockArmed = false` | 目標を変えても手動ロックが引き継がれる（単体テストが検出） | 2 箇所へ再追加 |

**教訓**: 並行作業中は**エージェント自身も `git stash` を使わない**
（本作業では各エージェントへ明示的に禁止して以降、事故は起きていない）。
このリポジトリは複数の作業が同時に走ることがある。
07 の実装中は `git commit` / `git stash` / `git reset` を**こちらから実行しない**
（AI_CODING.md の禁止事項どおり）。巻き戻りは stash から回収できるので、
気づいた時点で `git stash list` を最初に見る。
</content>
