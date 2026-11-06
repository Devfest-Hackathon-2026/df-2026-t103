#!/usr/bin/env bash
# =============================================================================
# Firestore バックアップ設定 — Issue #35 / docs/04 §5.11・§11
#
# PITR の有効化・マネージドバックアップスケジュール・（任意）GCS エクスポート用
# バケット作成を冪等に行う。IAM/有効化は owner 権限で実施。
#
# 使い方:
#   PROJECT_ID=project-7efcc4c4-6c86-490c-ba5 ./infra/firestore/backup-export.sh
# =============================================================================
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?PROJECT_ID を設定してください}"
LOCATION="${LOCATION:-asia-northeast1}"
DATABASE="${DATABASE:-(default)}"
BACKUP_BUCKET="${BACKUP_BUCKET:-gs://${PROJECT_ID}-firestore-backups}"

echo "== project=${PROJECT_ID} db=${DATABASE} location=${LOCATION} =="

# 1) PITR（Point-in-Time Recovery）を有効化（直近7日）
echo "-- enabling PITR"
gcloud firestore databases update \
  --project "${PROJECT_ID}" --database "${DATABASE}" \
  --enable-pitr

# 2) マネージドバックアップスケジュール（日次・保持7日）
#    既存があれば作成をスキップ（冪等）。
echo "-- daily backup schedule (retention 7d)"
if gcloud firestore backups schedules list \
     --project "${PROJECT_ID}" --database "${DATABASE}" \
     --format='value(name)' 2>/dev/null | grep -q .; then
  echo "backup schedule: 既に存在（必要なら update で調整）"
else
  gcloud firestore backups schedules create \
    --project "${PROJECT_ID}" --database "${DATABASE}" \
    --recurrence=daily --retention=7d
fi

# 3) （任意）GCS エクスポート用バケット（長期保管・可搬性が必要な場合）
#    東京・uniform bucket-level access。実エクスポートは Cloud Scheduler から
#    `gcloud firestore export ${BACKUP_BUCKET}` を定期実行する運用を別途設定。
echo "-- export bucket (optional)"
if gsutil ls -b "${BACKUP_BUCKET}" >/dev/null 2>&1; then
  echo "bucket ${BACKUP_BUCKET}: 既に存在"
else
  gsutil mb -p "${PROJECT_ID}" -l "${LOCATION}" -b on "${BACKUP_BUCKET}"
  # 90日で自動削除するライフサイクル（保持費用の抑制）
  tmp="$(mktemp)"
  printf '%s' '{"rule":[{"action":{"type":"Delete"},"condition":{"age":90}}]}' > "${tmp}"
  gsutil lifecycle set "${tmp}" "${BACKUP_BUCKET}"
  rm -f "${tmp}"
fi

echo "== done =="
echo "復元: PITR は 'gcloud firestore databases restore'、バックアップは backups list→restore を使用。"
echo "PHI 注意(§5.11): バックアップ保持期間と退会削除の tombstone 再適用を整合させること。"
