#!/usr/bin/env bash
# =============================================================================
# Secret Manager セットアップ — Issue #32 / NFR-12・docs/07 §4・ADR-0002
#
# 本番で使う秘密情報を GCP Secret Manager に作成・バージョニングし、
# ランタイム SA（api-run-sa / worker-run-sa）にのみ読取 IAM を付与する。
#
# 重要:
#   - このスクリプトに秘密の実値は書かない。実値は環境変数 or 対話入力で渡す。
#   - 生成可能なもの（HMAC/トークン）は未指定なら openssl で安全乱数を生成する。
#   - 外部 API キー（Places / Vertex AI）は owner が実値を用意する。
#   - orchestrator 指示によりプロジェクトは単一（stg/prod の区別なし）。
#   - IAM 付与は Project の owner/projectIamAdmin 権限が必要（roles/editor では不可）。
#
# 使い方（値は環境変数で渡す。未指定の生成系は自動生成）:
#   PROJECT_ID=project-7efcc4c4-6c86-490c-ba5 \
#   GOOGLE_PLACES_API_KEY=xxxx VERTEX_AI_API_KEY=yyyy \
#   ./infra/secret-manager/setup-secrets.sh
# =============================================================================
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?PROJECT_ID を設定してください}"
RUNTIME_SAS=(
  "api-run-sa@${PROJECT_ID}.iam.gserviceaccount.com"
  "worker-run-sa@${PROJECT_ID}.iam.gserviceaccount.com"
)

# 秘密を作成（なければ）し、新バージョンを追加する。
# $1=シークレット名 $2=値
put_secret() {
  local name="$1" value="$2"
  if [ -z "${value}" ]; then
    echo "skip ${name}: 値が空（owner が実値を用意して再実行）"
    return 0
  fi
  if ! gcloud secrets describe "${name}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "create secret ${name}"
    gcloud secrets create "${name}" \
      --project "${PROJECT_ID}" \
      --replication-policy user-managed --locations asia-northeast1
  fi
  printf '%s' "${value}" | gcloud secrets versions add "${name}" \
    --project "${PROJECT_ID}" --data-file=-
  echo "added version to ${name}"

  # ランタイム SA にのみ読取（secretAccessor）を付与。
  for sa in "${RUNTIME_SAS[@]}"; do
    gcloud secrets add-iam-policy-binding "${name}" \
      --project "${PROJECT_ID}" \
      --member "serviceAccount:${sa}" \
      --role roles/secretmanager.secretAccessor >/dev/null
  done
  echo "granted secretAccessor on ${name} to runtime SAs"
}

# --- 生成可能な秘密（未指定なら安全乱数を生成）---
SERVER_HMAC_SECRET="${SERVER_HMAC_SECRET:-$(openssl rand -base64 48)}"
INTERNAL_JOB_TOKEN="${INTERNAL_JOB_TOKEN:-$(openssl rand -hex 32)}"

# --- 外部調達の秘密（owner が実値を用意。未指定ならスキップ）---
GOOGLE_PLACES_API_KEY="${GOOGLE_PLACES_API_KEY:-}"
VERTEX_AI_API_KEY="${VERTEX_AI_API_KEY:-}"

put_secret SERVER_HMAC_SECRET   "${SERVER_HMAC_SECRET}"
put_secret INTERNAL_JOB_TOKEN   "${INTERNAL_JOB_TOKEN}"
put_secret GOOGLE_PLACES_API_KEY "${GOOGLE_PLACES_API_KEY}"
put_secret VERTEX_AI_API_KEY     "${VERTEX_AI_API_KEY}"

echo "== done =="
echo "Cloud Run へは service-api.yaml / service-worker.yaml の secretKeyRef（env 注入）で参照される。"
