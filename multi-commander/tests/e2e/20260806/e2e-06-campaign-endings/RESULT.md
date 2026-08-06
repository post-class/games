# E2E-06 結果

結果: PASS（指定の終了系・式典系を確認）

実施内容:

- 最小 localStorage seed `node=victory / campaignMode=canon` を設定し、「続きから」から「完全勝利」を表示。
- 「もう一度戦役を始める」「タイトルへ戻る」をクリック。
- 最小 localStorage seed `node=defeat / campaignMode=expanded` を設定し、「続きから」から「戦役終了」を表示。
- 同終了画面の「もう一度戦役を始める」「タイトルへ戻る」をクリック。
- `__mc.showDebrief('win')` / `__mc.showDebrief('loss')` で任務達成・任務失敗デブリーフを表示し、全メニュー項目を確認。リプレイ項目は空リプレイのため無効。
- `__mc.showMemorial('spirit','victory')` で追悼画面を表示し、「黙祷を終える」をクリック。
- `__mc.showCeremony({medals:['bronze-star'],promotedTo:'中尉'},'victory')` で勲章・昇進を表示し、「解散」をクリック。

証跡:

- `01-victory-canon-title.png` / `.md`
- `02-victory-canon-ending.png` / `.md`
- `03-defeat-expanded-title.png` / `.md`
- `04-defeat-expanded-ending.png` / `.md`
- `05-debrief-win.png` / `.md`
- `06-debrief-loss.png` / `.md`
- `07-memorial-spirit.png` / `.md`
- `08-ceremony-bronze-star.png` / `.md`
- `console-errors.txt`: エラー 0
