# 医療機関ポータル

`/operator` はFirebase Authでログインし、実装済みBEの `GET /v1/operator/job-failures` を呼び出す運営管理者向け画面です。画像処理/削除処理の失敗一覧とカーソルページングを利用できます。`GET /v1/operator/audit-events` から権限変更等の監査サマリーも新しい順に取得します。イベント種別・操作者区分・UTC日時・認可判断・結果だけを表示し、患者/職員/施設の識別子・ハッシュ・自由記述は表示しません。実API `POST /v1/operator/facilities/{facilityId}/disable` で施設受信の緊急停止も行えます。対象IDと理由の確認後に明示的に実行し、サーバで直近の認証と運営権限を検証します。再認証を求められたらログアウトして再ログインしてください。通信失敗時は処理済みの可能性を表示し、自動再試行しません。固定データ・モックAPIへの自動切替はありません。職員の問診受信・閲覧等は別途実装中です。

Node.js 22 以降で `npm ci`、`npm run dev` を実行し、http://localhost:3000 を開きます。`npm run lint`、`npm test`、`npm run build` で検証できます。Docker Compose では既存の hospital サービスを使用します。

`lib/firebase-demo.ts` は将来のデモ向けの明示的な初期化関数です。`NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-mmr-dev`、`NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true` と Compose が指定する localhost の Auth / Firestore / Storage エミュレータのアドレスがすべて必要で、異なる設定は拒否します。この旧ヘルパーは既存のSDK結合試験用です。業務画面は `lib/firebase-client.ts` のAuth＋APIクライアントを利用し、Firestoreから業務データを直接取得しません。

本番 Hosting 静的配信か SSR かは未決定です。実用化にはインフラとの調整と、認証・施設単位の認可・監査・医療情報保護の実装と検証が必要です。

## Firebase 依存の暫定対応

Firestore が依存する `@grpc/grpc-js` には GHSA-m9gg-hp2v-232j の修正を含む `1.13.6` を override しています。この版は Firebase が宣言する依存範囲外であり、互換性は完全には保証できません。上流の依存制約が修正版を許可したら override を撤去し、エミュレータ結合試験を再実行してください。現時点ではデモ専用で、本番利用しないでください。

`npm audit --omit=dev` は実行時依存の監査です。開発用依存を含む `npm audit` の結果も別途確認してください。

## エミュレータ結合試験

`demo-mmr-dev` の Auth、Firestore、Storage エミュレータが起動していることを確認し、`apps/hospital` で次を実行します。合成の匿名アカウントを作成し、終了時に削除します。Firestore の公開設定の読み取りと、Firestore / Storage の書き込み・アクセス拒否を検証します。

```sh
NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-mmr-dev \
NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true \
NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL=http://localhost:9099 \
NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST=localhost:8081 \
NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST=localhost:9199 \
npm run test:emulator
```

エミュレータの初回起動にはダウンロードが必要です。起動完了前の実行は接続エラーになります。この試験は Node.js での接続確認であり、ブラウザ・本番環境での互換性を保証するものではありません。


## 実BEへの接続

接続先を明示してから `npm run dev` を起動します。設定不足でモックや別プロジェクトに切り替えません。
ローカル検証は合成データと実BE＋Firebase Emulatorを使います。

```sh
NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true \
NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-mmr-dev \
NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL=http://localhost:9099 \
NEXT_PUBLIC_API_BASE_URL=http://localhost:8080/v1 npm run dev
```

実環境では上記Emulatorフラグを `false`、projectを `project-7efcc4c4-6c86-490c-ba5` にし、
`NEXT_PUBLIC_API_BASE_URL` に実APIのHTTPS URL（末尾 `/v1`）、Firebase Webアプリの
`NEXT_PUBLIC_FIREBASE_API_KEY`・`NEXT_PUBLIC_FIREBASE_APP_ID`・`NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`、
reCAPTCHA Enterpriseの `NEXT_PUBLIC_APP_CHECK_SITE_KEY` を設定します。
実環境では `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL` を設定しません。
NEXT_PUBLIC変数はビルド時に埋め込まれるため、変更後は再ビルドが必要です。
APIの `API_CORS_ORIGINS` にはブラウザで開くポータルの正確なoriginも必要です。
CSPを有効にする配信先では、実API・Firebase Auth/App Check・reCAPTCHAの必要なoriginを
ポリシーへ組み込み、固定のself限定CSPをそのまま重ねないでください（#90/PR205の統合作業）。

