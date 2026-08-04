#!/usr/bin/env bash
# アセット生成の台帳＋実行スクリプト。
# 同じスタイルで再生成できるよう、プロンプトはすべてここに置く。
#
#   使い方: bash 10_assets_plan/gen.sh <name>
#     name の例: egg_mocha / mocha_child_idle / mocha_child_happy ...
#   生成物は .tmp/assets/ に出るので、確認後 public/assets/pets/ へ配置する。

set -euo pipefail
cd "$(dirname "$0")/.."

SKILL="/Users/ryosato/.claude/skills/img-gen-gpt/scripts/generate_image.py"
# 画像生成用の Azure リソースはこのリポジトリの .env に無いため、
# US リソースの資格情報を持つ .env を参照する。
ENV_FILE="${AI_PET_IMG_ENV:-/Users/ryosato/projects/private/english-learn/.env}"
OUT="$PWD/.tmp/assets"
# 並列実行すると生成物のタイムスタンプ名が衝突するので、1回ごとに作業ディレクトリを分ける。
WORK="$OUT/work_$$"
mkdir -p "$OUT" "$WORK"
trap 'rm -rf "$WORK"' EXIT

# すべてのアセットで共通のスタイル指定。ここを変えると絵柄が揃わなくなる。
STYLE="フラットな2Dベクターイラスト。太くはっきりした濃い茶色の輪郭線。パステルカラーのベタ塗り。グラデーションや写実的な影は使わない。背景は完全に透明。影・地面・枠・文字・複数キャラは描かない。対象は画像の中央に大きく配置。"

BODY_MOCHA="ミルクティー色のまるっこい体、大きなたれ耳、つやのある大きな黒い丸い目、小さな口、ほおに薄いピンクの丸、短い手足、ふわふわの小さなしっぽ"
BODY_POME="ふわふわの淡い黄色の体、ぴんと立った三角の耳、大きな黒い丸い目、開いた小さな口、短い手足、丸まったしっぽ"
BODY_NIMBUS="淡い水色の雲のような体、耳のかわりに左右の小さなふくらみ、細めの落ち着いた目、小さな口、輪郭がやわらかい"

# 生成された画像を、決めた名前で $OUT に移す。
MOVE_PY='
import json, os, shutil, sys
data = json.load(sys.stdin)
src = data["saved_images"][0]["path"]
name = os.environ["ASSET_NAME"] + ".png"
shutil.move(src, os.path.join(os.environ["ASSET_OUT"], name))
print(name, data["estimated_cost"]["total_usd"])
'

gen() { # gen <file> <prompt>
  UV_CACHE_DIR="$PWD/.uv_cache" uv run --with httpx --with python-dotenv --with pyyaml --with openai \
    python "$SKILL" --operation generate --env-file "$ENV_FILE" \
    --background transparent --output-format png --size 1024x1024 --quality medium \
    --output-dir "$WORK" --prompt "$2" \
  | ASSET_OUT="$OUT" ASSET_NAME="$1" python3 -c "$MOVE_PY"
}

edit() { # edit <file> <base-file> <prompt>
  UV_CACHE_DIR="$PWD/.uv_cache" uv run --with httpx --with python-dotenv --with pyyaml --with openai \
    python "$SKILL" --operation edit --env-file "$ENV_FILE" \
    --input-images "$OUT/$2.png" \
    --background transparent --output-format png --size 1024x1024 --quality medium \
    --output-dir "$WORK" --prompt "$3" \
  | ASSET_OUT="$OUT" ASSET_NAME="$1" python3 -c "$MOVE_PY"
}

body_of() {
  case "$1" in
    mocha) echo "$BODY_MOCHA" ;;
    pome) echo "$BODY_POME" ;;
    nimbus) echo "$BODY_NIMBUS" ;;
  esac
}

furn_of() {
  case "$1" in
    furn_rug) echo 'まるい形のふかふかしたラグマット。上から見た楕円形。淡いミントグリーンで、縁が波打っている' ;;
    furn_bed) echo '小動物用のまるいペットベッド。淡いピンクのクッションが入った、ふちの高いバスケット。斜め前から見た形' ;;
    furn_plant) echo '素焼きの鉢に植わった観葉植物。丸い葉が5枚ほど、上に広がっている' ;;
    furn_lamp) echo '球形のかさがついた小さなフロアランプ。細い脚と丸い台。かさは淡いクリーム色でほんのり光っている' ;;
    furn_shelf) echo '2段の小さな木の棚。上の段に小さな鉢植えと本が1冊置いてある。正面から見た形' ;;
    furn_window) echo 'まるい形の窓。木枠で、ガラスの向こうに水色の空と白い雲が少し見える' ;;
  esac
}

tint_of() {
  case "$1" in
    mocha) echo 'うすい茶色' ;;
    pome) echo 'うすい黄色' ;;
    nimbus) echo 'うすい水色' ;;
  esac
}

case "${1:-}" in
  egg_*)
    species="${1#egg_}"
    tint=$(tint_of "$species")
    gen "$1" "$STYLE 卵のイラスト1個。クリーム色のなめらかな殻に、${tint}のまるいまだら模様が3つ。かわいらしく、少し縦長。顔は描かない。"
    ;;
  *_child_idle)
    species="${1%%_*}"
    gen "$1" "$STYLE かわいい2Dゲーム用キャラクターの立ち絵1体。子どもらしく頭が大きく体が小さい二頭身。$(body_of "$species")。正面を向いて立っている全身。表情は穏やかな普通の顔。"
    ;;
  *_adult_idle)
    species="${1%%_*}"
    gen "$1" "$STYLE かわいい2Dゲーム用キャラクターの立ち絵1体。おとなに成長した姿で、子どもより体が縦に長くすらりとしている。$(body_of "$species")。正面を向いて立っている全身。表情は落ち着いた普通の顔。"
    ;;
  *_happy)
    base="${1%_happy}_idle"
    edit "$1" "$base" "$STYLE 同じキャラクターの表情だけを変える。体の形・色・輪郭は完全に同じまま、目を細めた笑顔にし、口を大きく開けてにこにこさせ、ほおのピンクを濃くする。うれしそうな顔。"
    ;;
  *_sulky)
    base="${1%_sulky}_idle"
    edit "$1" "$base" "$STYLE 同じキャラクターの表情だけを変える。体の形・色・輪郭は完全に同じまま、目を「へ」の字にし、口を小さくむっとさせ、少しふてくされた不満そうな顔にする。"
    ;;
  *_sleepy)
    base="${1%_sleepy}_idle"
    edit "$1" "$base" "$STYLE 同じキャラクターの表情だけを変える。体の形・色・輪郭は完全に同じまま、目を閉じて弧を描いた線にし、口を小さく開けて眠そうな顔にする。"
    ;;
  furn_*)
    # 部屋に置く家具。ペットと同じ絵柄で揃える。
    desc=$(furn_of "$1")
    gen "$1" "$STYLE ゲームの部屋に置く家具のイラスト1点。${desc}。キャラクターや人は描かない。"
    ;;
  *)
    echo "unknown asset: ${1:-}" >&2
    exit 1
    ;;
esac
