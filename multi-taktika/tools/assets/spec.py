"""
spec.py — マスターデータからアセットの「作るものリスト」とプロンプトを組み立てる

■ なぜコードでプロンプトを組むのか
`units.json` は 94 件、`buildings.json` は 35 件ある。1 件ずつ手でプロンプトを書くと
文明ごとの絵柄が揺れ、後からユニットが増えたときに追随できない。
**文明・時代・役割の 3 つから機械的に文章を組む**ことで、絵柄の一貫性を担保する。

■ 出力の約束（描画側との契約）
`units.json` の `sprite` フィールド（例 `units/villager.webp`）が引き当てキー。
このスクリプトはそのパスに置く。**キーを決めるのはデータ側**で、ここではない。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

GAME = Path(__file__).resolve().parents[2] / "game"
DATA = GAME / "src" / "data"

# --------------------------------------------------------------- 絵柄の統一

#: すべてのプロンプトの末尾に付ける共通指示。
#: 「透過」「影なし」「地面なし」を毎回書かないと背景や地面が付いてきて、
#: 盤面に置いたとき四角い板が浮いて見える。
COMMON = (
    "Hand-painted semi-realistic 2D real-time-strategy game art, "
    "viewed from above at a 45 degree isometric angle, facing lower-right. "
    "Fully transparent background. No ground, no terrain, no cast shadow, "
    "no background scenery, no text, no label, no border, no frame, no watermark. "
    "Single subject, centered, complete and not cropped, clean readable silhouette."
)

#: 文明 → 見た目の手がかり。`civs.json` の id をキーにする。
CIV_STYLE: dict[str, str] = {
    "yamato": "ancient and medieval Japanese (Yamato) style: lacquered lamellar armor, "
    "straw and cedar, indigo and vermilion cloth, curved sword",
    "roma": "ancient Roman style: segmented iron lorica, red tunic, rectangular scutum shield, "
    "crested helmet, marble and terracotta",
    "tou": "Tang Chinese style: scale armor with shoulder guards, silk sashes in crimson and jade, "
    "glazed tile roofs, halberd",
    "viking": "Norse Viking style: mail hauberk, round wooden shield, fur cloak, "
    "carved wood with dragon-head motifs, axe",
    "mali": "West African Mali Empire style: flowing indigo and saffron boubou robes, "
    "quilted cotton armor, adobe and timber, gold ornament",
    "azteca": "Mesoamerican Aztec style: quilted cotton armor, feathered headdress, "
    "obsidian-edged weapons, turquoise and jaguar motifs, carved stone",
    "persia": "Persian style: layered scale armor, turquoise and gold brocade, "
    "conical helmet, glazed blue tilework, recurve bow",
    "mongol": "Mongol steppe style: layered leather and lamellar armor, fur-lined cap, "
    "earth tones with crimson trim, composite bow",
}

#: 共通兵（`civ: null`）はどの文明でもない素朴な見た目にする。
NEUTRAL_STYLE = (
    "generic early-antiquity style shared by all nations: undyed hemp and leather, "
    "simple wooden and stone tools, no heraldry"
)

#: 時代 → 装備の重さ。同じ役割でも時代が上がると豪華になるのが分かるようにする。
AGE_STYLE: dict[str, str] = {
    "reimei": "primitive: little or no metal armor, wood and stone equipment",
    "seido": "bronze age: bronze helmet and bronze-tipped weapon, light armor",
    "tekki": "iron age: full iron armor, well-forged steel weapon",
    "teikoku": "imperial peak: ornate heavy armor with gilding and a banner or plume",
}

#: 役割 → 姿勢と持ち物。`units.json` の `role`。
ROLE_STYLE: dict[str, str] = {
    "villager": "a civilian laborer holding a hand tool, no armor",
    "spear": "an infantry soldier holding a long spear upright with both hands",
    "sword": "an infantry soldier with a one-handed blade and a shield",
    "ranged": "an archer drawing a bow, quiver on the back",
    "cavalry": "a mounted warrior on a horse, seen from the side-front",
    "camel": "a warrior mounted on a camel",
    "beast": "a warrior riding a large war elephant with a howdah",
    "siege": "a wheeled wooden siege engine, no crew visible",
    "gunpowder": "a soldier shouldering an early matchlock firearm, powder flask at the belt",
    "ship": "a wooden sailing warship seen from above at an angle, hull and sail visible",
    "support": "a lightly equipped non-combatant figure",
    "building": "a fortified structure",
}

#: 建物の種別 → 姿の手がかり（`buildings.json` の id から引く。無ければ名前から推測させる）。
BUILDING_HINT: dict[str, str] = {
    "town_center": "a large central hall with a wide roof and a low surrounding fence",
    "house": "a small dwelling",
    "farm": "a tilled field plot with crop rows and a low border",
    "lumber_camp": "an open-sided woodcutter's shed with stacked logs and a saw",
    "mining_camp": "a mining shed with ore piles, pickaxes and a support frame",
    "watch_hut": "a small raised lookout hut on posts with a ladder",
    "market": "an open market stall with awnings, crates and hanging goods",
    "barracks": "a military drill hall with a weapon rack outside",
    "archery_range": "an archery training yard with straw targets and a bow rack",
    "stable": "a stable with a fenced paddock and a hay pile",
    "blacksmith": "a smithy with a forge, chimney smoke and an anvil",
    "wall": "a straight segment of defensive wall",
    "gate": "a fortified gatehouse with closed double doors",
    "tower": "a tall slender defensive tower with arrow slits",
    "castle": "a massive fortified keep with battlements and corner turrets",
    "workshop": "a siege workshop with timber frames, wheels and rope",
    "dock": "a wooden dock with a pier and boat-building frame",
    "well": "a stone well with a bucket and a simple roof",
    "granary": "a raised granary on stilts",
}


@dataclass(frozen=True)
class Job:
    """生成 1 件。`key` は出力パス（`public/assets/` 以下）を決める。"""

    key: str  # 例 "units/villager"
    prompt: str
    #: 出力する短辺の px（後処理で縮小する先）。
    out_px: int
    #: 生成に使うサイズ。縦長のものだけ 1024x1536 にする。
    gen_size: str = "1024x1024"
    #: 背景。地形の模様だけは**不透過**（隙間が空くと盤面に穴が見える）。
    background: str = "transparent"


def _load(name: str) -> dict:
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def _keys(d: dict) -> list[str]:
    """`_meta` を除いた ID の一覧。**JSON の記載順**を保つ（並びが変わると差分が読めない）。"""
    return [k for k in d if not k.startswith("_")]


def _civ_clause(civ: str | None) -> str:
    if civ is None:
        return NEUTRAL_STYLE
    style = CIV_STYLE.get(civ)
    if style is None:
        raise KeyError(f"spec.py に文明 {civ!r} の絵柄が無い（civs.json に足したら CIV_STYLE も足す）")
    return style


def _sprite_key(sprite: str | None, fallback: str) -> str:
    """`units.json` の `sprite`（"units/villager.webp"）→ 拡張子を落としたキー。"""
    if sprite is None:
        return fallback
    return sprite.rsplit(".", 1)[0]


# --------------------------------------------------------------- 作るものリスト


def unit_jobs() -> list[Job]:
    units = _load("units.json")
    jobs: list[Job] = []
    for uid in _keys(units):
        u = units[uid]
        role = ROLE_STYLE.get(u["role"])
        if role is None:
            raise KeyError(f"spec.py に役割 {u['role']!r} の絵柄が無い")
        age = AGE_STYLE.get(u["age"])
        if age is None:
            raise KeyError(f"spec.py に時代 {u['age']!r} の絵柄が無い")
        # 名前（日本語）はそのまま渡さず、役割・時代・文明の英語だけで組む。
        # 日本語を混ぜるとモデルが文字を絵に描き込むことがある。
        prompt = (
            f"Game sprite of {role}. "
            f"Nation and material culture: {_civ_clause(u['civ'])}. "
            f"Equipment level: {age}. "
            f"{COMMON}"
        )
        jobs.append(
            Job(
                key=_sprite_key(u.get("sprite"), f"units/{uid}"),
                prompt=prompt,
                out_px=128,
            )
        )
    return jobs


def building_jobs() -> list[Job]:
    """
    建物は**文明別に作らない**（35 × 8 = 280 枚になる）。
    1 棟 1 枚を「その建物らしい姿」で作り、陣営色は描画側の色付けで表す。
    時代ごとの差し替えも同じ理由で 1 枚に集約する（`ISSUES.md` に記録）。
    """
    buildings = _load("buildings.json")
    jobs: list[Job] = []
    for bid in _keys(buildings):
        b = buildings[bid]
        hint = BUILDING_HINT.get(bid)
        if hint is None:
            # 未登録は id から機械的に組む（`_` を空白に）。増えても止まらないようにする。
            hint = f"a {bid.replace('_', ' ')} structure"
        age = AGE_STYLE.get(b["age"], AGE_STYLE["reimei"])
        w, h = b["sizeTiles"]
        big = max(w, h)
        jobs.append(
            Job(
                key=f"buildings/{bid}",
                prompt=(
                    f"Game sprite of {hint}, an isometric building tile occupying "
                    f"{w} by {h} ground tiles. Construction level: {age}. "
                    f"Neutral undyed materials so a faction color can be tinted on later. "
                    f"{COMMON}"
                ),
                out_px=64 * big if big <= 4 else 256,
            )
        )
    return jobs


def emblem_jobs() -> list[Job]:
    """文明の紋章。試合設定・HUD・結果画面で使う小さなアイコン。"""
    civs = _load("civs.json")
    jobs: list[Job] = []
    for cid in _keys(civs):
        jobs.append(
            Job(
                key=f"ui/emblem_{cid}",
                prompt=(
                    "Flat vector heraldic emblem icon inside a simple circular ring, "
                    f"drawn in the visual language of {_civ_clause(cid)}. "
                    "Bold shapes, high contrast, still readable at 24 pixels. "
                    "Fully transparent background. No text, no letters, no drop shadow, no frame."
                ),
                out_px=96,
            )
        )
    return jobs


def order_jobs() -> list[Job]:
    """
    令カードのアイコン 14 種。`orders.json` の id から引く。
    **文字を描かせない**（カードの文字は HTML 側で出す。画像に焼くと差し替えが効かない）。
    """
    orders = _load("orders.json")
    hints: dict[str, str] = {
        "charge": "a spear pointing forward with motion lines, aggressive advance",
        "siege": "a battering ram facing a closed gate",
        "hold": "a large shield planted in the ground, unmoving defense",
        "raid": "a torch and a sack of loot",
        "build": "a hammer and a wooden palisade stake",
        "retreat": "a curved arrow turning back behind a shield",
        "jindate": "a field camp with a banner pole and stacked shields",
        "hojin": "several shields locked into a tight square formation seen from above",
        "kakei": "an arrow with a widening cone of fire lines",
        "jouriku": "a boat prow touching a shore with a lowered ramp",
        "koeki": "a pair of scales with coins and a bundle of goods",
        "hounou": "an offering bowl with rising smoke before a small altar",
        "assai": "a heavy stone weight crushing a broken wall block",
        "yugeki": "two crossed light sabers with dashed movement arrows around them",
    }
    jobs: list[Job] = []
    for oid in _keys(orders):
        hint = hints.get(oid, f"a symbol for {oid}")
        jobs.append(
            Job(
                key=f"ui/order_{oid}",
                prompt=(
                    f"Flat two-tone game UI icon: {hint}. "
                    "Simple bold silhouette, one accent color, readable at 32 pixels. "
                    "Fully transparent background. No text, no letters, no numbers, "
                    "no drop shadow, no frame, no border."
                ),
                out_px=96,
            )
        )
    return jobs


def portrait_jobs() -> list[Job]:
    """
    総大将の立ち絵 8 枚（文明ごと 1 人）。エリート兵は `units.json` 側の
    tier 3 ユニットがそのまま該当するので別に作らない。
    """
    civs = _load("civs.json")
    jobs: list[Job] = []
    for cid in _keys(civs):
        jobs.append(
            Job(
                key=f"ui/commander_{cid}",
                prompt=(
                    "Waist-up character portrait of a veteran supreme commander, "
                    f"in the style of {_civ_clause(cid)}. Calm authoritative expression, "
                    "ornate armor of the highest rank, looking slightly to the side. "
                    "Painterly 2D illustration. Fully transparent background. "
                    "No ground, no background scenery, no text, no frame, no watermark."
                ),
                out_px=384,
                gen_size="1024x1536",
            )
        )
    return jobs


#: 地形タイル 8 種（`shared/types.ts` の `Tile` と `palette.TILE_COLORS` の並び）。
#: **1 枚 1 タイルの絵ではなく、継ぎ目のない小さな模様**にする。
#: 理由: 盤面は 200×200 マス（4 万枚）あるので、1 マス 1 枚の `drawImage` は
#: キャッシュを焼くときでも重い。`createPattern` で塗れば
#: 「1 タイル種別につき 1 回の塗り」で済み、今の描画の速さ（0.0ms）を保てる。
TERRAIN: list[tuple[str, str]] = [
    ("grass", "short green meadow grass with a few tiny wildflowers"),
    ("forest", "dark forest floor: moss, fallen needles and small ferns"),
    ("hill", "dry grassy hillside soil with scattered small stones"),
    ("water", "deep calm water with gentle dark blue ripples"),
    ("shallow", "shallow clear water over pale sand with faint ripples"),
    ("road", "packed dirt road with wheel ruts and fine gravel"),
    ("rubble", "broken rubble: shattered stone, splinters and ash"),
    ("cliff", "bare grey rock face with cracks"),
]


def terrain_jobs() -> list[Job]:
    jobs: list[Job] = []
    for tid, hint in TERRAIN:
        jobs.append(
            Job(
                key=f"terrain/{tid}",
                prompt=(
                    f"Seamless tileable texture swatch of {hint}, top-down view, "
                    "flat even lighting with no directional shadow, no vignette, "
                    "uniform across the whole square so the edges tile without a visible seam. "
                    "Painterly but low contrast so game pieces stay readable on top of it. "
                    "Opaque, fills the entire square. "
                    "No objects, no creatures, no text, no border, no frame, no watermark."
                ),
                out_px=128,
                background="opaque",
            )
        )
    return jobs


# --------------------------------------------------------------- 画面の絵
#
#: タイトル画面と紙の地。**盤面のコマではなく「額縁」**を作るカテゴリ。
#:
#: ■ タイトルの空を画像にしない理由
#: タイトル画面は `05§2` の演出として **時刻とともに空の色が変わる**
#: （`Title.ts` の `skyPalette(hour)`。`02_世界観.html` の環海の世界観から来ている）。
#: 空を含んだ 1 枚絵を敷くとこの仕掛けが死ぬので、
#: **島と碑だけを透過 PNG で作り、空と海は CSS のまま**にして上に重ねる。
#: `Title.ts` の冒頭に「`.mt-title-bg` に画像を重ねればよい（差し替え口）」と
#: 書いてあるのがこの想定。
#:
#: ■ 羊皮紙を継ぎ目なしにする理由
#: パネルの大きさは画面幅で変わる（`05` の可変レイアウト）ので、
#: 1 枚絵を伸ばすと縦横比が崩れる。`repeat` で敷けるように継ぎ目なしで作る。
SCENES: list[tuple[str, str, int, str, str]] = [
    (
        "ui/title_island",
        # 碑（`02`）= 中央の島に立つ石柱。八文明がその周りの海を囲んでいる。
        "A single small island seen from across calm water, in the centre a tall weathered "
        "stone stele covered in faint carved script, its top broken. Low scrubby trees and "
        "pale rocks on the island, a thin strip of shore at the waterline. "
        "Painted like an old illustrated chronicle: muted earth colours, soft edges, "
        "no harsh outlines. Side view at eye level from a distance, the island small in frame. "
        "Cut out on a fully transparent background: no sky, no sea, no water, no horizon line, "
        "only the island and the stele. No text, no frame, no border, no watermark.",
        1024,
        "1536x1024",
        "transparent",
    ),
    (
        "ui/map_ringsea",
        # `05` の「羊皮紙の環海図に、章のメダルが時代順に並びます」で使う地図。
        # 文面は `02_世界観.html` の図の alt をそのまま英訳した:
        # 「羊皮紙に描かれた世界地図。中央に大きな内海があり、その中心の小島に黒い石柱が立つ。
        #   海のまわりを稲田・運河都市・密林の神殿・砂漠のオアシス・草原の天幕などが囲む」
        #
        # **文字を入れない。** 地名は UI 側（DOM）で出す。絵に焼き込むと
        # 日本語・英語の切り替えができず、生成モデルの綴り間違いも直せない。
        "An antique world map drawn on aged parchment. In the centre a large inland sea, "
        "and at its centre a tiny island with a single black stone pillar standing on it. "
        "Around the sea, drawn as small map illustrations: terraced rice paddies, a canal city, "
        "a jungle temple pyramid, a desert oasis, steppe tents, a rocky northern coast with "
        "longships, a salt road with camels, and stone aqueducts. "
        "Hand-inked cartography style: brown sepia ink, fine hatching for hills, "
        "stylised waves in the sea, a simple compass rose. Muted and low contrast. "
        "Flat top-down map view, no perspective, no border frame. "
        "Absolutely no text, no letters, no labels, no numbers, no watermark.",
        1280,
        "1536x1024",
        "opaque",
    ),
    (
        "ui/parchment",
        "Seamless tileable parchment texture: aged pale vellum with faint fibres, "
        "very slight mottling and a barely visible warm stain, no folds, no creases, "
        "no torn edges, no border, no vignette. Flat even lighting, uniform across the whole "
        "square so the edges tile without a visible seam. Very low contrast so dark text "
        "stays readable on top. Opaque, fills the entire square. "
        "No objects, no text, no writing, no drawing, no watermark.",
        256,
        "1024x1024",
        "opaque",
    ),
]


def scene_jobs() -> list[Job]:
    return [
        Job(key=key, prompt=prompt, out_px=out_px, gen_size=gen_size, background=bg)
        for key, prompt, out_px, gen_size, bg in SCENES
    ]


# --------------------------------------------------------------- 資源ノード
#
#: 盤面に置かれる資源（`resources.json` の `gatherFrom` に出てくるノード）。
#: **キーは `resources/<ノード id>`**（`render/atlas.ts` の `resourceKeyOf` と対応）。
#:
#: ■ なぜ後から足したのか
#: 描画側（`AtlasSpriteProvider.drawResource`）は最初からこのキーを探す作りだったが、
#: 絵が無かったので**ひし形の色付き図形**が出ていた（実機で確認）。
#: 森・果樹・羊が全部ひし形なので、盤面を見て何があるのか分からない状態だった。
#: 資源は盤面でいちばん数が多い要素なので、ここが図形だと絵が入った建物や兵が浮く。
#:
#: ■ 大きさ
#: 1 マス = 村人 1 体の幅（`07§1`）で、`drawResource` は当たり半径の 2.4 倍で描く。
#: 森は数マスぶんの塊なので少し大きめ、果樹・羊は 1 マス弱。
RESOURCE_NODES: list[tuple[str, str, int]] = [
    ("forest", "a cluster of three broadleaf trees with dense green canopy and visible trunks", 160),
    ("fruit", "a low bush heavy with small red berries, a few ripe clusters visible", 96),
    ("sheep", "a single standing sheep with thick cream wool, seen from the side", 96),
    ("hunt", "a single wild deer standing alert, brown coat and small antlers", 112),
    ("fish", "a shoal of silver fish just under the water surface with faint ripples", 96),
    ("farm", "a small tilled field plot with young green crop rows in neat furrows", 128),
    (
        "stone_quarry",
        "an outcrop of grey stone blocks, partly quarried with chisel marks and loose rubble",
        128,
    ),
    (
        "gold_mine",
        "an outcrop of dark rock veined with glinting gold ore, a few loose nuggets at its base",
        128,
    ),
]


def resource_jobs() -> list[Job]:
    jobs: list[Job] = []
    for nid, hint, out_px in RESOURCE_NODES:
        jobs.append(
            Job(
                key=f"resources/{nid}",
                prompt=f"Game sprite of {hint}. {COMMON}",
                out_px=out_px,
            )
        )
    return jobs


#: カテゴリ名 → 作るものリストを返す関数。CLI の `--only` で選ぶ。
CATEGORIES = {
    "terrain": terrain_jobs,
    "units": unit_jobs,
    "buildings": building_jobs,
    "emblems": emblem_jobs,
    "orders": order_jobs,
    "portraits": portrait_jobs,
    "scenes": scene_jobs,
    "resources": resource_jobs,
}


def all_jobs(only: list[str] | None = None) -> list[Job]:
    names = only or list(CATEGORIES)
    jobs: list[Job] = []
    for n in names:
        fn = CATEGORIES.get(n)
        if fn is None:
            raise KeyError(f"未知のカテゴリ {n!r}（{', '.join(CATEGORIES)} のいずれか）")
        jobs.extend(fn())
    # キーの重複はアセットの取り違えになるので即エラー。
    seen: set[str] = set()
    for j in jobs:
        if j.key in seen:
            raise ValueError(f"キーが重複している: {j.key}")
        seen.add(j.key)
    return jobs


if __name__ == "__main__":
    for name, fn in CATEGORIES.items():
        print(f"{name}: {len(fn())} 件")
