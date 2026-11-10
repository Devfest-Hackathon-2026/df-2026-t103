#!/usr/bin/env bash
# Inspect the existing single-project backup policy. Mutations require --apply.
# Normal provisioning is owned by infra/terraform/firestore.tf.
set -euo pipefail

mode="${1:---check}"
if [[ "$#" -gt 1 || ( "$mode" != --check && "$mode" != --apply ) ]]; then
  echo 'Usage: PROJECT_ID=project-7efcc4c4-6c86-490c-ba5 backup-export.sh [--check|--apply]' >&2
  exit 2
fi
PROJECT_ID="${PROJECT_ID:?PROJECT_ID を設定してください}"
DATABASE="${DATABASE:-(default)}"
if [[ "$PROJECT_ID" != project-7efcc4c4-6c86-490c-ba5 || "$DATABASE" != '(default)' || "${LOCATION:-asia-northeast1}" != asia-northeast1 ]]; then
  echo 'Only the configured project, (default) database and Tokyo location are supported.' >&2
  exit 2
fi

scratch_dir="$(mktemp -d)"
trap 'rm -rf "$scratch_dir"' EXIT
# Complete all reads and validate before the first write. Never interpret a
# failed list request as an absent schedule; stderr and exit status propagate.
gcloud firestore databases describe --project "$PROJECT_ID" --database "$DATABASE" \
  --format=json > "$scratch_dir/database.json"
gcloud firestore backups schedules list --project "$PROJECT_ID" --database "$DATABASE" \
  --format=json > "$scratch_dir/schedules.json"
state="$(python3 - "$scratch_dir" <<'PY'
import json
import pathlib
import sys

try:
    root = pathlib.Path(sys.argv[1])
    database = json.loads((root / 'database.json').read_text())
    schedules = json.loads((root / 'schedules.json').read_text())
    if database.get('locationId') != 'asia-northeast1':
        raise ValueError('Database must be in Tokyo.')
    pitr = database.get('pointInTimeRecoveryEnablement')
    if pitr not in ('POINT_IN_TIME_RECOVERY_ENABLED', 'POINT_IN_TIME_RECOVERY_DISABLED'):
        raise ValueError('Unknown PITR state; refusing to change settings.')
    if not isinstance(schedules, list) or any(not isinstance(s, dict) for s in schedules):
        raise ValueError('Invalid backup schedule response.')
    if any(('dailyRecurrence' in s) == ('weeklyRecurrence' in s) for s in schedules):
        raise ValueError('Unknown backup recurrence; inspect configuration manually.')
    daily = [s for s in schedules if 'dailyRecurrence' in s]
    if len(daily) > 1 or any(s.get('retention') != '604800s' for s in daily):
        raise ValueError('Daily retention differs from the 7-day policy; review Terraform state before changing it.')
    print('enabled' if pitr == 'POINT_IN_TIME_RECOVERY_ENABLED' else 'disabled',
          'present' if daily else 'missing')
except (ValueError, TypeError, AttributeError, OSError):
    # Do not print the response, exception contents or resource identifiers.
    print('Backup metadata does not match the expected policy; no changes made.', file=sys.stderr)
    sys.exit(2)
PY
)"
read -r pitr daily <<< "$state"
echo "PITR: $pitr; daily 7-day backup: $daily"
if [[ "$mode" == --check ]]; then
  if [[ "$pitr" != enabled || "$daily" != present ]]; then
    echo 'Policy incomplete. Review Terraform ownership/cost before using --apply.' >&2
    exit 1
  fi
  exit 0
fi

if [[ "$pitr" != enabled ]]; then
  gcloud firestore databases update --project "$PROJECT_ID" --database "$DATABASE" --enable-pitr --quiet
fi
if [[ "$daily" != present ]]; then
  gcloud firestore backups schedules create --project "$PROJECT_ID" --database "$DATABASE" \
    --recurrence=daily --retention=7d --quiet
fi
# Re-read independently; a successful command is not evidence of the final state.
bash "$0" --check
