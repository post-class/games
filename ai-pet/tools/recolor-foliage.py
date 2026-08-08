#!/usr/bin/env python3
"""木の葉の色だけを差し替える（docs/03 の F-4 で使用）。

なぜ生成し直さないのか:
  苗木（`obj_berry_tree_young`）の秋・冬版を img-gen-gpt で作ろうとしたら、
  「小さな苗木を1本」と書いても**大木と苗木の2本**が描かれ、切り出すと退色して使えなかった。
  苗木は輪郭が単純なので、**基本の絵の葉だけを色替え**したほうが
  形が基本と完全に一致して並べたときに破綻しない（生成のばらつきも入らない）。

やること:
  葉と判定した画素だけ色相・彩度・明度を置き換える。
  葉の判定は「色相が黄緑〜緑（0.15..0.45）」「彩度 > 0.15」「明度 > 0.35」。
  幹の茶色（色相 < 0.12）と `--ink`(#4a3b2a) の輪郭線は条件から外れるので触らない。

使い方:
  UV_CACHE_DIR="$PWD/.uv_cache" uv run --with pillow python ai-pet/tools/recolor-foliage.py \
    --src ai-pet/packages/client/public/assets/game/obj_berry_tree_young.png \
    --out ai-pet/packages/client/public/assets/game/obj_berry_tree_young_autumn.png \
    --hue 0.068 --sat 1.55 --val 1.06

  採用値:
    秋 --hue 0.068 --sat 1.55 --val 1.06   （橙。彩度を上げないと茶色に見える）
    冬 --hue 0.11  --sat 0.16 --val 1.14   （雪。彩度をほぼ抜いて明るくする）
"""

from __future__ import annotations

import argparse
import colorsys
from pathlib import Path

from PIL import Image

# 葉と見なす条件（HSV）
LEAF_HUE_MIN = 0.15
LEAF_HUE_MAX = 0.45
LEAF_SAT_MIN = 0.15
LEAF_VAL_MIN = 0.35


def recolor(src: Path, out: Path, hue: float, sat: float, val: float) -> int:
    img = Image.open(src).convert('RGBA')
    w, h = img.size
    dst = Image.new('RGBA', (w, h))
    changed = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = img.getpixel((x, y))
            if a == 0:
                dst.putpixel((x, y), (r, g, b, a))
                continue
            hh, ss, vv = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if LEAF_HUE_MIN <= hh <= LEAF_HUE_MAX and ss > LEAF_SAT_MIN and vv > LEAF_VAL_MIN:
                nr, ng, nb = colorsys.hsv_to_rgb(hue, min(1.0, ss * sat), min(1.0, vv * val))
                dst.putpixel((x, y), (int(nr * 255), int(ng * 255), int(nb * 255), a))
                changed += 1
            else:
                dst.putpixel((x, y), (r, g, b, a))
    out.parent.mkdir(parents=True, exist_ok=True)
    dst.save(out)
    return changed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--hue', type=float, required=True, help='置き換え後の色相（0..1）')
    ap.add_argument('--sat', type=float, default=1.0, help='彩度の倍率')
    ap.add_argument('--val', type=float, default=1.0, help='明度の倍率')
    a = ap.parse_args()
    n = recolor(Path(a.src), Path(a.out), a.hue, a.sat, a.val)
    print(f'{a.out}: 葉 {n}px を置き換え')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
