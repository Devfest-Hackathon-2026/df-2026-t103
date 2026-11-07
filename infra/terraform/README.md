# infra/terraform — クラウド基盤の Terraform 構成

これまで `gcloud` スクリプト＋宣言 YAML で整備してきた GCP 基盤（Issue #29/#31/#32/#35）を
Terraform（google provider v6）で宣言的に管理する版。IaC を Terraform に統一する場合の正本。

## 管理対象

| ファイル | リソース | 対応 Issue |
|---|---|---|
| `service_accounts.tf` | api-run / worker-run / github-deployer / jobs-invoker SA | #29/#31/#38 |
| `iam.tf` | 最小権限 IAM（project/bucket/SA actAs/run.invoker） | #29/#31 |
| `artifact_registry.tf` | Docker リポジトリ `api` | #29/#38 |
| `cloud_run.tf` | `api`（公開）/ `worker`（internal）サービス | #29/#31 |
| `secrets.tf` | Secret Manager の箱＋accessor IAM（**値は投入しない**） | #32 |
| `cloud_tasks.tf` | `ocr` / `delivery` / `deletion-retry` キュー | #31 |
| `cloud_scheduler.tf` | `deletion-scan` / `upload-expiry-scan` | #31 |
| `firestore.tf` | Firestore(Native/東京/PITR)＋日次バックアップ | #35 |

## 管理対象外（境界）

- **Firebase Hosting / Firestore・Storage rules / indexes** は `firebase.json` と
  CD（#38 `deploy-rules`/`deploy-hosting`）が管理する。Terraform では扱わない。
- **WIF プール/プロバイダ**は owner が別途作成し、`github-deployer` SA に
  `workloadIdentityUser` を紐付ける（#38）。
- **Secret の実値**は owner が投入（`infra/secret-manager/setup-secrets.sh` 相当）。
- コンテナ**イメージ**は CD が SHA 付きで差し替える（`image` は `ignore_changes`）。

## 使い方

```sh
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # project_id を実IDに
terraform init        # GCS backend を versions.tf で有効化（要バケット）
terraform plan
terraform apply       # owner 権限（IAM 付与を含むため owner/projectIamAdmin 必須）
```

検証のみ（provider 取得のみ、バックエンド不要）:

```sh
terraform fmt -recursive -check
terraform init -backend=false && terraform validate
```

## 注意

- **apply には owner 権限が必要**（IAM・SA 作成を含む。`roles/editor` では不可）。
- `project_id` は `.firebaserc` の `moshimoshimonshin` ではなく Firebase 実体
  （`project-7efcc4c4-...`）を確定して使う。
- `terraform.tfvars` と `*.tfstate` はコミットしない（`.gitignore` 済）。状態は GCS backend。
- 既存の `gcloud`/YAML 版（`infra/cloud-run/*.yaml`・`infra/*.sh`）は手動運用・参照用として残す。
  Terraform を正本にする場合は重複 apply を避けるため運用をどちらかに寄せること。
