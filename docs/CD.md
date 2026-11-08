# CI/CD運用

GCPは `project-7efcc4c4-6c86-490c-ba5` 一つを使う。GitHub Environment名の
`stg` / `prod` は既存の承認・Variables設定のラベルで、別GCPプロジェクトではない。

## API / Rules

`cd.yaml` はmain pushの `ci` / `hospital-ci` / `patient-ci` / `security` /
`storage-config` の完了イベントを受け、**同じmain SHAの全5系統が成功した場合だけ**配信する。
古いSHA、PR/forkの実行、未完了・失敗・skippedは配信を許可しない。
各checkoutとイメージタグはゲートが検証したSHAを使い、Cloud Runのトラフィックも
その実行で作成したリビジョン名へ切り替える。
手動deployもmainと同じCI条件が必要。明示的なrollbackは既存リビジョンへ戻す操作なので
CI障害時にも使える。Environmentの承認ゲートはどちらも維持する。

必要なEnvironment Variables: `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`,
`GCP_DEPLOY_SA`, `GCP_AR_REPO`, `RUN_SERVICE_API`。
WIFは長寿命SAキーを使わない。authステップでaccess token取得まで検証し、
資格情報ファイル生成だけの成功と区別する。
認証の403が出たら、provider条件とSAの `roles/iam.workloadIdentityUser` bindingが
現在のGitHubリポジトリ名に一致するか確認する。リポジトリ移転時は両方の更新が必要。

この自動CDの配信範囲はAPI・Firestore/Storage/RTDB Rules・Firestore indexes。
Webを配信したという意味ではない。通知の各結果と配信範囲を確認する。

## 病院ポータル

Cookieセッション・BFF・リクエストごとのnonce CSPを維持するため、静的exportではなく
Next.js standaloneサーバーをCloud Runで動かす。`docker/hospital/Dockerfile` は
型検査がimportするAPI側の依存もインストールする。実行イメージにはstandalone出力と
static/publicアセットだけをコピーし、非rootユーザーでPORT=8080にlistenする。

配信元はCloud RunのHTTPS originを直接使う。既存 `firebase.json` のhospital targetは
このサーバーの配信経路ではなく、`apps/hospital/out` を生成・deployしない。
Firebase Hosting→Cloud Runのrewriteだけでは現行方式に移行できない。
Hostingが転送するCookieは `__session` に限られ、現在のセッション・App Check・施設Cookieが
落ちるためである。[FirebaseのCookie仕様](https://firebase.google.com/docs/hosting/manage-cache#using_cookies)
将来カスタムドメインを接続する場合も全CookieとNext生成ヘッダを保持する構成を選ぶ。

これは設計書の旧「Hosting＋動的Cloud Run」案から、承認済みCookie/BFF方式
（ADR-0024）に合わせた変更。認証を弱めたりCookieを統合・改名したりしない。
Cloud RunのallUsers invokerはログイン画面へのHTTPアクセス用であり、業務データは
従来どおりAPIのAuth/App Check/施設所属によって認可される。

### 初回構築

1. 対象プロジェクトにFirebase Webアプリを登録し、Authのauthorized domainsと
   App Check（Enterpriseプロバイダ）に実際のCloud Run originを登録する。
   debug tokenやEmulatorを公開環境の代わりに使わない。
2. GitHub `stg` Environmentに `RUN_SERVICE_HOSPITAL=hospital` と以下の公開クライアント
   Variablesを登録する。`NEXT_PUBLIC_FIREBASE_PROJECT_ID` はworkflowが指定プロジェクトIDを供給する。

   | Variable | 値の意味 |
   |---|---|
   | `NEXT_PUBLIC_API_BASE_URL` | 実際のHTTPS API origin + `/v1` |
   | `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase WebクライアントAPI key |
   | `NEXT_PUBLIC_FIREBASE_APP_ID` | 登録したWeb app ID |
   | `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | 登録したAuth domain |
   | `NEXT_PUBLIC_APP_CHECK_SITE_KEY` | 登録したEnterprise site key |

3. 同じ公開値をbuild argsに渡してhospital `prod` imageをbuild/pushする。
   `infra/terraform/hospital.tf` の `hospital_image` にその初期イメージを、
   `hospital_client_config` に同じ公開値を指定し、既存stateを使ってplanを確認して適用する。
   他資源の未importや破壊的差分があるplanは適用しない（ADR-0021）。
   runtime SAは専用 `hospital-run-sa` とし、FirestoreやSecretへの権限は付けない。
   min=0 / max=2、1CPU / 512MiBで、初期はリクエストに応じた課金となる。
   `hospital_image=null` の既定値では何も新設しない。
4. mainのCIが成功してから `cd-hospital` をmainに対して手動起動する。
   必須値・本番接続設定を検証し、不足時はクラウドへの書込み前に失敗する。
   サービス設定はTerraform、以後のイメージ差替えはCDが管理する。
   build時の公開値とTerraformのruntime値は必ず一致させる。
5. `/login` のHTTP確認に加え、合成アカウントでAuth/App Check・BFF・施設所属・
   サインアウトを実環境で確認する。単なるbuild/HTTP 200を認証受入とみなさない。

rollbackは確認済みのhospitalリビジョンを `gcloud run services update-traffic hospital
--project project-7efcc4c4-6c86-490c-ba5 --region asia-northeast1
--to-revisions <revision>=100` で指定する。API用rollbackとは対象が違う。

2026-11-08の読取時点ではこのプロジェクトのFirebase app一覧は空で、hospitalサービスも
未作成。この初回構築と実認証受入は未完了。CDの修正だけでWeb利用可能とは扱わない。

## 患者Web

現行 `apps/patient/lib/main.dart` は `initializeDemoFirebase` を呼び、
`firebase_bootstrap.dart` がEmulator専用構成以外を拒否する。
`flutter build web` の成功だけで本番配信できる状態ではないため、自動CDから分離している。
患者側の本番Firebase/Auth/App Check接続を実装・受入後に、明示したprojectと正しいHosting
targetで配信を追加する。公開環境で `USE_FIREBASE_EMULATOR=true` を使わない。

## ローカル検証

```sh
node --test scripts/cd-gate.test.cjs
actionlint .github/workflows/*.yaml
npm ci --prefix services/api --ignore-scripts
npm ci --prefix apps/hospital
npm --prefix apps/hospital run lint
npm --prefix apps/hospital test
npm --prefix apps/hospital run build
npm --prefix apps/hospital run test:security
docker build -f docker/hospital/Dockerfile --target prod .
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
```

`workflow_run` は列挙したworkflowの**いずれか**が完了すると発火するため、
5系統の確認を `scripts/cd-gate.cjs` で行う。fork/PRからの権限昇格経路には使わない。
[GitHub公式イベント仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
standaloneのpublic/staticは自動コピーされないためDockerfileで明示している。
[Next.js standalone仕様](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
