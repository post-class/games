# W5 オーディオ設定に「BGM」と「効果音」を追加する

対象要件: 依頼 §要件 4・5

---

## 現状

### BGM

| 要素 | 現状 |
|---|---|
| 曲の実体 | `public/audio/music/` に MP3 10本 |
| 場面 → 曲の対応 | `src/audio/musicCues.ts` の `MUSIC_TRACKS`（**固定**） |
| 場面キュー | `title / hub / briefing / patrol / tension / combat / intenseCombat / boss / victory / defeat` + `nemesis`（boss を流用） |
| 選曲する側 | 画面遷移は `App` が `music.play(id)`、戦闘中は `CombatAudio` が `combatMusicCue()` の結果を `playBattle(id)` |
| 設定 | `volumeMusic`（音量のみ） |

`nemesis` は `musicPath()` で `boss` の実ファイルへ落ちる特別扱い。

### 効果音

すべて `src/audio/AudioManager.ts` の Web Audio 合成音。ただし主砲とミサイルは
`public/audio/weapons/*-after3.wav` を読み込み、**読めたらそちらを優先**して鳴らす
（`playAfter3WeaponAudio()`）。設定は `volumeSfx`（全体音量）のみで、
**種類ごとの切り替えは無い**。

---

## あるべき姿

- オーディオタブが「音量」「BGM」「効果音」の3セクションに分かれる。
- **BGM**: 11 の場面それぞれに対し、同梱 10 曲 + 「無音」から選べる。既定は現在の対応。
- **効果音**: 8 カテゴリそれぞれに対し、音源（実音声 / 合成音 / 無音）と音量倍率を選べる。
- どちらも**その場で試聴できる**（既存の `SoundCheckPanel` を拡張して流用する）。
- 設定は保存され、選び直すまで維持される。

---

# W5-A BGM の場面別選択

## 手順

### 手順 5A-1 場面キューと曲ファイルを別の型にする

`src/audio/musicCues.ts` を次の構造へ変える。**曲ファイルの id と場面の id を分離**する
（今は `MusicTrackId` が両方を兼ねているため、差し替えを表現できない）。

```ts
/** 同梱している曲ファイル。値は public 配下のパス。 */
export const MUSIC_FILES = {
  'title-space-fighter': '/audio/music/01-title-space-fighter-loop.mp3',
  'combat-five-armies': '/audio/music/02-combat-five-armies.mp3',
  'combat-impact-moderato': '/audio/music/03-combat-impact-moderato.mp3',
  'combat-rising-game': '/audio/music/04-combat-rising-game.mp3',
  'patrol-crypto': '/audio/music/05-patrol-crypto.mp3',
  'briefing-echoes-of-time': '/audio/music/06-briefing-echoes-of-time.mp3',
  'tension-unseen-horrors': '/audio/music/07-tension-unseen-horrors.mp3',
  'danger-gathering-darkness': '/audio/music/08-danger-gathering-darkness.mp3',
  'boss-black-vortex': '/audio/music/09-boss-black-vortex.mp3',
  'investigation-investigations': '/audio/music/10-investigation-investigations.mp3',
} as const;

export type MusicFileId = keyof typeof MUSIC_FILES;
/** 「この場面では鳴らさない」を選べるようにする */
export type MusicChoice = MusicFileId | 'silent';

/** 場面キュー。曲ではなく「どういう場面か」を表す。 */
export const MUSIC_CUES = [
  'title', 'hub', 'briefing', 'patrol', 'tension',
  'combat', 'intenseCombat', 'boss', 'nemesis', 'victory', 'defeat',
] as const;
export type MusicTrackId = (typeof MUSIC_CUES)[number];   // 既存の型名は維持する

/** 場面 → 曲の既定対応（現在の見え方・聞こえ方をそのまま写したもの）。 */
export const DEFAULT_MUSIC_ASSIGNMENT: Record<MusicTrackId, MusicChoice> = {
  title: 'title-space-fighter',
  hub: 'briefing-echoes-of-time',
  briefing: 'investigation-investigations',
  patrol: 'patrol-crypto',
  tension: 'tension-unseen-horrors',
  combat: 'combat-five-armies',
  intenseCombat: 'combat-impact-moderato',
  boss: 'boss-black-vortex',
  nemesis: 'boss-black-vortex',     // 従来 musicPath() が boss へ落としていたのと同じ
  victory: 'combat-rising-game',
  defeat: 'danger-gathering-darkness',
};
```

