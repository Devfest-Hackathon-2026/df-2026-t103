# infra/ — クラウド実行基盤の構成

本ディレクトリは Cloud Run / Cloud Tasks / Cloud Scheduler / Secret Manager などの
宣言的設定と、owner が実行するセットアップ手順を管理する。
参照: docs/02 §10・§11.2、ADR-0005、各 Issue（#29/#31/#32）。

> **適用範囲の注意**
> 本リポジトリの CI/CD で自動 apply されるのは Cloud Run への deploy（#38 CD）のみ。
> サービスアカウント作成と **IAM ロール付与は Project の `owner` / `resourcemanager.projectIamAdmin`
> 権限が必要**で、`roles/editor` では実施できない。以下の `gcloud` コマンドは
> 権限を持つ owner が初回に一度だけ実行する。
> `PROJECT_ID` は実プロジェクト（例: `project-7efcc4c4-6c86-490c-ba5`）に置換すること。
> `.firebaserc` の `moshimoshimonshin` とは別IDのため、デプロイ対象IDを確定してから実行する。

## cloud-run/service-api.yaml

患者/病院向け API（`services/api`, Fastify）の Cloud Run サービス定義。

| 設定 | 値 | 根拠 |
|---|---|---|
| region | asia-northeast1（東京） | docs/02 §10 |
| minScale | 0（初期） | §11.2 コスト最小化 |
| maxScale | 10 | 想定外負荷の相互影響を制限（§11.2） |
| containerConcurrency | 80 | I/O 主体のため既定より高め |
| timeoutSeconds | 300 | AI 問診チャット等の長め処理を考慮 |
| port | 8080 | `docker/api/Dockerfile` / `config.PORT` |
| CPU/メモリ | 1 vCPU / 512Mi | 初期値（負荷試験後に調整） |

適用:

```sh
gcloud run services replace infra/cloud-run/service-api.yaml \
  --project PROJECT_ID --region asia-northeast1
```

### 冷間起動対策（§11.2）

初期は `min-instances=0`。冷間起動が患者 UX に影響する場合に限り
`autoscaling.knative.dev/minScale` を 1 以上へ引き上げる。`startup-cpu-boost=true` を
有効化済みのため起動は速い側に倒している。Worker/施設向け/患者向けはサービス分割で
相互影響を制限する方針（本 PR は api のみ、Worker は #31）。

## サービスアカウントと最小権限 IAM（owner 実行）

### 1. ランタイム SA（Cloud Run が assume）

```sh
# 作成
gcloud iam service-accounts create api-run-sa \
  --project PROJECT_ID \
  --display-name "moshimoshimonshin API (Cloud Run runtime)"

SA="api-run-sa@PROJECT_ID.iam.gserviceaccount.com"

# 最小権限ロール（用途別）
# Firestore 読み書き
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member "serviceAccount:${SA}" --role roles/datastore.user
# Cloud Tasks への投入（OCR/削除など）
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member "serviceAccount:${SA}" --role roles/cloudtasks.enqueuer
# Secret Manager の値参照（できれば個別シークレット単位で付与、下記は最小の project 付与例）
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member "serviceAccount:${SA}" --role roles/secretmanager.secretAccessor

# Storage は対象バケット単位で付与（project 全体ではなくバケットに絞る）
gsutil iam ch "serviceAccount:${SA}:roles/storage.objectAdmin" \
  gs://PROJECT_ID.appspot.com
```

> Secret Manager は本番運用ではシークレット個別に `secretAccessor` を付与するのが望ましい:
> `gcloud secrets add-iam-policy-binding SERVER_HMAC_SECRET --member "serviceAccount:${SA}" --role roles/secretmanager.secretAccessor`

### 2. デプロイ SA（GitHub Actions / WIF が assume、#38 CD 用）

```sh
gcloud iam service-accounts create github-deployer \
  --project PROJECT_ID \
  --display-name "GitHub Actions deployer (WIF)"

DEP="github-deployer@PROJECT_ID.iam.gserviceaccount.com"

# Cloud Run へのデプロイ
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member "serviceAccount:${DEP}" --role roles/run.admin
# ランタイム SA を actAs（deploy 時に必要）
gcloud iam service-accounts add-iam-policy-binding api-run-sa@PROJECT_ID.iam.gserviceaccount.com \
  --project PROJECT_ID \
  --member "serviceAccount:${DEP}" --role roles/iam.serviceAccountUser
# Artifact Registry への push
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member "serviceAccount:${DEP}" --role roles/artifactregistry.writer
# Hosting / rules デプロイ
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member "serviceAccount:${DEP}" --role roles/firebasehosting.admin
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member "serviceAccount:${DEP}" --role roles/datastore.owner
```

