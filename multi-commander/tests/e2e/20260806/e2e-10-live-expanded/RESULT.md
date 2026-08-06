# E2E-10 LIVE EXPANDED 結果

実施日: 2026-08-06  
対象: `http://127.0.0.1:4173/`  
操作: Playwright headless MCP

## 結果

結果: PASS

- localStorage / sessionStorage を初期化してから開始。
- タイトルで新規戦役モードを `CANON / ENYO` から `EXPANDED / McCAFFREY` へ切替。
- 新規戦役を開始し、母艦 → 戦況マップへ遷移。
- 「最も危険な星系へ作戦を立てる」を画面UIから実行。
- 動的作戦として `Gimle 補給線護衛`（`escort` 相当、戦況作戦）が生成され、対象星系は `Gimle`。
- 母艦へ戻り、ブリーフィングで目標 `補給船団を守る` / `船団を帰投させる`、飛行計画の `母艦` / `発艦点` / `帰投` を確認。
- `出撃 (操作案内あり)` を押して、動的作戦の実出撃・戦闘画面まで到達。
- 戦闘画面では `T / R / Y` のターゲット操作表示、主砲、ダムファイア、帰投ナビを確認。
- 戦闘画面で`A`を押し、発艦点到達後に帰投ナビへ移行することを確認。
- 再度`A`を押して帰投ナビへ到達し、`任務達成`デブリーフを表示。
- デブリーフの`続ける`で母艦へ復帰し、動的作戦が消化され、Gimleの戦況値が更新されることを確認。

## 未完了事項

今回の正常系では、敵を撃墜せずに補給船団を維持したまま帰投したため、目標「補給船団を守る」は未達表示だった。一方、必須目標の帰投と任務達成デブリーフ、母艦復帰、戦況更新は確認できた。

## 証跡

各 `.md` はPlaywright accessibility snapshot、各 `.png` はfullPage PNG。

- [01-title-initial.md](./01-title-initial.md) / [01-title-initial.png](./01-title-initial.png)
- [02-title-expanded.md](./02-title-expanded.md) / [02-title-expanded.png](./02-title-expanded.png)
- [03-new-campaign-hub.md](./03-new-campaign-hub.md) / [03-new-campaign-hub.png](./03-new-campaign-hub.png)
- [04-war-map-before-operation.md](./04-war-map-before-operation.md) / [04-war-map-before-operation.png](./04-war-map-before-operation.png)
- [05-carrier-after-dynamic-operation.md](./05-carrier-after-dynamic-operation.md) / [05-carrier-after-dynamic-operation.png](./05-carrier-after-dynamic-operation.png)
- [06-briefing.md](./06-briefing.md) / [06-briefing.png](./06-briefing.png)
- [07-combat-launch-training.md](./07-combat-launch-training.md) / [07-combat-launch-training.png](./07-combat-launch-training.png)
- [08-combat-interrupted.md](./08-combat-interrupted.md) / [08-combat-interrupted.png](./08-combat-interrupted.png)
- [09-debrief-win.md](./09-debrief-win.md) / [09-debrief-win.png](./09-debrief-win.png)
- [10-returned-hub.md](./10-returned-hub.md) / [10-returned-hub.png](./10-returned-hub.png)
- [console-errors.txt](./console-errors.txt)
- [console-errors-final.txt](./console-errors-final.txt)

最終セッションの`console-errors-final.txt`はErrors 0。旧セッションの`console-errors.txt`に記録された46件は、Vite HMR WebSocket接続失敗等であり、アプリ由来のJavaScript errorではない。

アプリコードは変更していない。
