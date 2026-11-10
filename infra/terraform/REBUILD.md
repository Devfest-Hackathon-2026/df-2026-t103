# 単一プロジェクトの初期構築と既存環境の引継ぎ（#28）

[ADR-0021](../../docs/adr/0021_単一プロジェクトのIaC管理方針.md) の実行手順。
全操作は `project-7efcc4c4-6c86-490c-ba5` を対象とする。別のdev/stg/prod projectを作らない。
既存資源のある現環境では「既存環境の引継ぎ」を先に実施し、新規作成手順を一括再実行しない。

## 1. 作業前の準備と管理境界

Terraform >=1.6、gcloud/Firebase CLI、対象projectへのADC、既存stateの管理者、レビュー担当者を用意する。
必要権限はSA/IAM・各サービス・state bucketの管理対象に合わせて付与し、Ownerを一律配布しない。
実在する運用グループが未準備なら `operator_groups` の既定空集合を維持する。

```sh
cd infra/terraform
export TF_VAR_project_id="project-7efcc4c4-6c86-490c-ba5"
gcloud projects describe "$TF_VAR_project_id" --format='value(lifecycleState)'
gcloud services list --enabled --project "$TF_VAR_project_id" --format='value(config.name)'
gcloud auth application-default login --project "$TF_VAR_project_id"
gcloud auth application-default set-quota-project "$TF_VAR_project_id"
cp -n terraform.tfvars.example terraform.tfvars
```

project/API有効化は#27、Authは#34、App Checkは[専用手順](../app-check/README.md)、RTDBは[Storage/RTDB手順](../storage/README.md)に従う。
必要なFirestore/Storage/Run/Tasks/Scheduler/Secret Manager/Artifact Registry/IAM/Logging/Monitoring等のAPIを先に有効化する。
Firebase登録・東京Firestore・シンガポールRTDBの状態を確認する。実値や個人情報は作業ログへ出さない。

## 2. クラウドを変更しない構文検証

bootstrap用backendファイルがないclean checkoutで実行する。

```sh
export TF_VAR_project_id="project-7efcc4c4-6c86-490c-ba5"
terraform init -backend=false -input=false -lockfile=readonly
terraform validate
```

この検証は資源の実在、権限、planの妥当性、デプロイ成功を保証しない。provider取得にはネットワークが必要。

## 3. Remote stateの準備

最初に既存管理者へstateの場所とprefixを確認する。以下はstateがまだない場合だけのbootstrap例。
state bucketはこのtf moduleの外で管理し、アプリ画像bucketへstateを混在させない。

```sh
export TF_VAR_project_id="project-7efcc4c4-6c86-490c-ba5"
gcloud storage buckets create "gs://${TF_VAR_project_id}-tfstate" \
  --project "$TF_VAR_project_id" --location asia-northeast1 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://${TF_VAR_project_id}-tfstate" \
  --project "$TF_VAR_project_id" --versioning
cp -n backend.tf.example backend.local.tf
```

`backend.local.tf` のbucket/prefixを、確認済みのstate所有者の値へ合わせる。versions.tfのコメントを別途有効化してbackendを二重定義しない。
bucket/object管理権限は実際のTerraform実行者だけに付与する。資格情報をbackend設定へ書かない。

```sh
export TF_VAR_project_id="project-7efcc4c4-6c86-490c-ba5"
terraform init -input=false -lockfile=readonly
terraform workspace show
terraform state list
```

既存local/remote stateの移行を求められた場合は、管理者が移行元/先を確認し、保護したバックアップを確保して対話的に移行する。
`-force-copy` や既存stateを無視する `-reconfigure` を定型手順にしない。同じ資源を別stateで二重管理しない。

## 4. 既存環境の引継ぎ

1. state listと実資源一覧を比較し、tf管理対象全件の「既にstateにある / 未import / 未作成 / 管理外」を台帳へ記録する。
2. 既にstateにある資源を再importしない。未importの既存資源を、provider v6の該当resourceのImport節に従って一件ずつ対応付ける。
3. 代表例は次のとおり。SA名、region、bucket、Firestore名が実体と一致することを先に確認する。