画面はメール/パスワードと登録済みTOTPの追加認証に対応します。TOTP以外のMFAは未対応です。
トークンはメモリ内のみで、CookieやlocalStorageへ保存しません。リロードすると再ログインが必要です。
本番でMFA済みtokenがなければAPI呼び出しを止めますが、これはUX上の追加チェックであり、
サーバ側のMFA強制・運営権限の認可を代替しません。権限はBEがfacilityMemberships正本で判定します。
MFA登録・職員向けCookie認証・他の運営機能は完成扱いにしません。
APIエラー本文やtokenはログへ出さず、レスポンスはAPI-038の公開フィールドだけを画面へ渡します。

### モックを使わないAPI結合試験

`services/api` と `apps/hospital` でそれぞれ `npm ci` を実施し、Java21以降を利用します。

```sh
FIREBASE_PROJECT_ID=demo-mmr-dev \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:19099 \
FIRESTORE_EMULATOR_HOST=127.0.0.1:18081 \
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:19199 \
FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:19000 \
npx --yes firebase-tools@15.35.0 emulators:exec --project demo-mmr-dev \
  --config ../../firebase.hospital-test.json --only auth,firestore 'npm run test:api'
```

試験はFastifyの実entrypointを一時loopbackポートで起動し、Auth Emulatorでサインインした
ID tokenを本番と同じfrontend APIクライアントへ渡します。所属なし403、運営所属あり200、
所属失効403、無認証401、施設受信停止・冪等性・失効後の変更拒否、実Firestore由来の失敗ジョブ/監査一覧取得・監査の同時刻ページング・個人識別子と自由記述の非露出を検証します。
E2E-006は独立した患者のAuth Emulator tokenと合成の確定問診票・現行同意を使い、停止前202→運営による停止→新規送信412、既存配送の不変・新規配送なし・送信済みキーの再試行で同じ結果・患者による既存配送の閲覧を検証します。
ブラウザ試験を有効にすると、停止操作も実画面から実行します。患者アプリ画面そのものや、未完成の病院受信/詳細/職員管理画面のE2Eを代用するものではありません。
この読取経路はStorage/RTDBへアクセスしませんが、BEの接続整合性検証のためそのloopback設定も明示します。
実クラウドのApp Check/MFA/CORS受入や、他の画面のAPI接続をこの試験だけで完了扱いにしません。

macOSでChromeをインストールしている場合は、同じコマンドに `HOSPITAL_BROWSER_SMOKE=true` を
追加すると、実画面でのログイン・実BEからの一覧表示・監査一覧表示・確認前の未変更・施設受信停止・ログアウトも確認します。
Chromeのパスは `HOSPITAL_CHROME_PATH` で指定可能です。ポータルはloopback:33090で起動し、
試験後にChromeの一時プロファイル・起動プロセスを終了します。このブラウザ試験は任意実行です。

参照: [App Check custom backend](https://firebase.google.com/docs/app-check/web/custom-resource)、
[TOTP MFA](https://firebase.google.com/docs/auth/web/totp-mfa)。


## 運営施設審査（O-001）

`/operator`の「運営施設審査」で実BEの施設一覧を取得し、施設を選択して検証証跡サマリーを確認します。
原本を別途確認し、4検証項目・検証文書参照を入力して確認画面から既存承認APIを実行します。
未審査施設は理由を付けて却下できます。再認証要求時はログアウトして再ログインしてください。
承認しても受付は自動で有効になりません。却下はpendingだけで、承認済み/停止中の緊急対応は受付停止操作を使います。
文書参照原文・連絡先・審査者UID・メモは一覧APIから取得せず、患者情報は入力しません。

実環境への公開前に`facilityVerificationRecords: facilityId ASC, createdAt DESC`のindexを
`firebase/firestore.indexes.json`から通常のRules/indexesデプロイ手順で作成し、利用可能状態を確認してください。
API/画面とindexのデプロイ、正規MFA/App Check付きのクラウド受入は、このローカル検証だけで完了扱いにしません。