**`MUSIC_TRACKS` は削除しない。** `SoundCheckPanel` と `App` の音楽クレジット画面が
参照しているため、`MUSIC_TRACKS` は `DEFAULT_MUSIC_ASSIGNMENT` から生成した
「場面 → パス」の互換オブジェクトとして残し、JSDoc に「互換用。新規は
`MUSIC_FILES` / `musicPath()` を使う」と書く。
（`grep -rn "MUSIC_TRACKS" src` で参照箇所を確認してから決める。全参照を移せるなら移して削除する。）

### 手順 5A-2 差し替えを反映する `musicPath()`

```ts
let assignment: Record<MusicTrackId, MusicChoice> = { ...DEFAULT_MUSIC_ASSIGNMENT };

/**
 * 場面 → 曲の対応を上書きする（設定から呼ぶ）。
 * 未知のキー・未知の曲 id は無視して既定を保つ（壊れた保存データで無音にしない）。
 */
export function setMusicAssignment(next: Partial<Record<MusicTrackId, MusicChoice>>): void

/** 場面に対応する曲のパス。'silent' を選んだ場面は空文字を返す。 */
export function musicPath(id: MusicTrackId): string
```

`audio/` 層から `app/settings` を import しない（`AudioManager` は例外的に import しているが、
`musicCues` は純関数のままにしてテストしやすさを保つ）。
**設定の反映は `App` 側で `onSettingsChanged` から `setMusicAssignment()` を呼ぶ**。

### 手順 5A-3 「無音」を扱う

`src/audio/MusicDirector.ts` の `ensurePlayback()` は `musicPath(id)` を使っている。
先頭に次を足す。

```ts
    const path = musicPath(id);
    if (!path) {
      // この場面は「無音」を選ばれている。鳴っている曲はクロスフェードで落とす。
      if (this.active) {
        this.active.target = 0;
        this.fading.push(this.active);
        this.active = undefined;
      }
      return;
    }
```

`request()` は `requested` を更新するので、無音のあとに別の場面へ移れば普通に鳴り出す。

### 手順 5A-4 設定項目

`src/app/settings.ts`

```ts
  /** 場面ごとに鳴らす BGM（W5-A）。未設定の場面は既定の曲を使う */
  musicAssignment: Partial<Record<MusicTrackId, MusicChoice>>;
```

- `DEFAULT_SETTINGS.musicAssignment = {}`（空 = 全部既定）。
- `normalizeSettings()` で、**キーが `MUSIC_CUES` に無いもの・値が `MUSIC_FILES` にも
  `'silent'` にも無いものを捨てる**。壊れた保存データで無音固定にならないようにする。
- `loadSettings()` / `updateSettings()` の後に `setMusicAssignment(settings.musicAssignment)`
  を呼ぶ経路を用意する（`App` の `onSettingsChanged` 購読で1か所にまとめる）。

### 手順 5A-5 設定 UI

オーディオタブに BGM セクションを追加する。11 行 × 「◀ 曲名 ▶ ＋試聴」。

```
── BGM ──────────────────────────────
タイトル       ◀ 01 Space Fighter ▶  [試聴]
母艦（艦内）   ◀ 06 Echoes of Time ▶ [試聴]
ブリーフィング ◀ 10 Investigations ▶ [試聴]
哨戒（敵なし） ◀ 05 Crypto ▶         [試聴]
緊張（敵1機）  ◀ 07 Unseen Horrors ▶ [試聴]
戦闘（敵2〜3） ◀ 02 Five Armies ▶    [試聴]
激戦（敵4機〜）◀ 03 Impact Moderato ▶[試聴]
ボス・エース   ◀ 09 Black Vortex ▶   [試聴]
宿敵の演出     ◀ 09 Black Vortex ▶   [試聴]
勝利           ◀ 04 Rising Game ▶    [試聴]
敗北           ◀ 08 Gathering Darkness ▶ [試聴]
（説明）戦闘中の曲は近くの敵の数で切り替わります（哨戒 0 / 緊張 1 / 戦闘 2〜3 / 激戦 4機以上）。
```

- 場面のラベルは `SoundCheckPanel` の `labels` と**同じ出所**にする。
  `musicCues.ts` に `MUSIC_CUE_LABEL: Record<MusicTrackId, string>` を置き、両方から読む。
