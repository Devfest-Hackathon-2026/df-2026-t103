# infra/terraform — クラウド基盤の Terraform 構成

これまで `gcloud` スクリプト＋宣言 YAML で整備してきた GCP 基盤（Issue #29/#31/#32/#35）を
Terraform（google provider v6）で宣言的に管理する版。採用判断と境界は [ADR-0021](../../docs/adr/0021_単一プロジェクトのIaC管理方針.md)、初期構築・既存環境の引継ぎは [REBUILD.md](REBUILD.md) を参照。ADRはPR承認で確定する。

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

実環境の操作は [REBUILD.md](REBUILD.md) の順序で行う。対象は単一project
`project-7efcc4c4-6c86-490c-ba5`。既存資源とstateの照合・importを先に行い、
未作成の場合だけbootstrapする。既定の初期imageをそのままapplyしない。

クラウドを変更しない検証（clean checkout、backend.local.tfなし）:

```sh
export TF_VAR_project_id="project-7efcc4c4-6c86-490c-ba5"
terraform init -backend=false -input=false -lockfile=readonly
terraform validate
```

remote stateの設定は `backend.tf.example` をローカルの `backend.local.tf` へコピーし、
既存管理者へ確認したbucket/prefixを指定する。認証情報、state、保存planはコミットしない。

## 注意

- **apply には管理対象ごとの権限が必要**。IAM・SA作成を含むためEditorだけでは不足する。必要権限を管理者が付与し、Ownerの一律配布はしない。
- `project_id` は `.firebaserc` の `moshimoshimonshin` ではなく Firebase 実体
  （`project-7efcc4c4-...`）を確定して使う。
- `terraform.tfvars` と `*.tfstate` はコミットしない（`.gitignore` 済）。状態は GCS backend。
- 既存の `gcloud`/YAML 版（`infra/cloud-run/*.yaml`・`infra/*.sh`）は手動運用・参照用として残す。
  管理対象資源はTerraformを正本とし、同じ資源へ手動gcloud/YAMLを並行適用しない（ADR-0021）。

## 病院ポータルの独立管理

未作成の病院runtimeは [専用root](../hospital/README.md) と別stateで管理する。
このrootの不明な既存stateを作り直して病院を追加しない。病院の資源宣言はこのrootから除去済み。

## Vertex OAuth移行

APIだけが実行SAのADCから短命トークンを取得する。`iam.tf`の`api_vertex`は
指定単一projectでAPI SAへ`roles/aiplatform.user`を付与し、worker/deployerへは追加しない。
`cloud_run.tf`と参照YAMLから旧キーenvを除く。`secrets.tf`は旧キーのruntime Accessorを
除去するが、`locals.tf`の旧Secret箱は維持するため既存versionは破壊しない。

既存stateへ通常planを実行し、Vertex role追加、API/worker env更新、旧キーAccessor削除
以外の差分があれば原因を確認する。既存資源の削除・state再作成・一括IAM置換はしない。
レビュー承認後のapplyとAPI配信が完了したら、合成入力で実LLM由来の質問生成を確認する。
モデル・地域・AI承認フラグの変更をこの移行へ混ぜない。認証エラーや404だけで原因を断定しない。
