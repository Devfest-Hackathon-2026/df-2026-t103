#!/usr/bin/env bash
# =============================================================================
# 非同期ジョブ基盤のセットアップ — Issue #31 / docs/02 §9・§10・docs/04 §10
#
# Cloud Tasks キュー（OCR/送信/削除リトライ）と Cloud Scheduler ジョブ
# （削除期限スキャン・アップロード期限/整合性スキャン）を作成する。
#
# 冪等: queue/job は "describe で存在確認 → なければ create" で再実行可能。
# 実行前提:
#   - PROJECT_ID / REGION を環境に合わせて設定
#   - worker Cloud Run サービス（infra/cloud-run/service-worker.yaml）がデプロイ済み
#   - OIDC 呼び出し用 SA（scheduler-invoker / tasks-invoker）が作成済みで、
#     worker サービスに roles/run.invoker を付与済み（IAM 付与は owner 実施）
#
# 使い方:
#   PROJECT_ID=project-7efcc4c4-6c86-490c-ba5 ./infra/setup-async-jobs.sh
# =============================================================================
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?PROJECT_ID を設定してください}"
REGION="${REGION:-asia-northeast1}"
WORKER_URL="${WORKER_URL:-https://worker-<hash>-an.a.run.app}" # worker サービスの URL
INVOKER_SA="${INVOKER_SA:-jobs-invoker@${PROJECT_ID}.iam.gserviceaccount.com}"

echo "== project=${PROJECT_ID} region=${REGION} =="

# ---------------------------------------------------------------------------
# Cloud Tasks キュー
#   - maxAttempts で DLQ 相当の打ち切りを表現（打ち切り後は Firestore 側の
#     failed ジョブ記録で失敗管理 = ADR-0009 の投入回収設計）。
#   - maxConcurrentDispatches で OCR 大量投入時の費用急増を抑制（§11.2）。
# ---------------------------------------------------------------------------
create_queue() {
  local name="$1" max_attempts="$2" max_dispatches="$3" max_rate="$4"
  if gcloud tasks queues describe "${name}" --project "${PROJECT_ID}" --location "${REGION}" >/dev/null 2>&1; then
    echo "queue ${name}: exists (update)"
    gcloud tasks queues update "${name}" \
      --project "${PROJECT_ID}" --location "${REGION}" \
      --max-attempts "${max_attempts}" \
      --max-concurrent-dispatches "${max_dispatches}" \
      --max-dispatches-per-second "${max_rate}" \
      --min-backoff 10s --max-backoff 300s
  else
    echo "queue ${name}: create"
    gcloud tasks queues create "${name}" \
      --project "${PROJECT_ID}" --location "${REGION}" \
      --max-attempts "${max_attempts}" \
      --max-concurrent-dispatches "${max_dispatches}" \
      --max-dispatches-per-second "${max_rate}" \
      --min-backoff 10s --max-backoff 300s
  fi
}

# OCR 実行: 重め・費用敏感なので並行度低め、リトライ多め
create_queue ocr 5 10 5
# 医療機関への送信/通知: at-least-once、ワーカー側で冪等化（§9）
create_queue delivery 8 20 10
# 削除ジョブのリトライ
create_queue deletion-retry 5 10 5

# ---------------------------------------------------------------------------
# Cloud Scheduler ジョブ（OIDC で worker 内部エンドポイントを叩く）
#   - attemptDeadline と OIDC SA を指定。
#   - 重複実行制御: Scheduler は 1 ジョブ 1 発火だが、ワーカー側のリース/冪等で
#     二重処理を防ぐ（ADR-0009/0011）。
# ---------------------------------------------------------------------------
create_scheduler() {
  local name="$1" schedule="$2" path="$3"
  local uri="${WORKER_URL}${path}"
  if gcloud scheduler jobs describe "${name}" --project "${PROJECT_ID}" --location "${REGION}" >/dev/null 2>&1; then
    echo "scheduler ${name}: exists (update)"
    gcloud scheduler jobs update http "${name}" \
      --project "${PROJECT_ID}" --location "${REGION}" \
      --schedule "${schedule}" --time-zone "Asia/Tokyo" \
      --uri "${uri}" --http-method POST \
      --oidc-service-account-email "${INVOKER_SA}" \
      --oidc-token-audience "${WORKER_URL}" \
      --attempt-deadline 320s
  else
    echo "scheduler ${name}: create"
    gcloud scheduler jobs create http "${name}" \
      --project "${PROJECT_ID}" --location "${REGION}" \
      --schedule "${schedule}" --time-zone "Asia/Tokyo" \
      --uri "${uri}" --http-method POST \
      --oidc-service-account-email "${INVOKER_SA}" \
      --oidc-token-audience "${WORKER_URL}" \
      --attempt-deadline 320s
  fi
}

# 削除期限スキャン（毎時）
create_scheduler deletion-scan "0 * * * *" "/v1/internal/jobs/deletion-scan"
# アップロード期限/整合性スキャン（15分毎）
create_scheduler upload-expiry-scan "*/15 * * * *" "/v1/internal/jobs/upload-expiry-scan"

echo "== done =="
