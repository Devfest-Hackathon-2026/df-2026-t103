#!/usr/bin/env bash
# 患者アプリの画面を、実機や macOS がなくてもローカルの Web ブラウザで単独確認する
# ための起動ヘルパ（Issue #118）。Docker・Firebase Emulator・API は不要。
#
#   ./preview.sh list            利用できるプレビューを一覧表示する
#   ./preview.sh <name> [port]   指定した画面を単独起動する（既定ポートは一覧に表示）
#   ./preview.sh welcome         通常の起動画面（main.dart・Firebase Emulator 前提）
#
# <name> は lib/demo_<name>_preview.dart の <name> 部分です（例: home, symptom,
# safety_confirm）。合成データ以外（実患者情報・非公開の施設情報）は入力しないで
# ください。各プレビューは Firebase/API/実送信に接続しません。
set -eu

cd "$(dirname "$0")"

# 利用可能なプレビュー名を、実在する lib/demo_*_preview.dart から機械的に導出する。
# ハードコードしないため、画面を追加・削除しても一覧と起動対象が自動で追従する。
discover_names() {
  local f base
  for f in lib/demo_*_preview.dart; do
    [ -e "$f" ] || continue
    base=${f#lib/demo_}
    base=${base%_preview.dart}
    printf '%s\n' "$base"
  done | sort
}

# 名前 -> ポート。ポートは一覧上の並び順から決定論的に割り当てる（5051 以降）。
# welcome のみ Firebase を初期化する通常起動のため 5050 固定で別扱い。
port_for() {
  local want=$1 i=0 name
  while IFS= read -r name; do
    i=$((i + 1))
    if [ "$name" = "$want" ]; then
      printf '%s\n' "$((5050 + i))"
      return 0
    fi
  done < <(discover_names)
  return 1
}

usage() {
  echo "Usage: $0 {list|welcome|<name>} [port]" >&2
  echo "Run '$0 list' to see available previews." >&2
}

cmd=${1:-}

case "$cmd" in
  ""|-h|--help|help)
    usage
    exit 2
    ;;
  list)
    echo "Available patient previews (run: ./preview.sh <name>):"
    echo
    printf '  %-20s %-6s %s\n' "name" "port" "entrypoint"
    printf '  %-20s %-6s %s\n' "welcome" "5050" "lib/main.dart (Firebase Emulator 前提)"
    while IFS= read -r name; do
      printf '  %-20s %-6s %s\n' "$name" "$(port_for "$name")" "lib/demo_${name}_preview.dart"
    done < <(discover_names)
    echo
    echo "合成データのみを使用し、実患者情報・非公開の施設情報は入力しないでください。"
    exit 0
    ;;
  welcome)
    target=lib/main.dart
    port=${2:-5050}
    set -- --dart-define=USE_FIREBASE_EMULATOR=true --dart-define=FIREBASE_PROJECT_ID=demo-mmr-dev
    ;;
  *)
    target="lib/demo_${cmd}_preview.dart"
    if [ ! -f "$target" ]; then
      echo "Unknown preview: $cmd" >&2
      usage
      exit 2
    fi
    port=${2:-$(port_for "$cmd")}
    set --
    ;;
esac

if [ ! -f "$target" ]; then
  echo "Preview not available on this branch: $target" >&2
  exit 1
fi

echo "Open http://127.0.0.1:$port/ after Flutter starts. Stop with Ctrl+C."
exec flutter run -d web-server --web-hostname=127.0.0.1 --web-port="$port" -t "$target" "$@"
