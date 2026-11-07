# Storage / RTDB の単一プロジェクト設定（Issue #36）

対象は `project-7efcc4c4-6c86-490c-ba5` のみ。
render_config.py は設定JSONの生成専用。2026-11-07のPO委任に基づく初期設定は下記。
既存 `.firebaserc` の別project/Hosting targetを流用しない。

## 適用前に確定する値

- 患者Webの公開HTTPS origin（scheme/host/portのみ、パスや末尾`/`なし）。
  病院ポータルは画像アップロード主体ではないため自動追加しない。
- 画像の承認済み通常保管日数、実稼働APIの `UPLOAD_DOC_TTL_DAYS`。
  API既定30日は法務承認済み保存期間を意味しない（docs/01 FR-M06、docs/04 §10.1）。
- 東京の画像専用bucket名、シンガポールのRTDB instance名、実際のAPI runtime SA。
- soft delete / versioning / retention policy / hold / バックアップの扱い。
  ライフサイクル削除が即時・完全消去を保証するとは案内しない。

保管日数・origin未確定の状態で設定を適用しない。既存データへ削除ルールを追加する
場合は対象prefixの用途、保管契約、hold等を先に確認する。

## 設定案の生成

`render_config.py` は標準Pythonのみを使用し、ネットワーク・GCP・ファイル変更は行わない。
明示入力がなければ失敗する。以下の値は実際の承認済み値を指定する。

```sh
python3 infra/storage/render_config.py \
  --origin "$PATIENT_ORIGIN" \
  --retention-days "$APPROVED_IMAGE_DAYS" \
  --upload-doc-ttl-days "$UPLOAD_DOC_TTL_DAYS" > /tmp/mmr-storage-proposal.json
jq '.cors' /tmp/mmr-storage-proposal.json > /tmp/mmr-cors.json
jq '.lifecycle' /tmp/mmr-storage-proposal.json > /tmp/mmr-lifecycle.json
```

出力のDelete対象は `services/api/src/domain/uploads.ts` の現行保存パス
`patient-uploads/` のみ。他prefixの問診票・監査資産へ広げない。
日数は実APIのupload TTLより大きくなければ生成を拒否する。
これは期限内画像の早期削除を避ける下限検査であり、入力値の業務承認や
稼働環境との一致をツールが検証するものではない。

CORSは本番V4署名URLのPUTと `Content-Type` / `x-goog-if-generation-match`
に限定する（ADR-0008、services/api/src/storage.ts）。OPTIONSはサービス側が処理する。
CORSは認証・認可ではない。署名URL自体は公開しない。

## 実環境の作成と検証（未実施）

```sh
gcloud storage buckets list --project project-7efcc4c4-6c86-490c-ba5
firebase database:instances:list --project project-7efcc4c4-6c86-490c-ba5
```

新しい画像専用bucketを作る場合:

```sh
gcloud storage buckets create "gs://$IMAGE_BUCKET" \
  --project project-7efcc4c4-6c86-490c-ba5 --location asia-northeast1 \
  --uniform-bucket-level-access --public-access-prevention
```

既存bucketならproject番号・locationを照合する。場所違いのbucketを自動削除・移動しない。
生成した案のレビュー後、CORS / lifecycleを適用する:

```sh
gcloud storage buckets describe "gs://$IMAGE_BUCKET" \
  --project project-7efcc4c4-6c86-490c-ba5 --format=json > /tmp/mmr-bucket-before.json
gcloud storage buckets update "gs://$IMAGE_BUCKET" \
  --project project-7efcc4c4-6c86-490c-ba5 \
  --cors-file=/tmp/mmr-cors.json --lifecycle-file=/tmp/mmr-lifecycle.json
gcloud storage buckets describe "gs://$IMAGE_BUCKET" \
  --project project-7efcc4c4-6c86-490c-ba5 --format=json
```

設定更新は既存CORS/lifecycle全体の置換となるため、共有bucketの別用途の設定を
消さない。保存したbeforeから以前のCORS/lifecycleだけを別JSONへ抽出して戻せるが、
既に削除済みのオブジェクトは設定ロールバックで戻らない。

bucket IAMにallUsers/allAuthenticatedUsersを付けない。runtime SAだけに画像の
必要なオブジェクト操作をbucket単位で付与し、V4署名には署名SAのsignBlob権限を
別途確認する。Firebase Client直接アクセスは `firebase/storage.rules` のdeny-allを維持。
Firebase Storageとしてのbucket登録とRulesの適用先を確認するまで、既定bucketを
推測した `firebase deploy --only storage` は実行しない。

RTDBの最初のdefault instanceはFirebase consoleで**対象projectを明示し**、
`asia-southeast1`を選択して作成する。既存defaultがある場合の追加instanceは
`firebase database:instances:create "$RTDB_INSTANCE" --location asia-southeast1
--project project-7efcc4c4-6c86-490c-ba5` を使用できる。
CLIのlocation省略時は米国になるため省略しない。

Rules適用時は一時configに `database.instance` と `rules` の絶対パスを明示し、
`firebase deploy --config <そのconfig> --only database
--project project-7efcc4c4-6c86-490c-ba5` で対象instanceへ限定する。
既存Rules `firebase/database.rules.json` は公開稼働状態だけread許可しclient writeは拒否。
Admin SDKはRulesを迂回するため、サーバの書込みも別途レビューする。

