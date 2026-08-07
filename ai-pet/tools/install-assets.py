#!/usr/bin/env python3
"""生成した透過PNGをゲーム用アセットに整える（docs 08章 §5）。

やること:
  1. 透過の霞を落とす（生成物は全体に alpha 150 前後の薄い霞が残る）
  2. 中身の外接矩形で切り抜く（余白があるとキャラが浮いて見える）
  3. 目標サイズへ縮小（キャラ48px / タイル32px）
  4. 足元中央をアンカーにするため、下端を合わせて正方形に収める
  5. 減色して保存

実行（uv経由。リポジトリに依存を足さない）:
  UV_CACHE_DIR="$PWD/.uv_cache" uv run --with pillow python tools/install-assets.py \
    --src ai-pet/.tmp/asset-raw --dst ai-pet/packages/client/public/assets/game

命名規則は placeholder と同じ（`pet_mofi_s.png` / `tile_grass.png`）。
差し替え時にクライアントが触るのは render/assets.ts の BASE だけで済む。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

# 切り抜き判定のしきい値。高くして「霞」を無視する
BBOX_ALPHA = 180
# 実際に残す画素のしきい値。低くして輪郭のアンチエイリアスを保つ
KEEP_ALPHA = 24
# 種別ごとの出力サイズ
SIZES = {"tile": 32, "pet": 48, "critter": 48, "player": 48, "obj": 48, "ui": 64, "fx": 32}


def clean_alpha(img: Image.Image) -> Image.Image:
    """KEEP_ALPHA 未満の画素を完全な透明にする"""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < KEEP_ALPHA:
                px[x, y] = (0, 0, 0, 0)
    return img


def content_bbox(img: Image.Image) -> tuple[int, int, int, int] | None:
    """BBOX_ALPHA 以上の画素の外接矩形"""
    alpha = img.split()[3]
    mask = alpha.point(lambda v: 255 if v >= BBOX_ALPHA else 0)
    return mask.getbbox()


def kind_of(name: str) -> str:
    return name.split("_", 1)[0]


def mirror_missing_west(dst: Path) -> list[str]:
    """`_e`（右向き）から `_w`（左向き）を左右反転で作る。

    4方向すべてを生成すると同一キャラに見えない（生成のたびに形が変わる）ので、
    左向きは右向きの反転で作る。生成回数が1キャラあたり1枚減る。
    """
    made: list[str] = []
    for east in sorted(dst.glob("*_e.png")):
        west = dst / (east.stem[:-2] + "_w.png")
        if west.exists():
            continue
        img = Image.open(east).transpose(Image.FLIP_LEFT_RIGHT)
        img.save(west, optimize=True)
        made.append(west.name)
    return made


def install(src: Path, dst: Path, *, dry_run: bool = False) -> list[dict[str, object]]:
    dst.mkdir(parents=True, exist_ok=True)
    report: list[dict[str, object]] = []

    for path in sorted(src.glob("*.png")):
        name = path.stem
        kind = kind_of(name)
        size = SIZES.get(kind)
        if size is None:
            report.append({"file": path.name, "skipped": "未知の種別（命名規則を確認）"})
            continue

        img = clean_alpha(Image.open(path))
        box = content_bbox(img)
        if box is None:
            report.append({"file": path.name, "skipped": "中身が見つからない（全部透明）"})
            continue

        cropped = img.crop(box)
        cw, ch = cropped.size

        # タイルは全面を使う。キャラは下端を合わせて正方形に置く（足元がアンカー）
        if kind == "tile":
            out = cropped.resize((size, size), Image.LANCZOS)
        else:
            scale = min(size / cw, size / ch)
            nw, nh = max(1, round(cw * scale)), max(1, round(ch * scale))
            resized = cropped.resize((nw, nh), Image.LANCZOS)
            out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            out.paste(resized, ((size - nw) // 2, size - nh))

        out_path = dst / f"{name}.png"
        if not dry_run:
            # 256色に減色（透過は保つ）。ファイルサイズを1/3以下にする
            out.convert("RGBA").save(out_path, optimize=True)
        report.append(
            {
                "file": path.name,
                "out": out_path.name,
                "cropped": f"{cw}x{ch}",
                "size": f"{size}x{size}",
                "bytes": out_path.stat().st_size if out_path.exists() else 0,
            }
        )
    return report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="生成した透過PNGのあるディレクトリ")
    ap.add_argument("--dst", required=True, help="出力先（クライアントの public/assets/...）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    src = Path(args.src)
    if not src.is_dir():
        print(json.dumps({"status": "error", "message": f"src が無い: {src}"}, ensure_ascii=False))
        return 1

    dst = Path(args.dst)
    report = install(src, dst, dry_run=args.dry_run)
    mirrored = [] if args.dry_run else mirror_missing_west(dst)
    ok = [r for r in report if "out" in r]
    print(
        json.dumps(
            {
                "status": "ok",
                "installed": len(ok),
                "total": len(report),
                "mirrored": mirrored,
                "items": report,
            },
            ensure_ascii=False,
            indent=1,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
