# 患者Webの公開接続と配信

公開接続の入口は `apps/patient/lib/main_public.dart`。初回利用者はログイン画面から新規登録へ進み、公開APIの最新規約を確認して必須同意した後に登録します。登録API成功後にFirebase Authでサインインし、メール確認と残りのオンボーディングを行います。既存の `main.dart` はローカルエミュレータ用です。

指定プロジェクトは `project-7efcc4c4-6c86-490c-ba5`、Hostingサイトは `moshimoshi-patient-842827776169` です。
公開先は https://moshimoshi-patient-842827776169.web.app です。サイトの存在やビルド成功だけでは実接続の受入完了とは扱いません。

## ビルドと配信

リポジトリ直下の無視対象 `.local/patient-web.json` に次の公開設定を保存します。パスワード・秘密鍵・Auth/App Checkトークンを含めないでください。これらのビルド設定はブラウザから読めます。

- `FIREBASE_PROJECT_ID`: 上記の指定プロジェクト
- `FIREBASE_APP_ID`: 登録済みPatient WebのFirebase App ID
- `FIREBASE_API_KEY`: 同アプリのSDK公開キー
- `FIREBASE_AUTH_DOMAIN`: 同アプリのSDK設定のAuthドメイン
- `APP_CHECK_SITE_KEY`: 公開ドメイン限定のreCAPTCHA Enterpriseサイトキー
- `API_BASE_URL`: 実APIのHTTPS origin（パス・末尾スラッシュなし）
- `PATIENT_FACILITY_ID`: 任意。実際に受信する施設コード

Auth許可ドメイン、Firebase App CheckのEnterprise設定、APIの `API_CORS_ORIGINS` に公開originを登録します。App Checkの無効化やDebug providerへの置換で受入を代用しません。

```sh
cd apps/patient
flutter analyze
flutter test
flutter build web --release --csp --no-web-resources-cdn \
  --target lib/main_public.dart \
  --dart-define-from-file ../../.local/patient-web.json
cd ../..
firebase deploy --project project-7efcc4c4-6c86-490c-ba5 \
  --config firebase.patient.json --only hosting
```

この専用設定は患者サイトを配信します。HTML・JSを含む全応答を `no-store` にし、PHIの端末永続化を避けます。Authはメモリ永続化です。CSPは実API、Firebase SDK、reCAPTCHAとFlutterの描画に必要な接続先を許可します。Firebaseのモジュールは外部の `web/firebase_bootstrap.js` で先に読み込み、FlutterFireのinline loaderを使いません。依存更新時は同ファイルのSDK版を `firebase_core_web` の `supportedFirebaseJsSdkVersion` と合わせ、実ブラウザ試験を再実行します。

Terraformを適用するときは `cors_origins` に既存originと患者公開originの両方を指定してください。今回のAPI CORS変更を既定値で巻き戻さないでください。配信前のビルドと設定を記録し、ロールバック時は直前の検証済みHostingリリースへ戻します。

## 受入

合成データだけでログイン→問診→質問回答→レビュー→確定→施設確認→明示同意付き送信→病院受信→ログアウトを確認します。実ブラウザでAuthとApp Checkの実トークン取得・CSP違反・API CORS・レスポンスヘッダも確認してください。トークンや入力内容をログに残さないでください。

実API・Firebase Emulatorを使う試験は `apps/patient/tool/run_intake_e2e.sh` です。実クラウドのApp Check受入を代用しません。このスクリプトは固定ポート（8080、8081、9000、9099、9199）を使って起動・停止するため、既存の共有ローカル環境と互換ではありません。専用かつ他プロセスから隔離された使い捨て環境でのみ実行してください。`E2E_DISPOSABLE_RUNNER=1` は操作者の自己申告にすぎず、隔離を強制・検証しません。ポート事前確認にもTOCTOU競合があり、同じポートを他プロセスが使わない保証にはなりません。iOSの署名・配布手順は [IOS_DISTRIBUTION.md](IOS_DISTRIBUTION.md) を参照してください。