```sh
export TF_VAR_project_id="project-7efcc4c4-6c86-490c-ba5"
terraform import google_service_account.api_run \
  "projects/${TF_VAR_project_id}/serviceAccounts/api-run-sa@${TF_VAR_project_id}.iam.gserviceaccount.com"
terraform import google_artifact_registry_repository.api \
  "projects/${TF_VAR_project_id}/locations/asia-northeast1/repositories/api"
terraform import google_firestore_database.default \
  "projects/${TF_VAR_project_id}/databases/(default)"
terraform import 'google_storage_bucket.patient_uploads[0]' \
  "${TF_VAR_project_id}-patient-uploads"
terraform import google_cloud_run_v2_service.api \
  "projects/${TF_VAR_project_id}/locations/asia-northeast1/services/api"
```

Storageの例は `storage_bucket=""` でtf管理bucketを使う場合だけ。外部管理bucketを指定してcount=0ならimportしない。
残りのworker/SA、IAM、Secret、Tasks、Scheduler、バックアップ、監査資源も同様に台帳と照合する。上の5件だけで全資源を引き継げたとはみなさない。
importはstateへの登録でありコード生成や安全な差分の保証ではない。実体とコードの不一致は次のplanで確認する。

## 5. 未作成資源がある場合の構築順序

1. 対象project/API/Firebase登録、remote stateを準備する。
2. `terraform.tfvars` のproject、region、初期イメージの不変SHA/digest、確認済みCORS originを設定する。既定の `PROJECT_ID/...:latest` は実イメージではない。
3. 未作成の場合だけArtifact RegistryとSecretの箱を先に構築する。初回Cloud Runには実イメージとSecret versionが必要なため、この段階だけ限定planを使う。

```sh
export TF_VAR_project_id="project-7efcc4c4-6c86-490c-ba5"
terraform plan -target=google_artifact_registry_repository.api \
  -target=google_secret_manager_secret.secrets -out=bootstrap.tfplan
terraform show bootstrap.tfplan
terraform apply bootstrap.tfplan
```

4. [Secret Manager手順](../secret-manager/README.md)で承認済みの実値を投入する。秘密値はtfvarsやコマンド出力へ入れない。
5. [CD](../../.github/workflows/cd.yaml)と同じDocker build定義からAPIイメージを作成してArtifact Registryへpushし、その不変参照を `api_image` へ設定する。
6. 以下の全体planへ戻る。target適用だけで構築完了としない。

## 6. 全体plan・レビュー・apply・受入

```sh
export TF_VAR_project_id="project-7efcc4c4-6c86-490c-ba5"
terraform plan -out=reviewed.tfplan
terraform show reviewed.tfplan
# 構成差分とplanのレビュー完了後、同じ保存planを適用
terraform apply reviewed.tfplan
terraform plan -detailed-exitcode
```

`show`やplanファイルは機密情報を含み得る。公開Issue/PRへ貼らず、限定共有で確認する。
削除/置換、IAM拡大、監査保持短縮、Storage lifecycle、Firestore/リージョン変更、CDとのimage管理境界を重点確認する。
plan終了コードは0=差分なし、1=エラー、2=差分あり。2を成功済みと取り違えない。

Terraform外のRules/indexes/Hosting・WIFはそれぞれのrunbook/CDで整備する。
Cloud RunのReady、Tasks/Scheduler、Secret参照、Firestore PITR/バックアップ、Storageと監査設定を読み取り確認し、合成データだけでAuth/App Check付きAPI受入を実施する。
各確認はprojectを明示し、結果を対応Issueへ記録する。権限不足や未登録プロバイダを成功扱いにしない。

## 7. 差分管理と復旧

構成変更はPRでレビューし、provider変更時だけlockfile更新を同じPRへ含める。通常のinitで無断upgradeしない。
apply失敗時は原因と部分適用を調べ、全体planから再開する。`destroy`やstateの削除でやり直さない。
state破損・誤移行は変更を止め、管理者がGCS object version等の保護したバックアップと実資源を照合して復旧する。
Secret値や患者データをTerraformで巻き戻さない。
