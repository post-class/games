#!/usr/bin/env python3
"""
build.py — アセットの生成・後処理・アトラス化（T-M17-01）

■ 使い方
    # 何が作られるかだけ見る（API を叩かない）
    python tools/assets/build.py plan
    # 生成（足りないものだけ。途中で止めても再開できる）
    python tools/assets/build.py gen --only units --parallel 10
    # 生成済み PNG を透過整形して public/assets/ に置く（API を叩かない）
    python tools/assets/build.py post
    # アトラスと manifest を作る
    python tools/assets/build.py pack

■ 再開できる理由
生成物は `tools/assets/raw/<key>.png` に**キー名で**保存する。
`gen` は既にあるファイルを飛ばすので、何度実行しても足りないぶんだけ作る。
（スキルのスクリプトはタイムスタンプ名で出すため、1 件ごとに一時ディレクトリを
 分けて受け取り、こちらでキー名に付け替える。並列時の取り違えを防ぐため。）

■ 透過の後処理がなぜ必要か
生成 PNG は画像全体に alpha 150 程度までの薄い霞が残る。
そのまま bbox で切り抜くと余白が付いてキャラクターが浮いて見えるので、
**切り抜き判定は高い閾値・実際に残す画素は低い閾値**にする。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from spec import GAME, Job, all_jobs  # noqa: E402

TOOLS = Path(__file__).resolve().parent
RAW = TOOLS / "raw"
OUT = GAME / "public" / "assets"

SKILL = Path.home() / ".claude" / "skills" / "img-gen-gpt" / "scripts" / "generate_image.py"
#: US 資格情報を持つ .env。リポジトリ直下の .env には US のキーが無い。
ENV_FILE = Path.home() / "projects" / "private" / "english-learn" / ".env"

#: 切り抜き位置を決めるときの閾値。これ未満は「霞」として無視する。
TRIM_ALPHA = 96
#: 実際に残す画素の閾値。低くすることで輪郭のアンチエイリアスが保たれる。
KEEP_ALPHA = 16


# --------------------------------------------------------------- 生成


def _raw_path(key: str) -> Path:
    return RAW / f"{key}.png"


def generate_one(job: Job, model: str, quality: str) -> tuple[str, str]:
    """1 件生成して `raw/<key>.png` に置く。戻り値は (key, 状態)。"""
    dest = _raw_path(job.key)
    if dest.exists() and dest.stat().st_size > 0:
        return job.key, "skip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    # 並列実行するとスキル側の出力名（タイムスタンプ）が衝突するので 1 件ごとに隔離する。
    with tempfile.TemporaryDirectory(prefix="mtasset-") as tmp:
        cmd = [
            "uv", "run",
            "--with", "httpx", "--with", "python-dotenv", "--with", "pyyaml", "--with", "openai",
            "python", str(SKILL),
            "--operation", "generate",
            "--env-file", str(ENV_FILE),
            "--model", model,
            "--quality", quality,
            "--size", job.gen_size,
            "--background", job.background,
            "--output-format", "png",
            "--output-dir", tmp,
            "--prompt", job.prompt,
        ]
        env = dict(os.environ)
        env["PATH"] = "/opt/homebrew/bin:" + env.get("PATH", "")
        env["UV_CACHE_DIR"] = str(TOOLS / ".uv_cache")
        r = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if r.returncode != 0:
            return job.key, f"error: {r.stdout.strip()[-200:] or r.stderr.strip()[-200:]}"
        made = sorted(Path(tmp).glob("*.png"))
        if not made:
            return job.key, f"error: 画像が返ってこなかった {r.stdout.strip()[-200:]}"
        shutil.copyfile(made[0], dest)
    return job.key, "ok"


def cmd_gen(args: argparse.Namespace) -> int:
    jobs = all_jobs(args.only)
    todo = [j for j in jobs if not _raw_path(j.key).exists()]
    print(f"対象 {len(jobs)} 件 / 未生成 {len(todo)} 件 / 並列 {args.parallel}", flush=True)
    if not todo:
        return 0
    failed: list[tuple[str, str]] = []
    done = 0
    with ThreadPoolExecutor(max_workers=args.parallel) as ex:
        futs = [ex.submit(generate_one, j, args.model, args.quality) for j in todo]
        for f in futs:
            key, status = f.result()
            done += 1
            if status.startswith("error"):
                failed.append((key, status))
                print(f"[{done}/{len(todo)}] NG {key}: {status}", flush=True)
            else:
                print(f"[{done}/{len(todo)}] {status} {key}", flush=True)
    if failed:
        print(f"\n失敗 {len(failed)} 件（もう一度 gen を実行すれば足りないぶんだけ再試行する）")
        for k, s in failed:
            print(f"  {k}: {s}")
    return 1 if failed else 0


# --------------------------------------------------------------- 後処理


def cmd_post(args: argparse.Namespace) -> int:
    from PIL import Image  # 遅延 import（plan/gen だけなら Pillow は不要）

    jobs = all_jobs(args.only)
    made = 0
    missing: list[str] = []
    for job in jobs:
        src = _raw_path(job.key)
        if not src.exists():
            missing.append(job.key)
            continue
        dst = OUT / f"{job.key}.webp"
        if dst.exists() and not args.force and dst.stat().st_mtime >= src.stat().st_mtime:
            continue
        img = Image.open(src).convert("RGBA")
        a = img.getchannel("A")
        # 1) 切り抜き位置は高い閾値で決める（霞を無視する）
        box = a.point(lambda v: 255 if v >= TRIM_ALPHA else 0).getbbox()
        if box is None:
            missing.append(f"{job.key}(空画像)")
            continue
        img = img.crop(box)
        # 2) 残す画素は低い閾値（輪郭のアンチエイリアスを保つ）。霞だけ消す。
        a2 = img.getchannel("A").point(lambda v: 0 if v < KEEP_ALPHA else v)
        img.putalpha(a2)
        # 3) 長辺を out_px に合わせて縮小（拡大はしない）
        w, h = img.size
        long_side = max(w, h)
        if long_side > job.out_px:
            scale = job.out_px / long_side
            img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        dst.parent.mkdir(parents=True, exist_ok=True)
        img.save(dst, "WEBP", quality=92, method=6)
        made += 1
    print(f"整形 {made} 件 → {OUT}")
    if missing:
        print(f"未生成 {len(missing)} 件: {', '.join(missing[:12])}{' …' if len(missing) > 12 else ''}")
    return 0


# --------------------------------------------------------------- アトラス


def cmd_pack(args: argparse.Namespace) -> int:
    """
    棚詰め（shelf packing）で 1 枚のアトラスにまとめ、manifest を書く。

    アトラスにする理由は**描画呼び出しの回数ではなく読み込みの回数**。
    159 枚を個別に fetch すると初回表示が遅い。1 枚なら 1 回で済む。
    """
    from PIL import Image

    # 地形は**アトラスに入れない**。`createPattern` で繰り返し塗るには
    # 1 枚の独立した画像でなければならない（アトラスの一部を繰り返せない）。
    jobs = [j for j in all_jobs(args.only) if not j.key.startswith("terrain/")]
    items: list[tuple[str, Image.Image]] = []
    for job in jobs:
        p = OUT / f"{job.key}.webp"
        if not p.exists():
            continue
        items.append((job.key, Image.open(p).convert("RGBA")))
    if not items:
        print("整形済みアセットが 1 件も無い。先に post を実行する。")
        return 1
    # 高いものから詰めると隙間が減る。並びは「高さ降順 → キー昇順」で**決定的**にする。
    items.sort(key=lambda t: (-t[1].height, t[0]))
    pad = 2
    width = args.width
    x = y = row_h = 0
    frames: dict[str, dict[str, int]] = {}
    for key, im in items:
        if x + im.width + pad > width:
            x = 0
            y += row_h + pad
            row_h = 0
        frames[key] = {"x": x, "y": y, "w": im.width, "h": im.height}
        x += im.width + pad
        row_h = max(row_h, im.height)
    height = y + row_h
    atlas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for key, im in items:
        f = frames[key]
        atlas.paste(im, (f["x"], f["y"]))
    (OUT).mkdir(parents=True, exist_ok=True)
    atlas.save(OUT / "atlas.webp", "WEBP", quality=92, method=6)
    manifest = {
        "version": 1,
        "image": "atlas.webp",
        "size": {"w": width, "h": height},
        # キー昇順で書く（差分が読めるように）
        "frames": {k: frames[k] for k in sorted(frames)},
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    kb = (OUT / "atlas.webp").stat().st_size // 1024
    print(f"アトラス {width}x{height} / {len(frames)} 枚 / {kb} KB → {OUT / 'atlas.webp'}")
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    jobs = all_jobs(args.only)
    have = sum(1 for j in jobs if _raw_path(j.key).exists())
    print(f"合計 {len(jobs)} 件（生成済み {have} / 未生成 {len(jobs) - have}）")
    for j in jobs[: args.show]:
        mark = "✓" if _raw_path(j.key).exists() else " "
        print(f" {mark} {j.key}  [{j.gen_size}→{j.out_px}px]")
        if args.verbose:
            print(f"      {j.prompt}")
    if len(jobs) > args.show:
        print(f" … 他 {len(jobs) - args.show} 件")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="multi-taktika のアセットを作る")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "gen", "post", "pack"):
        p = sub.add_parser(name)
        p.add_argument("--only", nargs="*", default=None, help="units/buildings/emblems/orders/portraits")
        if name == "gen":
            p.add_argument("--parallel", type=int, default=10, help="最大 10（スキルの制約）")
            p.add_argument("--model", default="gpt-image-1-mini")
            p.add_argument("--quality", default="medium")
        if name == "post":
            p.add_argument("--force", action="store_true")
        if name == "pack":
            p.add_argument("--width", type=int, default=2048)
        if name == "plan":
            p.add_argument("--show", type=int, default=20)
            p.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    if args.cmd == "gen" and args.parallel > 10:
        print("並列は最大 10（AI_CODING.md の取り決め）")
        return 1
    return {"plan": cmd_plan, "gen": cmd_gen, "post": cmd_post, "pack": cmd_pack}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
