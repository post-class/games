# MULTI-COMMANDER — Wing Commander 本家寄せ改善 TODO

調査日: 2026-08-05  
対象: Origin Systems の初代 *Wing Commander* (1990, DOS/VGA)  
現状確認: ローカル版を Playwright Headless で `1280×720` に表示して確認

## 調査で見えた本家の核

- ゲームの中心は「宇宙戦闘」単体ではなく、TCS *Tiger's Claw* に所属するパイロットとして艦内生活を送り、ブリーフィングを受け、出撃し、帰艦して次の作戦へ進む連続体。
- 艦内は単なるメニューではない。Bar / Rec Room では僚機や乗員との会話と噂、Barracks ではベッドを使ったセーブ、Briefing では人物の大写しと任務情報を体験する。
- 勝敗はその場の勝ち負けで終わらず、ミッション・シリーズの成績によって次の宙域・任務・戦況が変わる。勝てば前進、失敗が続けば防衛・撤退側へ進む。最終的な勝利／敗北までが戦役の報酬。
- 戦闘画面の視線は常に cockpit の中にある。暗い前方視界、厚い風防・計器枠、左右の VDU、中央レーダー、ターゲット情報、速度・武装・シールド／装甲を読む構成が主役。
- 画面ごとに色の役割が違う。戦闘の緑色計器、敵の赤、警告の橙／黄、艦内の赤・橙系 VGA シーンが、画面の目的を一目で伝えている。
- ミッションは patrol / escort / seek-and-destroy / recon など目的が違い、僚機への cockpit 通信や挑発が戦闘のテンポを作る。機体選択も Hornet / Scimitar / Rapier / Raptor の性能差と任務の意味に結び付く。

## 本家調査ソースとキャプチャ

Google Search Grounding で候補を洗い出し、本文・画面は Playwright Headless で直接確認した。MobyGames は直接ページが 403 だったため、Yahoo!画像検索のサムネイルで DOS 版の実画面を照合している。

