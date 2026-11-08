#!/usr/bin/env bash
# End-to-end runner for the patient intake E2E (#78, docs/03 §10 E2E-001).
#
# Stands up the Firebase Auth/Firestore/Database/Storage emulators, seeds a
# ready patient (auth user + account + complete profile + current consents),
# starts the real API against the emulators on :8080, then runs the gated
# Flutter integration test (real sign-in → symptom UI → API persistence →
# logout). Everything is torn down on exit.
#
# Emulator-only, no production credentials. Firestore runs on 8081 so the API
# can own :8080 (the origin the Flutter test expects).
#
# Requirements: a JRE on PATH (Firebase emulators need Java), firebase-tools,
# node, and a Flutter 3.47.4 toolchain. Override the Flutter binary with
# FLUTTER_BIN if it is not on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

FLUTTER_BIN="${FLUTTER_BIN:-flutter}"
PROJECT_ID="demo-mmr-dev"
AUTH_HOST="127.0.0.1:9099"
FS_HOST="127.0.0.1:8081"
DB_HOST="127.0.0.1:9000"
STORAGE_HOST="127.0.0.1:9199"

export FIREBASE_AUTH_EMULATOR_HOST="$AUTH_HOST"
export FIRESTORE_EMULATOR_HOST="$FS_HOST"
export FIREBASE_DATABASE_EMULATOR_HOST="$DB_HOST"
export FIREBASE_STORAGE_EMULATOR_HOST="$STORAGE_HOST"
export FIREBASE_PROJECT_ID="$PROJECT_ID"

# Must live in the repo root so the relative rules paths in firebase.json
# (firestore.rules, database.rules.json, storage.rules) still resolve.
TMP_CONFIG="$ROOT/.firebase-e2e.json"
EMU_PID=""
API_PID=""

cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$EMU_PID" ] && kill "$EMU_PID" 2>/dev/null || true
  rm -f "$TMP_CONFIG"
}
trap cleanup EXIT

wait_port() {
  local host="${1%%:*}" port="${1##*:}" tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    if nc -z "$host" "$port" 2>/dev/null; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $1" >&2
  return 1
}

echo "==> building API"
npm --prefix services/api run build >/dev/null

echo "==> firestore on 8081 (frees 8080 for the API)"
node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('firebase.json'));c.emulators.firestore.port=8081;c.emulators.auth.port=9099;fs.writeFileSync('$TMP_CONFIG',JSON.stringify(c));"

echo "==> starting emulators"
firebase emulators:start --only auth,firestore,database,storage \
  --project "$PROJECT_ID" --config "$TMP_CONFIG" >/tmp/intake-e2e-emu.log 2>&1 &
EMU_PID=$!
wait_port "$AUTH_HOST"; wait_port "$FS_HOST"; wait_port "$DB_HOST"; wait_port "$STORAGE_HOST"

echo "==> seeding ready patient"
node services/api/scripts/seedPatientE2E.mjs

echo "==> starting API on :8080"
PORT=8080 node services/api/dist/index.js >/tmp/intake-e2e-api.log 2>&1 &
API_PID=$!
wait_port "127.0.0.1:8080"

echo "==> running Flutter intake E2E (E2E-001 happy path + 001B consent gate)"
cd apps/patient
"$FLUTTER_BIN" test test/integration/ \
  --dart-define=RUN_INTAKE_UI_INTEGRATION=true
echo "==> E2E passed"
