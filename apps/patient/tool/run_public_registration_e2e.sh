#!/usr/bin/env bash
set -euo pipefail

# Runs only loopback Firebase Auth/Firestore emulators and the real local API.
# All processes are started in private process groups and stopped by this script.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
FLUTTER_BIN="${FLUTTER_BIN:-flutter}"
FIREBASE_BIN="${FIREBASE_BIN:-npx --yes firebase-tools@15.35.0}"
PROJECT_ID=demo-mmr-dev
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/public-registration-e2e.XXXXXX")"
EMU_PID=""
API_PID=""
KEEP_RUN_DIR="${KEEP_RUN_DIR:-0}"

stop_group() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  python3 - "$pid" <<'PY'
import os, signal, sys, time
pid = int(sys.argv[1])
try:
    os.killpg(pid, signal.SIGTERM)
except ProcessLookupError:
    raise SystemExit(0)
for _ in range(60):
    try: os.killpg(pid, 0)
    except ProcessLookupError: raise SystemExit(0)
    time.sleep(.1)
try: os.killpg(pid, signal.SIGKILL)
except ProcessLookupError: pass
PY
}

cleanup() {
  local result=$?
  stop_group "$API_PID" || true
  stop_group "$EMU_PID" || true
  if [ "$KEEP_RUN_DIR" = 1 ] || [ "$result" -ne 0 ]; then
    echo "Local E2E artifacts retained at $RUN_DIR" >&2
  else
    rm -rf "$RUN_DIR"
  fi
  exit "$result"
}
trap cleanup EXIT INT TERM

read -r API_PORT AUTH_PORT FS_PORT DB_PORT STORAGE_PORT < <(python3 - <<'PY'
import socket
ports=[]
for _ in range(5):
    sock=socket.socket()
    sock.bind(('127.0.0.1', 0))
    ports.append(sock.getsockname()[1])
    sock.close()
print(*ports)
PY
)
API_ORIGIN="http://127.0.0.1:$API_PORT"
AUTH_ORIGIN="http://127.0.0.1:$AUTH_PORT"

# Verify the selected ports are still free before starting anything.
python3 - "$API_PORT" "$AUTH_PORT" "$FS_PORT" "$DB_PORT" "$STORAGE_PORT" <<'PY'
import socket, sys
for value in sys.argv[1:]:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', int(value)))
PY

echo '==> build API'
npm --prefix services/api run build

echo '==> write loopback-only Firebase emulator config'
node - "$RUN_DIR/firebase.json" "$ROOT" "$AUTH_PORT" "$FS_PORT" "$DB_PORT" "$STORAGE_PORT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, root, authPort, firestorePort, databasePort, storagePort] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({
  firestore: {
    rules: path.join(root, 'firebase/firestore.rules'),
    indexes: path.join(root, 'firebase/firestore.indexes.json'),
  },
  database: { rules: path.join(root, 'firebase/database.rules.json') },
  storage: { rules: path.join(root, 'firebase/storage.rules') },
  emulators: {
    auth: { host: '127.0.0.1', port: Number(authPort) },
    firestore: { host: '127.0.0.1', port: Number(firestorePort) },
    database: { host: '127.0.0.1', port: Number(databasePort) },
    storage: { host: '127.0.0.1', port: Number(storagePort) },
    ui: { enabled: false },
    singleProjectMode: true,
  },
}));
NODE

start_group() {
  local log="$1"; shift
  python3 - "$log" "$@" <<'PY'
import subprocess, sys
log, *command = sys.argv[1:]
with open(log, 'wb') as output:
    process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT,
                               start_new_session=True)
print(process.pid)
PY
}
wait_for_log() {
  local log="$1" marker="$2" pid="$3"
  for _ in $(seq 1 120); do
    grep -Fq "$marker" "$log" 2>/dev/null && return 0
    kill -0 "$pid" 2>/dev/null || { tail -n 60 "$log" >&2; return 1; }
    sleep 1
  done
  tail -n 60 "$log" >&2
  return 1
}

read -r -a FIREBASE_COMMAND <<<"$FIREBASE_BIN"
echo '==> start Firebase Auth and Firestore emulators on loopback'
EMU_PID="$(start_group "$RUN_DIR/emulators.log" "${FIREBASE_COMMAND[@]}" \
  emulators:start --only auth,firestore --project "$PROJECT_ID" \
  --config "$RUN_DIR/firebase.json")"
wait_for_log "$RUN_DIR/emulators.log" 'All emulators ready' "$EMU_PID"

export FIREBASE_PROJECT_ID="$PROJECT_ID"
export FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:$AUTH_PORT"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:$FS_PORT"
export FIREBASE_DATABASE_EMULATOR_HOST="127.0.0.1:$DB_PORT"
export FIREBASE_STORAGE_EMULATOR_HOST="127.0.0.1:$STORAGE_PORT"
unset GCLOUD_PROJECT GOOGLE_APPLICATION_CREDENTIALS VERTEX_AI_API_KEY GOOGLE_PLACES_API_KEY
echo '==> seed synthetic legal documents in disposable Firestore emulator'
node services/api/scripts/seedPatientE2E.mjs >/dev/null
node services/api/scripts/seedPublicRegistrationLegal.mjs >/dev/null

echo '==> start actual API bound to loopback'
API_PID="$(start_group "$RUN_DIR/api.log" env HOST=127.0.0.1 PORT="$API_PORT" \
  node services/api/dist/index.js)"
wait_for_log "$RUN_DIR/api.log" 'Server listening at' "$API_PID"

echo '==> run public registration → Auth sign-in → email verification flow'
cd apps/patient
"$FLUTTER_BIN" pub get
REPORT="$RUN_DIR/public-registration.jsonl"
if "$FLUTTER_BIN" test --no-pub test/integration/public_patient_registration_test.dart \
  --dart-define=RUN_PUBLIC_REGISTRATION_INTEGRATION=true \
  --dart-define="PUBLIC_REGISTRATION_API_ORIGIN=$API_ORIGIN" \
  --dart-define="PUBLIC_REGISTRATION_AUTH_ORIGIN=$AUTH_ORIGIN" \
  --machine >"$REPORT" 2>"$RUN_DIR/flutter.log"; then
  # The parser requires a complete reporter lifecycle and at least one visible
  # success. The single integration test is rejected if it was skipped.
  python3 tool/summarize_flutter_machine.py "$REPORT"
else
  status=$?
  python3 tool/summarize_flutter_machine.py "$REPORT" --diagnostic-partial >&2 || true
  echo "Public registration Flutter test failed (exit $status)." >&2
  exit "$status"
fi
echo '==> public registration emulator/API integration passed'
