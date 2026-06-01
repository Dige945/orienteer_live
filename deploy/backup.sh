#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/orienteer-live}"
BACKUP_DIR="${BACKUP_DIR:-/opt/orienteer-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/orienteer-live-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

tar -czf "$OUT" \
  -C "$APP_DIR" \
  data \
  public/uploads

echo "Backup written: $OUT"
