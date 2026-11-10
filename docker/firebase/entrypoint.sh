#!/bin/sh
set -eu

PROJECT="${FIREBASE_PROJECT_ID:-demo-mmr-dev}"
EXPORT_DIR="./.local/export"

set -- firebase emulators:start --project "$PROJECT" --only auth,firestore,database,storage

# 以前 `make down` 等でエクスポート済みのデータがあれば復元し、終了時に再エクスポートする
if [ -d "$EXPORT_DIR" ] && [ -n "$(ls -A "$EXPORT_DIR" 2>/dev/null || true)" ]; then
  set -- "$@" --import="$EXPORT_DIR" --export-on-exit="$EXPORT_DIR"
fi

exec "$@"
