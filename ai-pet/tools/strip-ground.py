#!/usr/bin/env python3
"""生成物に焼き込まれた「地面の楕円」を消す（docs/03 の C-1 / G-2 で使用）。

背景:
  プロンプトで "no cast shadow or ellipse on the ground" と指示しても、
  gpt-image-1-mini は**建物の足元に緑の地面パッチを描いてしまう**（M8でも同じ問題を踏んだ）。
  接地影は `render/shadows.ts` が描くので、アセット側に地面があると二重になり、
  さらに草地の上に緑の楕円が乗って「シールを貼った」ように見える。

  M8 では「連結領域のフラッドフィル」と「彩度での分離」で解決した。
  ここは対象が建物（茶・紫・桃・ミント）で、消したいのは**黄緑の地面**なので、
  色相で分離できる。彩度が低いグレーの石畳などは残す。

使い方:
  UV_CACHE_DIR="$PWD/.uv_cache" uv run --with pillow python tools/strip-ground.py \
    --src ai-pet/.tmp/asset-c1 --dst ai-pet/.tmp/asset-clean --map house_a=house_a ...

  `--map <ディレクトリ名>=<出力名>` で、生成物のディレクトリを出力ファイル名に対応づける
  （生成物のファイル名はタイムスタンプなので、ディレクトリ名で指定する）。
"""

from __future__ import annotations

import argparse
import colorsys
import sys
from pathlib import Path

from PIL import Image

# 消す色の色相の範囲（0..1）。
# ⚠️ 実測: 生成物の地面は rgb(221,209,104) 前後で **h≈0.147**。
# 「黄緑だから 0.16 以上」と当たりを付けたら1枚もまともに消えなかったので、
# 実際に画素を測ってから決めること（下限を 0.12 まで下げてある）。
GROUND_HUE_MIN = 0.12
GROUND_HUE_MAX = 0.42
# この彩度未満は「灰色」なので消さない（石畳・木材の陰を守る）
GROUND_SAT_MIN = 0.22
# この明度未満は影なので消さない（暗い緑は屋根の陰の可能性がある）
GROUND_VAL_MIN = 0.45


def is_ground(r: int, g: int, b: int) -> bool:
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return GROUND_HUE_MIN <= h <= GROUND_HUE_MAX and s >= GROUND_SAT_MIN and v >= GROUND_VAL_MIN


def strip(img: Image.Image) -> tuple[Image.Image, int]:
    """
    地面色の画素を透明にする。

    画像の**下半分だけ**を対象にする。上半分にある緑（ミント色の屋根など）を
    誤って消さないため。地面のパッチは必ず足元にある。
    """
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    removed = 0
    for y in range(h // 2, h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            if is_ground(r, g, b):
                px[x, y] = (0, 0, 0, 0)
                removed += 1
    return img, removed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="生成物の親ディレクトリ")
    ap.add_argument("--dst", required=True, help="出力ディレクトリ")
    ap.add_argument("--map", nargs="+", required=True, help="<生成物ディレクトリ名>=<出力名（拡張子なし）>")
    args = ap.parse_args()

    src = Path(args.src)
    dst = Path(args.dst)
    dst.mkdir(parents=True, exist_ok=True)

    out = []
    for pair in args.map:
        if "=" not in pair:
            print(f"--map の形式が違う: {pair}", file=sys.stderr)
            return 1
        dirname, outname = pair.split("=", 1)
        pngs = sorted((src / dirname).glob("*.png"))
        if not pngs:
            print(f"見つからない: {src / dirname}", file=sys.stderr)
            return 1
        # 同じディレクトリに複数あれば最新を採る
        img = Image.open(pngs[-1])
        cleaned, removed = strip(img)
        target = dst / f"{outname}.png"
        cleaned.save(target)
        out.append({"name": outname, "removed": removed, "path": str(target)})
        print(f"{outname}: 地面 {removed}px を除去 -> {target}")

    print(f"完了 {len(out)}枚")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