- 曲名のラベルも `musicCues.ts` に `MUSIC_FILE_LABEL: Record<MusicFileId, string>` を置く。
  ファイル名の番号（01〜10）を前置して並び順が分かるようにする。
- 選択肢は `MUSIC_FILES` の 10本 + 「無音」。
- 試聴は `MusicDirector.play()` を直接呼ばず、**設定パネルの外（App）から渡した
  コールバック**で行う（`SettingsPanel` は `audio` 層を import していないため）。
  `buildSettingsPanel(onChange)` の引数へ
  `actions?: { previewMusic(cue: MusicTrackId): void; previewSfx(cat: SfxCategory): void }`
  を追加する。設定画面を閉じたら元の曲へ戻す（音楽クレジット画面が
  `previousTrack` を覚えて戻しているのと同じ方式。`App.ts:2244` 付近を参考にする）。

---

# W5-B 効果音の選択

## カテゴリと選択肢

| カテゴリ id | 対象の音 | 選択肢 | 既定 |
|---|---|---|---|
| `gun` | 主砲（`AudioManager.gun`） | 実音声 (after3) / 合成音 / 無音 | 実音声 |
| `missile` | ミサイル発射（`missileLaunch`） | 実音声 / 合成音 / 無音 | 実音声 |
| `impact` | シールド・装甲・船体被弾（`shieldHit` / `armorHit`） | 合成音 / 無音 | 合成音 |
| `explosion` | 爆発（`explosion`） | 合成音 / 無音 | 合成音 |
| `warning` | 警報（`warning` / `damageStageCue`） | 合成音 / 控えめ / 無音 | 合成音 |
| `lock` | ミサイルロック音（`lockTone`） | 合成音 / 控えめ / 無音 | 合成音 |
| `ui` | UI ビープ・発射不可・Nav 到達（`beep` / `warpTone` / `motif`） | 合成音 / 無音 | 合成音 |
| `voice` | 無線の合成音声（`radioVoice`） | 合成音 / 無音 | 合成音 |
| `engine` | 自機のエンジン音（`updateEngine`） | 合成音 / 無音 | 合成音 |

「控えめ」は音量 0.5 倍・持続 0.7 倍の派生（警報が耳に刺さるという要望に応えるための選択肢）。
**新しい音源ファイルは追加しない**（同梱アセットを増やさない方針を維持する）。

## 手順

### 手順 5B-1 設定項目

`src/app/settings.ts`

```ts
export type SfxCategory =
  | 'gun' | 'missile' | 'impact' | 'explosion'
  | 'warning' | 'lock' | 'ui' | 'voice' | 'engine';

/** 音源の選び方。'sample' は同梱 wav、'synth' は Web Audio 合成、'soft' は合成の控えめ版 */
export type SfxSource = 'sample' | 'synth' | 'soft' | 'off';

export interface SfxSetting {
  source: SfxSource;
  /** 0..1 の音量倍率（カテゴリ単位。`volumeSfx` に掛かる） */
  gain: number;
}
```

`Settings` へ `sfx: Record<SfxCategory, SfxSetting>` を追加し、
`DEFAULT_SFX` を定義する（上表の既定 + `gain: 1`）。

- `normalizeSettings()`: 各カテゴリについて、
  そのカテゴリが**許可していない `source`**（例: `impact` の `'sample'`）が入っていたら既定へ戻す。
  許可表 `SFX_SOURCE_OPTIONS: Record<SfxCategory, SfxSource[]>` を settings 側に置き、
  **UI の選択肢もこの表から生成する**（表示と実挙動を同じ出所にする）。
- `gain` は `clampSetting(値, 0, 1, 1)`。
- `settingsVersion` は W4 で 4 に上げるので、ここでは上げない（同じ回の変更のため）。

### 手順 5B-2 `AudioManager` を設定に従わせる

`src/audio/AudioManager.ts` は既に `settings` を import しているので、内部に補助を1つ置く。

```ts
  /** カテゴリの設定を読む。音を出す各メソッドの入口で使う。 */
  private sfx(category: SfxCategory): { source: SfxSource; gain: number } {
    const s = settings.sfx?.[category];
    return s ?? DEFAULT_SFX[category];
  }
```

各メソッドの先頭へ次を入れる。

