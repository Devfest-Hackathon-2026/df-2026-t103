#!/usr/bin/env bash
# End-to-end runner for the patient intake E2E (#78, docs/03 §10 E2E-001).
#
# Stands up the Firebase Auth/Firestore/Database/Storage emulators, seeds a
# ready patient (auth user + account + complete profile + current consents),
# starts the real API against the emulators on :8080, then runs the gated
# Flutter integration test (real sign-in → symptom UI → API persistence →
# logout). Cleanup is best-effort; timeout descendant cleanup is not guaranteed.
#
# Emulator-only, no production credentials. All listeners are loopback-only.
#
# Requirements: a JRE on PATH (Firebase emulators need Java), firebase-tools,
# node, and a Flutter 3.47.4 toolchain. Override the Flutter binary with
# FLUTTER_BIN if it is not on PATH.
set -euo pipefail

# This opt-in is an operator assertion, not an isolation mechanism. Run only
# in a dedicated, freshly provisioned environment where no other workload can
# own or depend on these fixed ports. The bind preflight below is advisory and
# has a TOCTOU race; it cannot guarantee port ownership or isolate processes.
if [ "${E2E_DISPOSABLE_RUNNER:-}" != "1" ]; then
  echo "refusing fixed-port E2E without explicit opt-in; E2E_DISPOSABLE_RUNNER=1 is only a self-assertion, not isolation. Use a dedicated, isolated runner." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

FLUTTER_BIN="${FLUTTER_BIN:-flutter}"
# Allow CI to inject "npx -y firebase-tools@<ver>" when firebase is not global.
# Used unquoted on purpose so the npx form word-splits into its arguments.
FIREBASE_BIN="${FIREBASE_BIN:-firebase}"
PROJECT_ID="demo-mmr-dev"
AUTH_HOST="127.0.0.1:9099"
FS_HOST="127.0.0.1:8081"
DB_HOST="127.0.0.1:9000"
STORAGE_HOST="127.0.0.1:9199"
API_HOST="127.0.0.1:8080"

export FIREBASE_AUTH_EMULATOR_HOST="$AUTH_HOST"
export FIRESTORE_EMULATOR_HOST="$FS_HOST"
export FIREBASE_DATABASE_EMULATOR_HOST="$DB_HOST"
export FIREBASE_STORAGE_EMULATOR_HOST="$STORAGE_HOST"
export FIREBASE_PROJECT_ID="$PROJECT_ID"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/patient-intake-e2e.XXXXXX")"
# Firebase resolves rules/index paths relative to its config file. This config
# lives in a temporary subdirectory, so rewrite those references to absolute
# paths rooted at the checked-out repository.
CONFIG_DIR="$(mktemp -d "$ROOT/.firebase-e2e.XXXXXX")"
TMP_CONFIG="$CONFIG_DIR/firebase.json"
EMU_PID=""
API_PID=""

# Portable bounded command execution (unlike GNU `timeout`, this also works on
# the macOS runners). Process-group termination is best-effort: descendants may
# outlive the leader, so this runner is restricted to a disposable hosted VM.
run_timed() {
  local seconds="$1"
  shift
  python3 - "$seconds" "$@" <<'PY'
import os, signal, subprocess, sys
seconds, *command = sys.argv[1:]
process = subprocess.Popen(command, start_new_session=True)
try:
    status = process.wait(timeout=int(seconds))
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    print(f"timeout after {seconds}s", file=sys.stderr)
    raise SystemExit(124)
raise SystemExit(status)
PY
}

start_group() {
  local pid_file="$1" log_file="$2"
  shift 2
  python3 - "$pid_file" "$log_file" "$@" <<'PY'
import subprocess, sys
pid_file, log_file, *command = sys.argv[1:]
with open(log_file, "wb") as log:
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                               start_new_session=True)
with open(pid_file, "w") as pid:
    pid.write(str(process.pid))
PY
  cat "$pid_file"
}

stop_group() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  python3 - "$pid" <<'PY'
import os, signal, sys, time
pid = int(sys.argv[1])
try:
    os.killpg(pid, signal.SIGTERM)
except ProcessLookupError:
    raise SystemExit(0)
for _ in range(50):
    try: os.killpg(pid, 0)
    except ProcessLookupError: raise SystemExit(0)
    time.sleep(.1)
try: os.killpg(pid, signal.SIGKILL)
except ProcessLookupError: pass
PY
}

cleanup() {
  # This cleanup is not a proof that every descendant exited. On timeout/failure
  # the job must fail and the GitHub-hosted disposable VM must be discarded.
  stop_group "$API_PID" || true
  stop_group "$EMU_PID" || true
  rm -rf "$RUN_DIR"
  rm -rf "$CONFIG_DIR"
}
trap cleanup EXIT

# Bind-only preflight: never probe by connecting to a possibly shared service.
# If any required listener is already occupied, stop without contacting it.
python3 - "$AUTH_HOST" "$FS_HOST" "$DB_HOST" "$STORAGE_HOST" "$API_HOST" <<'PY'
import socket
import sys

ports = [int(value.rsplit(":", 1)[1]) for value in sys.argv[1:]]
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"required loopback port is occupied; refusing to run: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

