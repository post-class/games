# E2E-13 入力契約テスト

## 目的

入力イベントを送信した事実ではなく、実ブラウザのイベント経路を通った入力がゲーム状態と HUD に反映されたことを確認する。特に、単発の `]` / `[`、押しっぱなし、数字キー、canvas 上のホイールを個別に判定する。

## 共通条件

- 対象 URL はテスト実行時の Vite URL とする。
- quiet 訓練を開始し、`window.__mc.game.deck.phase === 'none'` になるまで待機する。
- `#view` の bounding box を取得し、キーボード以外の入力は canvas 中央付近へマウスを移動してから実行する。
- `window.__mc.game.input.throttle` は読み取り専用の観測にだけ使う。テスト中に直接代入しない。
- 毎ステップ、HUD の `THROTTLE` 表示、読み取り値、viewport、console error 件数を記録する。
- 各ステップの前後でスクリーンショットと accessibility snapshot を保存する。

## 事前確認

```js
await page.waitForFunction(() => window.__mc?.game?.active === true);
await page.waitForFunction(() => window.__mc?.game?.deck?.phase === 'none');

const inputTarget = await page.locator('#view').boundingBox();
if (!inputTarget) throw new Error('#view canvas is not visible');

const inputPath = await page.evaluate(() => ({
  overlayPointerEvents: getComputedStyle(document.querySelector('#overlay')).pointerEvents,
  canvasPointerEvents: getComputedStyle(document.querySelector('#view')).pointerEvents,
  scrollX: window.scrollX,
  scrollY: window.scrollY,
}));
if (inputPath.overlayPointerEvents !== 'none') throw new Error('overlay must be transparent to pointer input');
```

画面操作で数字 `0` を押し、スロットルが `0%` になったことを HUD とゲーム状態の両方で確認する。状態を直接書き換えてはいけない。

## ホイールの観測プローブ

`page.mouse.wheel()` 自体は DOM の `WheelEvent` を返さないため、ホイール操作前に document のバブルフェーズへ一時的な読み取り専用プローブを登録する。canvas のリスナーが `preventDefault()` を呼んだ後の状態を観測する。

```js
await page.evaluate(() => {
  window.__wheelProbe = undefined;
  document.addEventListener('wheel', (event) => {
    window.__wheelProbe = {
      defaultPrevented: event.defaultPrevented,
      targetId: event.composedPath().find((node) => node instanceof HTMLElement)?.id ?? '',
    };
  }, { once: true });
});
```

## 判定表

各ケースは前ケースの結果に依存させず、必要なら画面操作で数字 `0` に戻してから実行する。

| ID | 操作 | 初期値 | 直後の期待値 | 必須確認 |
|---|---|---:|---:|---|
| I-01 | `page.keyboard.press(']')` | 0% | 10% | HUD と読み取り値が 10% |
| I-02 | `page.keyboard.press('[')` | 10% | 0% | HUD と読み取り値が 0% |
| I-03 | canvas 上で `page.mouse.wheel(0, -100)` | 0% | 10% | HUD、読み取り値、`defaultPrevented: true`、target が `view` |
| I-04 | canvas 上で `page.mouse.wheel(0, 100)` | 10% | 0% | HUD、読み取り値、ページスクロールなし |
| I-05 | `page.keyboard.press('5')` | 0% | 50% | HUD と読み取り値が 50% |
| I-06 | `page.keyboard.down(']')` → 250ms待機 → `page.keyboard.up(']')` | 0% | 10%超 | 押下時間中に値が連続増加 |

## 各ケースの実施手順

1. 初期 HUD、ゲーム状態、`scrollX` / `scrollY`、console error 件数を保存する。
2. 表のイベントを1つだけ実行する。ホイールの場合は `#view` の bounding box 内へ移動してから実行する。
3. 1フレーム以上待機し、HUD とゲーム状態を再取得する。
4. 期待値と完全一致するか、I-06の場合は初期値より大きくなっているかを判定する。
5. 前後スクリーンショット、snapshot、取得値、イベント内容、判定結果を同じケースディレクトリへ保存する。

## チュートリアルと異常系

- I-01〜I-05 のいずれかでスロットルが 35% を超えた後、`.mc-tutorial` が `訓練 2 / 6` へ進むことを確認する。
- `contextmenu` が表示されないこと、console error が増えないこと、`scrollX` / `scrollY` が変化しないことを確認する。
- 期待値が変化しない場合は、操作済みでも PASS にせず FAIL とする。操作前後の証跡、console/network 記録を残す。
- `deck.phase` が `none` にならない、HUD と読み取り値のどちらかしか取得できない場合は未検証とする。

## 期待成果物

- `I-01`〜`I-06` の前後スクリーンショット
- 各ケースの accessibility snapshot
- 入力イベント、前後値、HUD 値、viewport、scroll 状態、wheel probe、判定結果をまとめた `RESULT.md`
- console error と必要に応じた network 記録