| メソッド | 追加する処理 |
|---|---|
| `gun()` | `const s = this.sfx('gun'); if (s.source === 'off') return;`<br>`playAfter3WeaponAudio()` を呼ぶのは `s.source === 'sample'` のときだけ。<br>`spatial()` へ渡すゲインに `s.gain` を掛ける |
| `missileLaunch()` | 同上（`'missile'`） |
| `shieldHit()` / `armorHit()` | `'impact'`。`off` で return、ゲインに `s.gain` |
| `explosion()` | `'explosion'` |
| `warning()` / `damageStageCue()` | `'warning'`。`soft` のとき gain ×0.5・duration ×0.7 |
| `lockTone()` | `'lock'`。同じく `soft` 対応 |
| `beep()` / `warpTone()` / `motif()` | `'ui'` |
| `radioVoice()` | `'voice'`。`off` のときは **0 を返す**（HUD の口の動きは
  `radioVoice` の戻り秒数で駆動しているので、0 を返せば字幕だけが出る。字幕は消えない） |
| `updateEngine()` | `'engine'`。`off` のときは `gain.gain` を 0 へ寄せる（ノードは残す） |

**注意**: `beep()` は `warning` / `lockTone` / `damageStageCue` の内部からも呼ばれている。
`beep()` に `'ui'` の判定を入れると、警報を `off` にしていなくても
`ui` を `off` にした瞬間に警報が消えてしまう。
→ `beep()` の実体を `private tone2(freq, ..., gain)` として切り出し、
`beep()`（UI 用・`'ui'` を見る）と、警報系が使う内部呼び出し（カテゴリを引数で受ける）を分ける。
**この分離を先に行ってから**カテゴリ判定を入れる。

### 手順 5B-3 設定 UI

オーディオタブに効果音セクションを追加する。

```
── 効果音 ────────────────────────────
主砲       ◀ 実音声 ▶ [──────] 100%  [試聴]
ミサイル   ◀ 実音声 ▶ [──────] 100%  [試聴]
被弾       ◀ 合成音 ▶ [──────] 100%  [試聴]
爆発       ◀ 合成音 ▶ [──────] 100%  [試聴]
警報       ◀ 合成音 ▶ [──────] 100%  [試聴]
ロック音   ◀ 合成音 ▶ [──────] 100%  [試聴]
UI・通知   ◀ 合成音 ▶ [──────] 100%  [試聴]
無線の声   ◀ 合成音 ▶ [──────] 100%  [試聴]
エンジン   ◀ 合成音 ▶ [──────] 100%  [試聴]
（説明）「実音声」は同梱の録音、「合成音」はゲーム内で作る音です。「控えめ」は音量と長さを抑えます。
```

- 選択肢は `SFX_SOURCE_OPTIONS[category]` から生成する。
- 試聴は W5-A と同じ `actions.previewSfx(category)` で、`App` 側が
  そのカテゴリの代表音を1発鳴らす（主砲 = laser、被弾 = armorHit(hull)、など）。
  代表音の対応表は `App` に置く。

### 手順 5B-4 既存の試聴パネルを拡張する

`src/ui/SoundCheckPanel.ts` は音楽と無線の試聴を持っている。
効果音カテゴリのボタン列を足し、**設定パネルの試聴と同じコールバック**を使う
（同じ音を2か所で別実装しない）。

---

## 検証

- 単体（`musicCues`）: `setMusicAssignment({combat: 'patrol-crypto'})` の後、
  `musicPath('combat')` が `05-patrol-crypto.mp3` を返す。
  未知の曲 id・未知の場面キーは無視され、既定に戻らない／壊れない。
  `'silent'` を入れると空文字を返す。
- 単体（`MusicDirector`）: `'silent'` の場面を `play()` すると、鳴っていた曲が
  クロスフェードで 0 になり、`active` が undefined になる。別の場面へ移ると再生が始まる。
- 単体（settings）: `sfx` に不正な `source` / 範囲外の `gain` を入れて `loadSettings()` すると、
  既定へ正規化される。カテゴリが許可しない `source`（`impact` の `'sample'`）も弾かれる。
- 単体（AudioManager）: `AudioContext` が無い環境（vitest）でも
  各メソッドが例外を投げないこと。`source: 'off'` で `spatial()` が呼ばれないことを
  スパイで確認する（現状の構造で難しければ、**判定を純関数
  `sfxGain(category, settings): number | null` に切り出してそこをテストする**）。
- ブラウザ: 設定画面で「戦闘」の曲を別の曲へ変え、第1章で敵と交戦して曲が変わることを確認。
  主砲を「無音」にして撃ち、音が出ないこと・他の音は出ることを確認。
</content>
