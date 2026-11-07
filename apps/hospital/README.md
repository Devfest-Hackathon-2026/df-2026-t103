# 医療機関ポータル

`/operator` はFirebase Authでログインし、実装済みBEの `GET /v1/operator/job-failures` を呼び出す運営管理者向け画面です。画像処理/削除処理の失敗一覧とカーソルページングを利用できます。実API `POST /v1/operator/facilities/{facilityId}/disable` で施設受信の緊急停止も行えます。対象IDと理由の確認後に明示的に実行し、サーバで直近の認証と運営権限を検証します。再認証を求められたらログアウトして再ログインしてください。通信失敗時は処理済みの可能性を表示し、自動再試行しません。固定データ・モックAPIへの自動切替はありません。職員の問診受信・閲覧等は別途実装中です。

Node.js 22 以降で `npm ci`、`npm run dev` を実行し、http://localhost:3000 を開きます。`npm run lint`、`npm test`、`npm run build` で検証できます。Docker Compose では既存の hospital サービスを使用します。

`lib/firebase-demo.ts` は将来のデモ向けの明示的な初期化関数です。`NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-mmr-dev`、`NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true` と Compose が指定する localhost の Auth / Firestore / Storage エミュレータのアドレスがすべて必要で、異なる設定は拒否します。この旧ヘルパーは既存のSDK結合試験用です。業務画面は `lib/firebase-client.ts` のAuth＋APIクライアントを利用し、Firestoreから業務データを直接取得しません。

本番配信基盤は未決定です。以下のnonce方式はNext.jsサーバーを必要とするため、既存のHosting静的配信案との調整が必要です。実用化には認証・施設単位の認可・監査・医療情報保護の実装と検証も必要です。

## Next.js配信のセキュリティ（#90）

`proxy.ts` はHTML・RSC・prefetch・404を含む応答に `Cache-Control: private, no-store`、
nonce付きCSP、フレーム埋め込み拒否、no-referrer、nosniff、機器権限制限を付与します。
実環境ではHSTSとHTTPSへのupgradeを有効化します。HMRは開発時のみ許可し、明示的なEmulator設定では指定したloopback接続先だけを許可します。
nonceはクライアントのヘッダを上書きし、リクエストごとに生成します。
接続設定を検証したうえで、実APIのorigin、Firebase Authのidentitytoolkit/securetoken、SDKのApp Check接続先content-firebaseappcheckとreCAPTCHAを許可します。reCAPTCHAのframe-srcも公式指定のURLに限定します。設定不足・不正値ならself限定のままです。ワイルドカードでは許可しません。

root layoutの `connection()` によりリクエスト時に描画します。PHIをサーバ側で取得せず、
HTML/RSC・JS/CSS・静的ファイル・ログへ入れない設計制約は引き続き適用します。
現在の検証は合成入力が応答へ反射しないことまでで、未実装の患者データ取得経路の保証ではありません。

このnonce方式は `next start` 等のNext.jsサーバーを必要とし、静的exportはできません。
`firebase.json` のhospital `public: apps/hospital/out` は静的配信案のままです。
そのHostingヘッダはNext.jsのnonceを生成できず、重ねるとbootstrapを拒否します。
本番公開前に #80/#82 の担当者とSSR配信経路・Hostingとのヘッダ所有者を確定してください。
この変更でクラウドやHostingのデプロイ設定は変更していません。

`npm run build && npm run test:security` は本番ビルドをloopback上で起動し、
HTTPヘッダ、nonceの更新・全bootstrap scriptへの一致、静的JS取得、404、RSC、prefetchを検証します。
実ブラウザでのCSP施行は、後述の任意ブラウザ試験で実Auth/BEへの接続とともに検証します。実クラウドApp Check/MFAと将来の患者データ取得経路のPHI検証は別途必要です。
現在のログイン・変更APIはメモリ内Bearer token方式で、API fetchはcredentials: omitを使います。サーバ側の認証/App Check/運営権限/再認証を回避しません。将来Cookie認証を導入する場合はHttpOnly・Secure・SameSite・CSRF対策の追加検証が必要です。

方式の根拠: [Next.js CSPガイド](https://nextjs.org/docs/app/guides/content-security-policy)
およびインストール済みNext.js 16.4.5の `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`。

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
Next.js ProxyのCSPは同じ接続設定から許可先を生成します。配信先で固定のself限定CSPを重ねないでください。

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
所属失効403、無認証401、施設受信停止・冪等性・失効後の変更拒否、実Firestore由来の失敗ジョブ取得と個人識別子の非露出を検証します。
この読取経路はStorage/RTDBへアクセスしませんが、BEの接続整合性検証のためそのloopback設定も明示します。
実クラウドのApp Check/MFA/CORS受入や、他の画面のAPI接続をこの試験だけで完了扱いにしません。

macOSでChromeをインストールしている場合は、同じコマンドに `HOSPITAL_BROWSER_SMOKE=true` を
追加すると、実画面でのログイン・実BEからの一覧表示・確認前の未変更・施設受信停止・ログアウトと、CSP違反が発生しないことも確認します。
Chromeのパスは `HOSPITAL_CHROME_PATH` で指定可能です。ポータルはloopback:33090で起動し、
試験後にChromeの一時プロファイル・起動プロセスを終了します。このブラウザ試験は任意実行です。

参照: [App Check custom backend](https://firebase.google.com/docs/app-check/web/custom-resource)、
[TOTP MFA](https://firebase.google.com/docs/auth/web/totp-mfa)。