## 受入確認

- bucketが対象project・東京・uniformアクセス・public access prevention enforced。
  bucket IAMとproject継承権限を確認し、無認証の画像read/writeが拒否される。
- 合成画像で実APIが発行したURLへ許可originのPUT成功、同じURLへの再PUTは412。
  URL期限切れ拒否、許可外originのブラウザ読書き拒否。秘密URLはログへ残さない。
- 実機ブラウザからpreflight含め確認。Emulatorはgeneration条件を無視し得るため、
  Emulator成功を本番の署名URL検証に代用しない。
- RTDBがシンガポールであること、client write全拒否、非公開path read拒否、
  公開pathにuid/施設ID/症状/患者別ジョブIDがないこと。
- lifecycle / API TTL / soft delete / backupsの実値を記録し、合成資産の削除挙動を確認。

RTDBの越境は docs/02 §3 と docs/04 §6 に従い**個人と結びつかない全体稼働状態のみ**。
患者別OCR進捗はAPIポーリングを使う。個人情報をRTDBへ追加する場合は、
越境データ移転の再審査・契約・要件改訂が必要。Issue本文の「ADR-003」は
実リポジトリではGitHubテンプレートのADRのため、この用途の根拠にはしない。

## ローカル検証

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/storage -p 'test_*.py' -v
```

## 公式資料

- [bucket作成](https://docs.cloud.google.com/sdk/gcloud/reference/storage/buckets/create)
- [CORS設定](https://docs.cloud.google.com/storage/docs/cors-configurations)
- [世代前提条件](https://docs.cloud.google.com/storage/docs/request-preconditions)
- [Firebase CLI / RTDB](https://firebase.google.com/docs/cli)
- [public access prevention](https://docs.cloud.google.com/storage/docs/public-access-prevention)

## 世代指定削除の安全性

`services/api/src/storage.ts` は呼び出し元が世代番号を指定した削除に、
SDKの `preconditionOpts.ifGenerationMatch` を付与する。世代番号は精度を
失わないよう文字列のまま渡す。対象が置換されていれば412を呼び出し元へ返し、
存在しない場合は従来通り成功扱いにする。退会ワーカーは412等の失敗対象を
pendingStorageObjectsへ残す（`services/api/src/workers/deletionJob.ts`）。

ローカル回帰テストは実SDKからloopback HTTP fixtureへ送るDELETEを検証し、
GCS/実患者資産は使わない。Emulatorが世代条件を無視する可能性があるため、
実GCSでの世代競合試験は上記受入確認に引き続き必要。

## 2026-11-07 初期運用値（POから選定・反映を委任）

- origin: `https://project-7efcc4c4-6c86-490c-ba5.web.app`。Firebase Hosting APIで実在確認したdefault site。カスタムドメインを推測しない。
- bucket: `project-7efcc4c4-6c86-490c-ba5-patient-uploads`（東京、画像専用）。
- API upload TTL: 既存値30日を維持し、TerraformのAPI/workerへ明示。
- lifecycle: `patient-uploads/` のみ31日で削除対象。期限内アップロードを消さない1日の余裕。法定保存期間の主張ではない。
- soft delete: 7日。通常read不能な復旧用コピーが残るため即時完全消去とは案内しない。lifecycle処理は非同期であり38日を厳密な消去期限と保証しない。
- versioning無効、retention lock/holdなし、public access prevention enforced、uniform access、force_destroy=false、prevent_destroy=true。
- 別の既存bucketを変数で指定した場合は新規bucketリソースを作成せず、そのbucketのCORS/lifecycleも自動変更しない。

Cloud Runサービスは読み取り時点で0件のため、実API発行URLによる受入試験はデプロイ後に行う。
初回にCLIで作成したbucketをTerraformへ移管する場合は、共有backend初期化後に
`terraform import -var='project_id=project-7efcc4c4-6c86-490c-ba5' 'google_storage_bucket.patient_uploads[0]' project-7efcc4c4-6c86-490c-ba5-patient-uploads`
で取り込み、planで再作成/削除がないことを確認する。

## 稼働APIとの接続整合性（#36）

API/worker の `FIREBASE_STORAGE_BUCKET` は上記 `-patient-uploads`、
`UPLOAD_DOC_TTL_DAYS=30`、`DATABASE_URL` は実在する
`https://project-7efcc4c4-6c86-490c-ba5-status.asia-southeast1.firebasedatabase.app`
へ揃える。Terraformの `cors_origins` 未指定時は患者Hosting originを使う。
既存の `-app` bucketを削除・移行せず、新規uploadの接続先のみを揃える。
既存uploadがある環境の切替は、bucket名を含まない既存参照への影響を確認してから行う。
初回構築直後に旧bucketのlive objectが0件であることを確認して切替える。

RTDBのstatus instanceとdeny-by-default Rulesは実適用済み。
Cloud Runへ環境変数を反映してもApp CheckやFirebase Authの要件は緩和しない。
実API発行URLを使う受入には、正規のテスト利用者・App Check付きクライアントが必要。

Cloud Runの予約変数 `PORT` はTerraformから指定しない。
[Cloud Run環境変数](https://docs.cloud.google.com/run/docs/configuring/services/environment-variables)と
[RTDB Admin SDKの接続先](https://firebase.google.com/docs/database/admin/start)を参照。
