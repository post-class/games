# data/ — マスターデータ規約

**この規約は全 JSON の共通言語。ID を勝手に増やしたり綴りを変えたりしないこと。**
上流資料: `../../../docs/03_文明と進化.html`（要素一覧）/ `07_ゲームシステム.html`（規則）
実装手順書: `../../../00_initila_constructions/specs/30_実装手順書.md` §5

## 書式の共通ルール

- ファイルは UTF-8 / 2 スペースインデント / キーは `snake_case` または資料由来の `kebab-case`。
- **トップレベルはオブジェクト（辞書）**。キーが ID、値が定義。配列にしない（差分レビューが困る）。
- 数値の単位は明示する: 時間は**秒**（`~Sec`）、距離は**マス**（`~Tiles`）、割合は**倍率**（`~Mul`）または **0..1**（`~Ratio`）。
- コード側で参照しない説明文は `note` に入れる。`name` は日本語の表示名。
- **数値リテラルをコードに書かない。** ここに無い数値が必要になったら、まずここへ追加する。

## civ ID（8 文明・固定）

| civId | 表示名 | ユニット ID 接頭辞 |
|---|---|---|
| `yamato` | ヤマト | `y-` |
| `roma` | ローマ | `r-` |
| `tou` | 唐 | `t-` |
| `viking` | ヴァイキング | `v-` |
| `mali` | マリ | `m-` |
| `azteca` | アステカ | `a-` |
| `persia` | ペルシア | `p-` |
| `mongol` | モンゴル | `g-` |

## age ID（4 時代・固定・この順）

`reimei`（黎明の世）→ `seido`（青銅の世）→ `tekki`（鉄器の世）→ `teikoku`（帝国の世）

## resource ID

`food` / `wood` / `stone` / `gold`

## role ID（相性判定のキー。`03§7`）

`spear` / `sword` / `ranged` / `cavalry` / `camel` / `beast` / `siege` / `gunpowder` /
`ship` / `villager` / `support` / `building`

- `camel` は騎兵の一種だが「騎兵に強い」ため別 role にする（マリの駱駝）。
- `gunpowder` は遠隔の一種だが相性が別（重装甲・獣兵に強く、騎兵に弱い）。

## line ID（兵種系統。時代進化で段が入れ替わる）

`melee` / `ranged` / `cavalry` / `beast` / `siege` / `ship` / `elite`

## unit ID（全 94 件・固定）

資料の画像ファイル名をそのまま ID にしている。**綴りを変えないこと。**

### 共通・黎明の世（4）
`villager` `clubman` `hunter` `scout`

### 支援（7）
`herald`（伝令）`trade_cart`（交易荷車）`priest`（祈祷師）
`fishing_boat`（漁船）`transport_ship`（輸送船）`warship`（軍船）`fire_ship`（火船）

### 文明別ツリー（75）

- ヤマト: `y-ashigaru` `y-musha` `y-nagae` / `y-yumiashigaru` `y-daikyu` `y-teppo` / `y-horo` `y-kiba` / `y-seiro` `y-ozutsu`
- ローマ: `r-hastati` `r-principes` `r-triarii` / `r-slinger` `r-scorpio` `r-handgun` / `r-eq-light` `r-eq` `r-eq-heavy` / `r-ram` `r-ballista` `r-onager`
- 唐: `t-hosotsu` `t-hakuto` `t-nagayari` / `t-yumite` `t-dote` `t-kaju` / `t-keiki` `t-tekki` / `t-shoshido` `t-kasensha`
- ヴァイキング: `v-raider` `v-shield` `v-axe` / `v-javelin` `v-bow` / `v-fire` `v-ram` / `v-longship` `v-greatship`
- マリ: `m-yarite` `m-menko` `m-naga` / `m-yumi` `m-daikyu` `m-hinawa` / `m-camel` `m-camel-heavy` / `m-ram` `m-catapult`
- アステカ: `a-club` `a-obsidian` `a-feather` / `a-blowgun` `a-atlatl` / `a-catapult` `a-bigcatapult`
- ペルシア: `p-immortal` `p-shield` `p-naga` / `p-bow` `p-daikyu` `p-gun` / `p-cav` `p-cataphract` / `p-elephant` `p-elephant-armored` / `p-tower` `p-cannon`
- モンゴル: `g-dismount` / `g-light` `g-archer` `g-heavy` / `g-catapult`

### 城のエリート（8）
`y-bushi`（武士）`r-legion`（レギオン）`t-renkyu`（連弩兵）`v-berserk`（ベルセルク）
`m-guard-archer`（近衛弓兵）`a-jaguar`（ジャガー戦士）`p-guard-elephant`（親衛象）
`g-guard-horsearcher`（親衛弓騎兵）

**合計 4 + 7 + 75 + 8 = 94。この件数はテストで検証する（T-M1-05）。**

## building ID

### 共通 25
黎明: `town_center` `house` `farm` `lumber_camp` `mining_camp` `watch_hut` `dock`
青銅: `barracks` `archery_range` `market` `blacksmith` `palisade` `palisade_gate` `watch_tower`
鉄器: `stable` `academy` `shrine` `siege_workshop` `stone_wall` `stone_gate` `castle` `harbor`
帝国: `gunpowder_workshop` `cannon_tower` `monument`

### 付属物 2（プレイヤーが建てない・独立して破壊可能）
`well`（井戸）`seed_store`（種籾蔵）

### 文明固有 8
`yagura`（ヤマト・見張り塔の置換）`road`（ローマ・敷設物）`kanrin`（唐・学舎の置換）
`boathouse`（ヴァイキング・港の置換）`salt_store`（マリ）`temple_platform`（アステカ）
`qanat`（ペルシア）`great_tent`（モンゴル・城の置換）

## tech ID（34）

鍛冶場 8: `uchiba` `kouba` `yajiri` `kouyajiri` `kawayoroi` `kusariyoroi` `bankinyoroi` `bayoroi`
学舎 7: `hatazao` `hayaba` `fukusho` `nijuuhata` `sokuryo` `shahon` `chouheirei`
その他 11: `ryotebono` `oonoko` `tsuruhashi` `koudou` `suki` `rinsaku` `nida` `taisho` `yakusou` `zousen` `chuuzou`
固有 8: `tanren`(ヤマト) `guntan`(ローマ) `kayakujutsu`(唐) `kyousen`(ヴァイキング) `shahou`(マリ) `menkou`(アステカ) `kangyo`(ペルシア) `ekiden`(モンゴル)

## order ID（14）

基本 6: `charge`(突撃) `siege`(包囲) `hold`(死守) `raid`(略奪) `build`(建設) `retreat`(後退)
固有 8: `jindate`(ヤマト・陣立て) `hojin`(ローマ・方陣) `kakei`(唐・火計) `jouriku`(ヴァイキング・上陸)
`koeki`(マリ・交易) `hounou`(アステカ・奉納) `assai`(ペルシア・圧壊) `yugeki`(モンゴル・遊撃)

**全件に `tier: "upper" | "lower"` が必要**（二重旗の組み合わせ判定に使う。`07§4`）。
基本の分類は固定: 上段 = `charge` `hold` `retreat` `build` / 下段 = `siege` `raid`

## map type ID（8）

`inland_sea`(内海) `plain`(平野) `river`(河川) `archipelago`(列島)
`defile`(隘路) `steppe`(草原) `jungle`(密林) `monolith_isle`(碑の島)
