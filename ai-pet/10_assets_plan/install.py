"""生成した透過PNGを public/assets/pets/ へ整えて配置する。

生成画像には次の2つの癖があるため、そのまま置くと見た目が崩れる。
  1. 画像全体にごく薄い（alpha 150 前後まで）霞のような画素が残る
     → 単純に切り抜くと余白が残り、キャラクターが地面から浮いて見える
  2. 1024x1024 のままだと 1 体 700KB 近くあり、Web では重すぎる

そこで「切り抜き範囲は高い閾値で判定し、実際の画素は低い閾値で残す」ことで、
輪郭のアンチエイリアスを保ちながら正しい大きさに整える。

    使い方: uv run --with pillow python 10_assets_plan/install.py
"""

import glob
import os

from PIL import Image

SRC_DIR = ".tmp/assets"
PET_DIR = "public/assets/pets"
ITEM_DIR = "public/assets/items"
# 切り抜き範囲の判定に使う閾値（これ未満は「霞」とみなす）
BBOX_THRESHOLD = 160
# 実際に残す画素の閾値（輪郭のアンチエイリアスを保つため低め）
KEEP_THRESHOLD = 24
# 表示は高さ 200px 程度なので、Retina 2倍を見て 448px で足りる
MAX_HEIGHT = 448


def main() -> None:
    os.makedirs(PET_DIR, exist_ok=True)
    os.makedirs(ITEM_DIR, exist_ok=True)
    total = 0
    count = 0
    for path in sorted(glob.glob(os.path.join(SRC_DIR, "*.png"))):
        name = os.path.basename(path)
        if name.startswith("_"):
            continue
        # 家具・アイテムは items/、それ以外（ペット・たまご）は pets/ へ。
        dst_dir = ITEM_DIR if name.startswith(("furn_", "food_", "toy_", "care_")) else PET_DIR
        image = Image.open(path).convert("RGBA")
        alpha = image.getchannel("A")

        # 切り抜き範囲は高い閾値で決める
        solid = image.copy()
        solid.putalpha(alpha.point(lambda v: 0 if v < BBOX_THRESHOLD else v))
        bbox = solid.getbbox()

        # 実際の画素は低い閾値（霞だけ消す）
        image.putalpha(alpha.point(lambda v: 0 if v < KEEP_THRESHOLD else v))
        if bbox:
            image = image.crop(bbox)
        if image.height > MAX_HEIGHT:
            width = round(image.width * MAX_HEIGHT / image.height)
            image = image.resize((width, MAX_HEIGHT), Image.LANCZOS)

        out = os.path.join(dst_dir, name)
        image.save(out, optimize=True)
        total += os.path.getsize(out)
        count += 1
    print(f"installed {count} files, {total // 1024} KB")


if __name__ == "__main__":
    main()
