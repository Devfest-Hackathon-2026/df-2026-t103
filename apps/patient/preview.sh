#!/usr/bin/env bash
set -eu

cd "$(dirname "$0")"

case "${1:-}" in
  welcome)
    target=lib/main.dart
    port=5050
    set -- --dart-define=USE_FIREBASE_EMULATOR=true --dart-define=FIREBASE_PROJECT_ID=demo-mmr-dev
    ;;
  home)
    target=lib/demo_home_preview.dart
    port=5051
    set --
    ;;
  symptom)
    target=lib/demo_symptom_preview.dart
    port=5052
    set --
    ;;
  *)
    echo "Usage: $0 {welcome|home|symptom}" >&2
    exit 2
    ;;
esac

if [ ! -f "$target" ]; then
  echo "Preview not available on this branch: $target" >&2
  exit 1
fi

echo "Open http://127.0.0.1:$port/ after Flutter starts. Stop with Ctrl+C."
exec flutter run -d web-server --web-hostname=127.0.0.1 --web-port="$port" -t "$target" "$@"