WIF プールとプロバイダの作成、`github-deployer` への `workloadIdentityUser` 紐付けは
docs/02 §13.1-5 に従う。発行した provider / SA は GitHub の環境 Variables
（`GCP_WIF_PROVIDER` / `GCP_DEPLOY_SA`）へ設定する（#38 参照）。

## カスタムドメインのマッピング準備（`api.moshimoshimonshin.com`）

Cloud Run の直接ドメインマッピングは対応リージョンが限られるため、
東京リージョンでは **Firebase Hosting の rewrite→Cloud Run** もしくは
**外部 HTTPS LB + serverless NEG** のいずれかを採る（docs/02 §2.2）。

- 簡易: Firebase Hosting の `rewrites` で `api.*` を Cloud Run サービスへ向ける
- 本格: HTTPS LB + Cloud Armor（WAF 必要時、別料金・別構成 §10 / [S07]）

DNS（`api` A/AAAA もしくは LB IP、証明書）の設定は DNS 管理者の作業。

## Artifact Registry（イメージ格納先、owner 実行）

```sh
gcloud artifacts repositories create api \
  --project PROJECT_ID --location asia-northeast1 \
  --repository-format docker \
  --description "moshimoshimonshin API container images"
```

## 非同期ジョブ基盤（Issue #31）

OCR・医療機関への送信・退会削除・期限/整合性スキャンを支える
Cloud Tasks / Cloud Scheduler / 非公開 Worker の構成。docs/02 §9/§10・docs/04 §10・
ADR-0005/0009/0011 準拠。

### cloud-run/service-worker.yaml

Scheduler/Tasks から OIDC で呼ばれる**非公開（ingress=internal）Worker サービス**。
api と同一イメージだがサービスを分割して相互影響を抑える（§11.2）。内部エンドポイント:

| エンドポイント | 起動元 | 用途 |
|---|---|---|
| `POST /v1/internal/jobs/deletion-scan` | Scheduler | 削除期限スキャン |
| `POST /v1/internal/jobs/upload-expiry-scan` | Scheduler | アップロード期限/整合性スキャン |
| `POST /v1/internal/jobs/deletion-jobs/:id/run` | Tasks | 削除ジョブ実行 |
| `POST /v1/internal/jobs/ocr/:id/run` | Tasks | OCR 実行 |

```sh
gcloud run services replace infra/cloud-run/service-worker.yaml \
  --project PROJECT_ID --region asia-northeast1
```

### Cloud Tasks キュー / Cloud Scheduler ジョブ

`infra/setup-async-jobs.sh` が冪等に作成する。

| キュー | maxAttempts | 並行 | 用途 |
|---|---|---|---|
| `ocr` | 5 | 10 | OCR 実行（費用敏感・並行度低め） |
| `delivery` | 8 | 20 | 医療機関への送信/通知（at-least-once、ワーカーで冪等化） |
| `deletion-retry` | 5 | 10 | 削除ジョブのリトライ |

> **DLQ 相当**: Cloud Tasks に専用 DLQ はないため `maxAttempts` で打ち切り、
> 打ち切り後は Firestore 側の failed ジョブ記録で失敗管理（ADR-0009）。

| Scheduler ジョブ | cron（Asia/Tokyo） | ターゲット |
|---|---|---|
| `deletion-scan` | `0 * * * *`（毎時） | `/v1/internal/jobs/deletion-scan` |
| `upload-expiry-scan` | `*/15 * * * *`（15分毎） | `/v1/internal/jobs/upload-expiry-scan` |

> **重複実行制御**: Scheduler は 1 発火だが、二重処理はワーカー側のリース/冪等
> （ADR-0009/0011）で防ぐ。

```sh
# worker デプロイ後、worker の URL を調べて実行
WORKER_URL=$(gcloud run services describe worker --project PROJECT_ID \
  --region asia-northeast1 --format 'value(status.url)')
PROJECT_ID=PROJECT_ID WORKER_URL="$WORKER_URL" \
  INVOKER_SA=jobs-invoker@PROJECT_ID.iam.gserviceaccount.com \
  ./infra/setup-async-jobs.sh
```

### OIDC 呼び出し SA と IAM（owner 実施）

```sh
gcloud iam service-accounts create jobs-invoker \
  --project PROJECT_ID --display-name "Scheduler/Tasks OIDC invoker"

INV="jobs-invoker@PROJECT_ID.iam.gserviceaccount.com"

# worker サービスを呼べるように run.invoker を付与
gcloud run services add-iam-policy-binding worker \
  --project PROJECT_ID --region asia-northeast1 \
  --member "serviceAccount:${INV}" --role roles/run.invoker

# Worker ランタイム SA（worker-run-sa）は api-run-sa と同等の最小権限を付与
# （datastore.user / cloudtasks.enqueuer / secretmanager.secretAccessor /
#   バケット単位 storage.objectAdmin）。上記「ランタイム SA」節と同手順。
```