- [DOS Days — Wing Commander (1990)](https://www.dosdays.co.uk/topics/Games/game_wc.php): Tiger's Claw、任務種別、僚機通信、勝敗による戦役分岐、Barracks セーブ、VGA 資産構成を確認。
- [Wing Commander CIC — WC1 Mission Tree の議論](https://www.wcnews.com/chatzone/threads/hi-guys-question-about-wc1-mission-tree.24123/): ミッションツリーの勝敗分岐、勝利／敗北パス、特殊な脱出結果、WCPedia への導線を確認。
- [MobyGames — Wing Commander screenshots](https://www.mobygames.com/game/3/wing-commander/screenshots/): 画面説明の検索結果を確認。DOS 版 cockpit、briefing、hanger、targeted の分類を照合。
- [現行タイトル画面](../.tmp/wing-commander-research/captures/multi-commander-title.png)
- [現行艦内ハブ](../.tmp/wing-commander-research/captures/multi-commander-hub.png)
- [現行ブリーフィング](../.tmp/wing-commander-research/captures/multi-commander-briefing.png)
- [現行戦闘 HUD / 訓練開始直後](../.tmp/wing-commander-research/captures/multi-commander-combat-training-1.png)
- [現行格納庫](../.tmp/wing-commander-research/captures/multi-commander-hangar.png)
- [本家 DOS cockpit の画像検索キャプチャ](../.tmp/wing-commander-research/captures/wing-commander-image-search.png)
- [本家 briefing / carrier の画像検索キャプチャ](../.tmp/wing-commander-research/captures/wing-commander-briefing-image-search.png)
- [本家 campaign mission tree の画像検索キャプチャ](../.tmp/wing-commander-research/captures/wing-commander-campaign-search.png)

## 現状画面の監査

- 良い点: タイトルの紋章・宇宙背景、CRT 風の人物通信、レーダーベゼル、緑系 HUD、艦内／格納庫／briefing／戦闘までの導線はすでに一貫している。
- 最優先の見た目問題: 1280×720 では艦内ハブのメニューが画面下 (`y=774`) まで伸び、`タイトルへ戻る` とヒントが viewport 外へはみ出す。縦に項目を足したまま縮めるのではなく、部屋カテゴリ・2列化・ページ送りのいずれかが必要。
- Briefing: 左の人物と中央の台詞は雰囲気があるが、右の飛行計画／任務情報は初期表示で暗く、画面の大きな面積が空白に見える。最初の一画面で「何を守る／壊す／どこへ行く」が読めない。
- Combat: 現行 HUD は機能が多い一方、前方の鮮やかな星雲・恒星・惑星が cockpit より先に目に入り、敵がいない初期状態では左 TARGET VDU が大きな空欄になる。本家のように cockpit frame と VDU の情報密度を主役にする必要がある。
- Combat: 現行の中央計器は `GUN PWR`、`AB FUEL`、シールド／装甲、レーダーを持っているが、左右 VDU の役割が本家の「状態／損傷」「ターゲット／航法／通信」として固定されていない。何を見れば次の操作が決まるかが弱い。
- Hangar: 機体・僚機・補給値は読めるが、機体の姿、武装の差、任務への適性を視覚的に比較する画面にはなっていない。
- 戦役: 現在の `campaign.ts` は 9 章の小さなグラフで、最初の任務も `McCaffrey`。本家の Vega Sector のシリーズ／勝利側・撤退側を見せるミッションツリーとは、物語上の手触りと可視性がまだ遠い。

## TODO

### P0 — 体験の骨格を本家のループへ寄せる

- [x] **戦役を「シリーズ＋勝利点＋前進／撤退ルート」に再設計する**
  - 対象: [`src/content/campaign.ts`](src/content/campaign.ts)、[`src/content/missions.ts`](src/content/missions.ts)、[`src/app/App.ts`](src/app/App.ts)
  - `CampaignNode` にシリーズ名、所属宙域、勝利条件／敗北条件、勝利点、次の win/loss ノード、戦況メッセージを持たせる。
  - 本家に寄せるモードでは Enyo を起点にし、McAuliffe / Gateway など「勝てば前進・失敗すれば後退」の見える分岐を作る。現行の独自 `McCaffrey` 開始ルートと動的前線作戦は、canon campaign と拡張 campaign を分けて扱う。
  - 戦役マップ上で現在地、到達済み、勝利ルート、撤退ルート、未到達を表示し、デブリーフで次の分岐を明示する。
  - 完了条件: 同じ初期セーブから win / loss を再生すると、次のシステム・任務種別・台詞・敵構成が変わり、マップで差が確認できる。

- [x] **艦内ハブを「部屋へ移動する体験」にする**
  - 対象: [`src/app/App.ts`](src/app/App.ts)、[`src/ui/HubPanels.ts`](src/ui/HubPanels.ts)、`src/ui/ScreenHost.ts`、艦内背景アセット
  - 現在の 11 項目の縦メニューを、`Briefing / Flight Deck / Bar / Barracks / Ready Room` の部屋単位に整理する。1280×720 で全項目とヒントが常に見えること。
  - Bar は pilot をクリック／選択して会話・噂・関係値を進める。Barracks は本家に合わせて 8 セーブスロットを持ち、帰艦後にだけ保存できるようにする。
  - 完了条件: ミッション間に同じ画面の「次の出撃」へ直行せず、艦内の場所と人を選んでから briefing／hangar に進む。会話とセーブが次の出撃に意味を持つ。

- [x] **cockpit を固定構図の主役にする**
  - 対象: [`src/hud/HudView.ts`](src/hud/HudView.ts)、[`src/styles/cockpit.css`](src/styles/cockpit.css)、[`src/render/Cockpit.ts`](src/render/Cockpit.ts)
  - 本家の 4:3 に近い内側の視界を定義し、厚い風防／ダッシュボード枠の内側に前方視界を閉じ込める。16:9 では左右に余白を残しても、cockpit の基準比率を崩さない。
  - 左 VDU = 自機状態・シールド／装甲・損傷・電力、中央 = 照準・速度・レーダー、右 VDU = ターゲット・航法・通信に役割を固定する。敵／味方／NAV の色と記号も固定する。
  - ターゲットなし時も「次の NAV、距離、現在の選択武装、僚機状態」を空欄ではなく表示する。
  - 完了条件: cockpit の境界、VDU、レーダー、ターゲット情報が宇宙背景より先に視認でき、初見で「操縦・狙う・通信・NAV」の4操作が分かる。

- [x] **戦闘の主目的を「敵を撃つ」から任務遂行へ置き直す**
  - 対象: [`src/content/missions.ts`](src/content/missions.ts)、`src/mission/`、`src/sim/`、[`src/hud/HudView.ts`](src/hud/HudView.ts)
  - patrol / escort / strike / recon / rescue / capital ship で、敵の全滅以外の勝敗条件を主役にする。輸送艦、基地、航路ブイ、Nav beacon の状態を画面上で追えるようにする。
  - 任務シリーズ単位で成功率を集計し、失敗時は防衛任務・味方不利・機体制限など、次の出撃に見える不利益を発生させる。
  - 完了条件: 1任務の勝敗が撃墜数だけで決まらず、護衛対象・Nav・帰投・時間・僚機生存がデブリーフと戦役分岐に反映される。

### P1 — 本家らしい画面・操作・演出にする

- [x] **画面ごとの色設計を分離する**
  - 対象: [`src/styles/base.css`](src/styles/base.css)、[`src/styles/ui.css`](src/styles/ui.css)、背景／パネルアセット
  - cockpit は緑＋敵赤＋警告橙、Briefing は赤／橙系の軍用 CRT、Bar / Hangar は暖色の艦内照明、戦況マップは青系 tactical map にする。
  - 全画面に同じ緑文字を敷かず、今いる場所と情報の種類を色で伝える。背景の `brightness(0.34)` だけに頼らず、パネルごとに文字と背景のコントラストを測る。
  - 完了条件: タイトル／艦内／briefing／戦闘をサムネイルで並べても、色だけで画面の役割を区別できる。

- [x] **Briefing を「人物＋作戦資料」の一画面に仕上げる**
  - 対象: [`src/ui/BriefingScene.ts`](src/ui/BriefingScene.ts)、[`src/styles/ui.css`](src/styles/ui.css)、[`src/app/App.ts`](src/app/App.ts)
  - 現在の `flight-plan` / `lower-left` / `lower-right` の資料を、1行目の後から順に開示しつつ、常に最低限の作戦概要・目標・Nav route は読める状態にする。
  - 本家の mission briefing のように、話者の表情、作戦図、敵／味方の識別、出撃機と僚機を一つの tactical desk にまとめる。右列が暗い空白に見えないよう、航路線・Nav 名・距離・脅威アイコンに高いコントラストを付ける。
  - 完了条件: キャプチャ直後でも `objective / route / ship / wingman` が読め、台詞を進めると詳細が増える。

- [x] **Hangar を機体と loadout の比較画面にする**
  - 対象: [`src/app/App.ts`](src/app/App.ts)、[`src/ui/HubPanels.ts`](src/ui/HubPanels.ts)、`public/art/`、[`src/content/ships.ts`](src/content/ships.ts)、[`src/content/weapons.ts`](src/content/weapons.ts)
  - Hornet / Scimitar / Rapier / Raptor をシルエットまたは blueprint で表示し、速度・旋回・装甲・砲・副兵装を同じスケールで比較する。
  - ミサイル、flare、予備部品、僚機 slot を選び、補給量と出撃可能性をその場で示す。現在の「順番に機体を変える」操作は一覧／選択状態へ変更する。
  - 完了条件: 機体変更が見た目と任務適性の判断になり、briefing の任務目標と hangar の loadout が一致する。

- [x] **僚機通信を戦術システムとして見せる**
  - 対象: [`src/ui/CommsMenu.ts`](src/ui/CommsMenu.ts)、[`src/app/input.ts`](src/app/input.ts)、[`src/sim/ai.ts`](src/sim/ai.ts)、pilot dialogue／roster
  - `Break and attack / Form on my wing / Cover me / Attack my target / Status` を機体・性格・距離に応じて実際の AI 行動へつなぐ。Kilrathi への taunt と、僚機の返答も追加する。
  - 通信メニューを開いても戦闘が読めるように、短い command wheel と現在の僚機状態を使う。指示成功／無視／戦死を debrief と関係値へ返す。
  - 完了条件: 同じ戦闘で命令を変えると敵の撃破速度・僚機の位置・台詞が変わり、単なる演出ではない。

- [x] **3D 空間を cockpit の可読性に従属させる**
  - 対象: [`src/render/SceneSetup.ts`](src/render/SceneSetup.ts)、[`src/render/Starfield.ts`](src/render/Starfield.ts)、[`src/render/Landmarks.ts`](src/render/Landmarks.ts)、[`src/render/Cockpit.ts`](src/render/Cockpit.ts)
  - 現行キャプチャの強い恒星・星雲・惑星が照準と HUD を奪うため、bloom／露出／ネビュラ彩度／惑星サイズを調整する。Nav と敵機のシルエットが背景に埋もれない距離・色・後光を決める。
  - 本家の pre-rendered sprite 的な読みやすさを参考に、敵機を低ポリゴン化するだけでなく、正面・側面・背面のシルエット、被弾フラッシュ、爆発、距離別サイズを意図的に設計する。
  - 完了条件: 戦闘キャプチャで最初に読めるのが恒星ではなく、照準・ターゲット・レーダー・現在の目標になる。

- [x] **ダメージ／資源の UI とゲーム結果を結び付ける**
  - 対象: [`src/sim/damage.ts`](src/sim/damage.ts)、[`src/sim/subsystems.ts`](src/sim/subsystems.ts)、[`src/app/App.ts`](src/app/App.ts)、[`src/hud/HudView.ts`](src/hud/HudView.ts)
  - シールドと装甲を別々に読ませ、レーダー故障、砲故障、エンジン損傷、燃料／afterburner 消費を VDU の状態と操作制限に反映する。
  - 帰投できた場合の損傷、弾薬、僚機の負傷／戦死、昇進・勲章を debrief → Barracks → 次の hangar に持ち越す。
  - 完了条件: 低燃料・損傷・弾切れがプレイ判断を変え、戦闘終了後の画面でもその結果が確認できる。

- [x] **launch／return／debrief の儀式を作る**
  - 対象: [`src/app/DeckSequence.ts`](src/app/DeckSequence.ts)、[`src/app/App.ts`](src/app/App.ts)、[`src/audio/`](src/audio/)、[`src/ui/BriefingScene.ts`](src/ui/BriefingScene.ts)
  - 艦内から飛行甲板、カタパルト、発艦 radio、Nav 到着、着艦、debrief への遷移を短い演出でつなぐ。本家の「艦に所属している」感覚を、画面の切り替えだけで終わらせない。
  - 成功／失敗、僚機喪失、脱出、敵エース撃墜で台詞・音楽・画面のトーンを変える。
  - 完了条件: 出撃前後に 10〜20 秒程度の短い scene があり、任務の結果が次の艦内会話へ戻る。

### P2 — 仕上げと回帰確認

- [x] **1280×720 / 1366×768 / 1920×1080 / モバイル幅の画面 QA を固定する**
  - 対象: `src/styles/ui.css`、`src/styles/cockpit.css`、`ScreenHost.ts`
  - ハブの縦メニュー、briefing の3列、cockpit の VDU、戦闘下部 message bar が viewport 外へ出ないことを確認する。
  - 画面ごとの Playwright スクリーンショットを baseline にし、タイトル→ハブ→briefing→hangar→戦闘→debrief を1本の smoke flow として残す。

- [x] **キャンペーンの「見える記録」を増やす**
  - 対象: [`src/app/statistics.ts`](src/app/statistics.ts)、[`src/ui/HubPanels.ts`](src/ui/HubPanels.ts)、`src/content/aces.ts`、medal／rank 系
  - 撃墜数だけでなく、任務成功率、護衛成功、Nav 到達、僚機生存、エース撃墜、勝利／撤退ルート、勲章を戦役マップと killboard に表示する。
  - 完了条件: プレイヤーが「なぜ今この任務／このルートなのか」を自室・killboard・戦況マップのいずれかで説明できる。

- [x] **本家寄せモードと独自拡張モードの境界を明示する**
  - 対象: [`src/app/App.ts`](src/app/App.ts)、[`src/app/settings.ts`](src/app/settings.ts)、campaign／frontline 系
  - 本家調査に基づく canon campaign、現在の `McCaffrey` 開始＋dynamic frontline、訓練室を別モードとしてタイトルまたは設定から選べるようにする。
  - 完了条件: プレイヤーが「本家寄せの戦役」と「MULTI-COMMANDER 独自の戦況作戦」を混同しない。

- [x] **最低限の自動回帰テストを追加する**
  - 対象: `tests/` または `multi-commander` のテスト構成、campaign／mission／input／HUD
  - campaign の全ノードが到達可能で終端へ進むこと、win/loss で適切な node に進むこと、missile／throttle／comms／save が画面と state を一致させることをテストする。
  - 完了条件: UI の見た目を変えても、戦役分岐・資源消費・僚機状態・帰投条件が壊れていないことを build/test と Playwright smoke で検出できる。

## 実装順の推奨

1. P0 の campaign graph と艦内ハブを先に固める。
2. P0 の cockpit 固定構図と任務目的表示を作り、戦闘の視線を決める。
3. P1 の色分け、briefing、hangar、僚機通信を順に足す。
4. 最後に launch／return 演出、画面 QA、回帰テストで磨く。

「本家から遠い」原因は、個別の装飾不足よりも、艦内生活・戦役分岐・cockpit 読解が一つのループとして結び付いていないこと。まずこの3本を同じデータから動かすのが最短の改善軸。

## 実装・検証済み

- canon（Enyo 起点）と expanded（McCaffrey 起点）を分離し、勝利点・シリーズ・戦役マップ・前進／撤退ルートを保存。
- 艦内ハブを2列の部屋導線に整理し、Bar会話、Barracks 8スロット保存、Hangar比較、Briefing資料を接続。
- cockpit の左右VDU役割、ターゲットなし状態、通信6コマンド、ダメージ／資源／帰艦記録を実装。
- `npm run typecheck`、`npm test -- --run`（157 tests）、`npm run build` を通過。
- Playwright Headlessで 1280×720 / 1366×768 / 1920×1080 / 390×844 を確認し、主要画面のviewport外要素なしを確認。
