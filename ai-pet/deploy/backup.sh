#!/usr/bin/env bash
# 『ぽこもふ島』の日次バックアップ（deploy/README.md 参照）
#
# SQLite の `.backup` はオンラインバックアップAPIを使うので**サーバを止めずに**取れる。
# ファイルを直接 cp すると WAL の途中を掴んで壊れることがあるので使わない。

set -euo pipefail

APP_DIR="${APP_DIR:-/srv/pokomofu/app/ai-pet}"
DB="${DB_PATH:-$APP_DIR/data/island.db}"
DEST="${BACKUP_DIR:-$APP_DIR/data/backup}"
KEEP_DAYS="${KEEP_DAYS:-14}"

if [ ! -f "$DB" ]; then
  echo "[backup] DBが見つかりません: $DB" >&2
  exit 1
fi

mkdir -p "$DEST"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$DEST/island_$STAMP.db"

# オンラインバックアップ（読み取りロックだけで済む）
sqlite3 "$DB" ".backup '$OUT'"

# 整合性を確認してから圧縮する。壊れたバックアップを残しても意味がない
if ! sqlite3 "$OUT" 'PRAGMA integrity_check;' | grep -q '^ok$'; then
  echo "[backup] integrity_check に失敗しました: $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

gzip -9 "$OUT"
echo "[backup] $OUT.gz を作成しました ($(du -h "$OUT.gz" | cut -f1))"

# 古いものを消す
find "$DEST" -name 'island_*.db.gz' -mtime "+$KEEP_DAYS" -delete
echo "[backup] $KEEP_DAYS 日より古いバックアップを削除しました"