wait_log() {
  local file="$1" marker="$2" pid="$3"
  for _ in $(seq 1 120); do
    if grep -Fq "$marker" "$file" 2>/dev/null; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "process exited before readiness" >&2
      return 1
    fi
    sleep 1
  done
  echo "timed out waiting for process readiness" >&2
  return 1
}

echo "==> building API"
run_timed 300 npm --prefix services/api run build >/dev/null

echo "==> writing loopback-only emulator configuration"
node - "$TMP_CONFIG" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync('firebase.json', 'utf8'));
for (const key of ['rules', 'indexes']) {
  if (config.firestore[key]) config.firestore[key] = path.resolve(process.cwd(), config.firestore[key]);
}
for (const [name, key] of [['database', 'rules'], ['storage', 'rules']]) {
  if (config[name][key]) config[name][key] = path.resolve(process.cwd(), config[name][key]);
}
for (const [name, port] of Object.entries({
  auth: 9099, firestore: 8081, database: 9000, storage: 9199,
})) {
  config.emulators[name].host = '127.0.0.1';
  config.emulators[name].port = port;
}
config.emulators.ui.enabled = false;
fs.writeFileSync(process.argv[2], JSON.stringify(config));
NODE

echo "==> starting emulators"
# shellcheck disable=SC2086
read -r -a FIREBASE_COMMAND <<<"$FIREBASE_BIN"
EMU_PID="$(start_group "$RUN_DIR/emulator.pid" "$RUN_DIR/emulator.log" \
  "${FIREBASE_COMMAND[@]}" emulators:start --only auth,firestore,database,storage \
  --project "$PROJECT_ID" --config "$TMP_CONFIG")"
wait_log "$RUN_DIR/emulator.log" "All emulators ready" "$EMU_PID"

echo "==> seeding ready patient"
run_timed 60 node services/api/scripts/seedPatientE2E.mjs
run_timed 60 node services/api/scripts/seedPublicPatientE2E.mjs

echo "==> starting API on :8080"
API_PID="$(start_group "$RUN_DIR/api.pid" "$RUN_DIR/api.log" \
  env -u GCLOUD_PROJECT -u GOOGLE_APPLICATION_CREDENTIALS \
  -u VERTEX_AI_API_KEY -u GOOGLE_PLACES_API_KEY \
  HOST=127.0.0.1 PORT=8080 FIREBASE_PROJECT_ID="$PROJECT_ID" \
  node services/api/dist/index.js)"
wait_log "$RUN_DIR/api.log" "Server listening at" "$API_PID"

# Resolve dependencies before enabling machine output: Flutter's pub messages
# are human-readable and would otherwise be mixed into the JSONL event stream.
cd apps/patient
echo "==> resolving Flutter dependencies outside machine output"
run_timed 300 "$FLUTTER_BIN" pub get >/dev/null

# Preserve the original directory-wide selection order. JSON is retained only
# in the private temporary run directory; the parser emits aggregate counts.
# This per-file order can affect shared test state/order-dependent outcomes.
shopt -s nullglob
test_files=(test/integration/*_test.dart)
recovery_file="test/integration/public_patient_answer_recovery_test.dart"
if [ "${#test_files[@]}" -eq 0 ] || [ ! -f "$recovery_file" ]; then
  echo "==> required Flutter integration test selection is missing; refusing to report success" >&2
  exit 1
fi
for test_file in "${test_files[@]}"; do
  # The prior CI run emitted the required recovery test's success at the 600s
  # boundary, then Flutter failed to finalize after SIGTERM. Allow 50% extra
  # for natural process/reporter finalization; still require exit 0 and parser
  # confirmation, so reaching this longer bound is not success.
  test_timeout=120
  if [ "$test_file" = "$recovery_file" ]; then
    test_timeout=900
  fi
  echo "==> running Flutter integration test: ${test_file##*/} (timeout ${test_timeout}s)"
  if run_timed "$test_timeout" "$FLUTTER_BIN" test "$test_file" \
    --no-pub \
    --dart-define=RUN_INTAKE_UI_INTEGRATION=true \
    --machine >"$RUN_DIR/${test_file##*/}.jsonl" 2>/dev/null; then
    if [ "$test_file" = "$recovery_file" ]; then
      python3 tool/summarize_flutter_machine.py "$RUN_DIR/${test_file##*/}.jsonl" --require-recovery
    elif [ "${test_file##*/}" = "demo_email_registration_test.dart" ]; then
      # This suite requires RUN_DEMO_AUTH_INTEGRATION, not the intake define;
      # its intentional all-skipped result is not evidence of exercised tests.
      python3 tool/summarize_flutter_machine.py "$RUN_DIR/${test_file##*/}.jsonl" --allow-all-skipped
    else
      python3 tool/summarize_flutter_machine.py "$RUN_DIR/${test_file##*/}.jsonl"
    fi
  else
    status=$?
    if [ "$status" -eq 124 ]; then
      echo "==> Flutter test process timeout: ${test_timeout}s; exit code 124; target ${test_file##*/}; output suppressed" >&2
    else
      echo "==> Flutter test process nonzero exit: exit code $status; target ${test_file##*/}; output suppressed" >&2
    fi
    exit "$status"
  fi
done
echo "==> all selected Flutter integration tests passed, including answer recovery"
