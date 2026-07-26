# Multi-Dommander

ブラウザで動く 3D 宇宙戦闘ゲーム。ウィングコマンダー系のドッグファイトを、ニュートン力学ベース（フライトアシスト切替つき）で再現した縦切りプロトタイプ。TypeScript + Three.js + 自作軽量 ECS。

## 起動

```bash
npm install
npm run dev      # http://localhost:5173/
```

その他:

```bash
npm run build    # 型チェック + 本番ビルド (dist/)
npm run preview  # ビルド結果をプレビュー
npm test         # ユニットテスト (vitest)
```

## 操作方法

| 操作 | キー |
|---|---|
| ピッチ (機首上下) | W / S またはマウス上下 |
| ヨー (左右旋回) | A / D またはマウス左右 |
| ロール | Q / E |
| スロットル増減 | ↑ / ↓ |
| ブレーキ | X |
| アフターバーナー | Shift |
| エネルギー砲 | Space |
| ミサイル発射 | F |
| フライトアシスト ON/OFF | Z |
| マウス操縦 ON/OFF | M |
| 次のターゲット | T |
| 最至近ターゲット | R |
| 前方ターゲット | Y |
| リスタート (終了後) | R |

- **フライトアシスト ON**: 入力していない方向の速度が減衰し、速度上限内でウィングコマンダー的に扱いやすい。
- **フライトアシスト OFF**: 純慣性。推力を切っても等速直線運動を続け、リアルなニュートン挙動になる。
- スロットルはレバー式。キーを離しても値を保持する。

## ゲーム内容 (縦切り)

自機 Rapier II で、敵編隊 (Dralthi ×3, Gratha ×2) と空戦する。全機撃墜で **MISSION COMPLETE**、自機撃墜で **SHIP DESTROYED**。

HUD: シールド/アーマー/ハル、スロットル/速度、エネルギー/ミサイル残弾、ターゲット情報、リードインジケータ（命中予測）、画面外ターゲット矢印、レーダー。

## アーキテクチャ

```
src/
├── ecs/          自作軽量 ECS (World / Component / System)
├── game/
│   ├── Game.ts        固定dt物理 + 可変dt描画ループ (Fix Your Timestep)
│   ├── components.ts  全コンポーネント定義
│   ├── systems/       Input/Flight/Weapon/Projectile/Missile/Collision/
│   │                  Damage/Targeting/AI/GameRule/Sync/Hud/Explosion
│   ├── ships/         データ駆動の機体定義 + ファクトリ
│   ├── weapons/       弾/ミサイル生成
│   └── input/         入力集約 + マウスジョイスティック
├── render/       Three.js シーン / メッシュ生成 / カメラ / 星空
├── hud/          DOM+CSS の HUD, リード計算, レーダー
├── util/         数学ヘルパー, イベントバス
└── config/       物理・入力バインドのチューニング値
```

- **物理**: 6DOF ニュートン積分。姿勢はクォータニオン、並進は機体ローカル推力→ワールド加速度。物理エンジンは非使用。
- **衝突**: 弾は前フレーム→現フレームの線分-球スイープ（高速弾のすり抜け対策）。
- **AI**: `Idle → Pursue → Attack → Evade` の FSM。プレイヤーと同じ `ThrusterInput` を生成し、飛行制御を共通化。
- **アセット**: 現在はプログラマアート（プリミティブ）。`ShipDefinition.visual.kind` を `gltf` にして GLTFLoader を実装すれば実アセットへ差し替え可能。

## 今後の拡張

ミッション基盤 → ブリーフィング/デブリーフ → 僚機 → キャンペーン分岐 → サウンド (`AudioManager` 雛形あり) → 実アセット。
