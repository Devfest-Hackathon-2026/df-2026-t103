# 病院ポータル専用Terraform root

対象は `project-7efcc4c4-6c86-490c-ba5` / 東京のみ。
既存API/worker等のstateを再作成・import・変更せず、未作成と確認した病院サービス、
専用SA、そのSAへのdeployer actAs、公開HTTP invokerの4資源だけを管理する。
既存Firestore/Secret/患者情報への権限は付けない。min0/max2、CPU1、512MiB。
予算上限の保証ではない。停止・rollbackは既存revisionへのtraffic変更を使用する。

## 境界

旧 `infra/terraform/hospital.tf` から宣言を除去し、病院はこのrootだけが管理する。
移行前にCloud Run hospitalとhospital-run-saが未作成であることを明示project/regionで確認する。
存在する場合はこの手順を止め、所有stateを調べる。別stateでの再importや二重管理は禁止。
既存stateにこれらが記録されている場合も、所有者が移行手順を確認するまで適用しない。
古いcheckoutのhospital_imageを有効にして同じ資源を管理しない。

## 初回構築

1. Webアプリ、実origin限定Enterprise site key、Auth domain、App Checkを登録する。
   originはCloud Runの[決定的URL](https://docs.cloud.google.com/run/docs/triggering/https-request)
   `https://hospital-PROJECT_NUMBER.asia-northeast1.run.app` を使用できる。
2. 専用state bucketをbootstrapする。既存bucketなら新規作成を繰り返さず所有と用途を確認する。
   アプリbucketと混在させず、uniform access/public access prevention/versioningを設定する。
3. 同じ公開クライアント設定で [Dockerfile](../../docker/hospital/Dockerfile) のprod imageを作成し、
   Artifact Registryへ不変tag/digestでpush。keyは公開クライアント用でありSA資格情報を渡さない。
4. `terraform.tfvars` にproject_id、hospital_image、hospital_client_config、既存deployer_sa_emailを設定。
   stateとtfvars/planはGitへ入れない。認証情報をprovider/backendへ記述しない。

```sh
terraform init -input=false -lockfile=readonly \
  -backend-config=bucket=CONFIRMED_HOSPITAL_STATE_BUCKET \
  -backend-config=prefix=hospital
terraform fmt -check
terraform validate
terraform plan -out=reviewed.tfplan
# 非公開のplanを確認。4資源のcreateのみで、既存資源の変更/削除がないことを照合
terraform apply reviewed.tfplan
terraform plan -detailed-exitcode
```

クラウド変更なしの構文検証はclean directoryで `terraform init -backend=false` → `validate`。
初回apply後の変更もこのstateを使う。イメージの以後の差替えはcd-hospitalに任せる。
公開/login HTTP、CSP/no-store、実App Check、所属認可、Secure Cookie、logoutを検証する。
実患者情報を投入せず、合成アカウント/合成データだけで受入する。

旧API/workerなどのstate所在・引継ぎは独立した残作業であり、このrootのapplyで解決しない。
