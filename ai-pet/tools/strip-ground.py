#!/usr/bin/env python3
"""生成物に焼き込まれた「地面のパッチ」を消す（docs/03 の C-1 / C-4 / G-2 などで使用）。

背景:
  プロンプトで "no cast shadow or ellipse on the ground" と指示しても、
  gpt-image-1-mini は**足元に地面のパッチを描いてしまう**（M8でも同じ問題を踏んだ）。
  接地影は `render/shadows.ts` が描くので、アセット側に地面があると二重になり、
  草地の上に緑や黄色の楕円が乗って「シールを貼った」ように見える。

なぜ色だけで判定してはいけないか（実測で失敗した）:
  最初は「下半分の黄緑〜緑の画素を消す」実装にしたところ、**茂み（obj_bush）の下半分の葉が消えた**。
  地面のパッチ rgb(198,184,125) は h=0.135 / s=0.37、
  茂みの葉 rgb(134,156,64) は h=0.207 / s=0.59 で、**色相も彩度も近い**。
  対象が緑のもの（茂み・木の葉）では色だけの判定は必ず破綻する。

いまの方式（M8と同じ「連結領域のフラッドフィル」）:
  地面のパッチは**必ず絵の外周側にあり、対象の輪郭線の外にある**。
  一方、葉や壁は `--ink`（#4a3b2a）の太い輪郭線で囲まれている。
  そこで「画像の縁から塗り広げ、**濃い輪郭線に当たったら止まる**」フラッドフィルにした。
  輪郭の内側（=対象の本体）には構造的に到達できないので、葉を消してしまうことがない。

使い方:
  UV_CACHE_DIR="$PWD/.uv_cache" uv run --with pillow python tools/strip-ground.py \
    --src ai-pet/.tmp/asset-x --dst ai-pet/.tmp/asset-x-clean --map bush=obj_bush ...

  `--map <生成物のディレクトリ名>=<出力名>` で対応づける
  （生成物のファイル名はタイムスタンプなので、ディレクトリ名で指定する）。
"""

from __future__ import annotations

import argparse
import colorsys
import sys
from collections import deque
from pathlib import Path

from PIL import Image

# 輪郭線と見なす明度の上限。`--ink`(#4a3b2a) は v=0.29。
# ここに当たったらフラッドフィルを止める（＝対象の内側へ入らない）
OUTLINE_VAL_MAX = 0.42
# 「地面らしい色」の色相の範囲（0..1）。黄土〜黄緑〜緑を広くとる。
# 輪郭で守られているので広くても本体を食わない
GROUND_HUE_MIN = 0.08
GROUND_HUE_MAX = 0.45
# これ未満の彩度は灰色（石畳や木材の白っぽい面）なので消さない
GROUND_SAT_MIN = 0.12
# 完全な白に近いものは紙や雪の可能性があるので残す
GROUND_VAL_MAX = 0.97


def classify(r: int, g: int, b: int) -> str:
    """`outline`（止まる） / `ground`（消す） / `other`（通り抜けるが消さない）"""
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    if v <= OUTLINE_VAL_MAX:
        return 'outline'
    if GROUND_HUE_MIN <= h <= GROUND_HUE_MAX and s >= GROUND_SAT_MIN and v <= GROUND_VAL_MAX:
        return 'ground'
    return 'other'


def strip(img: Image.Image) -> tuple[Image.Image, int]:
    """
    画像の縁から塗り広げて、輪郭線に当たるまでの間にある「地面らしい色」を透明にする。

    透明な画素はそのまま通り抜ける（地面のパッチは透明領域に囲まれているため、
    縁から透明部分を通ってパッチへ到達できる）。
    """
    img = img.convert('RGBA')
    px = img.load()
    w, h = img.size

    seen = bytearray(w * h)
    q: deque[tuple[int, int]] = deque()

    def push(x: int, y: int) -> None:
        if 0 <= x < w and 0 <= y < h and not seen[y * w + x]:
            seen[y * w + x] = 1
            q.append((x, y))

    # 画像の4辺すべてを起点にする
    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    removed = 0
    while q:
        x, y = q.popleft()
        r, g, b, a = px[x, y]
        if a != 0:
            kind = classify(r, g, b)
            if kind == 'outline':
                # 輪郭線。ここで止める（内側の本体を守る）
                continue
            if kind == 'ground':
                px[x, y] = (0, 0, 0, 0)
                removed += 1
            # `other`（対象の一部かもしれない色）は消さないが、隣へは進む
            # （地面のパッチが薄い縁取りを持つことがあるため）
        push(x + 1, y)
        push(x - 1, y)
        push(x, y + 1)
        push(x, y - 1)

    return img, removed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='生成物の親ディレクトリ')
    ap.add_argument('--dst', required=True, help='出力ディレクトリ')
    ap.add_argument('--map', nargs='+', required=True, help='<生成物ディレクトリ名>=<出力名（拡張子なし）>')
    args = ap.parse_args()

    src = Path(args.src)
    dst = Path(args.dst)
    dst.mkdir(parents=True, exist_ok=True)

    for pair in args.map:
        if '=' not in pair:
            print(f'--map の形式が違う: {pair}', file=sys.stderr)
            return 1
        dirname, outname = pair.split('=', 1)
        pngs = sorted((src / dirname).glob('*.png'))
        if not pngs:
            print(f'見つからない: {src / dirname}', file=sys.stderr)
            return 1
        # 同じディレクトリに複数あれば最新を採る
        cleaned, removed = strip(Image.open(pngs[-1]))
        target = dst / f'{outname}.png'
        cleaned.save(target)
        print(f'{outname}: 地面 {removed}px を除去 -> {target}')

    print('完了')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
