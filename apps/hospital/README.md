# 医療機関ポータル

`/operator` はFirebase Authでログインし、実装済みBEの `GET /v1/operator/job-failures` を呼び出す運営管理者向け画面です。画像処理/削除処理の失敗一覧とカーソルページングを利用できます。`GET /v1/operator/audit-events` から権限変更等の監査サマリーも新しい順に取得します。イベント種別・操作者区分・UTC日時・認可判断・結果だけを表示し、患者/職員/施設の識別子・ハッシュ・自由記述は表示しません。実API `POST /v1/operator/facilities/{facilityId}/disable` で施設受信の緊急停止も行えます。対象IDと理由の確認後に明示的に実行し、サーバで直近の認証と運営権限を検証します。再認証を求められたらログアウトして再ログインしてください。通信失敗時は処理済みの可能性を表示し、自動再試行しません。固定データ・モックAPIへの自動切替はありません。

職員向けは `/login`（H-001）でメール/パスワード＋TOTP多要素認証を行い、成功時に HttpOnly Cookie のセッションを確立します。`/facilities`（H-002）で業務を行う施設を選択すると、選択は `/api/facility-context` がメンバーシップ照合のうえコンテキスト Cookie に保持し、ヘッダーの施設名に反映されます。施設バッジまたはナビからいつでも切り替えられ、切替は施設別の画面状態をリセットします。問診受信（H-003）・問診詳細（H-004）・職員管理（H-005）・施設設定（H-006）は実装中です。

Node.js 22 以降で `npm ci`、`npm run dev` を実行し、http://localhost:3000 を開きます。`npm run lint`、`npm test`、`npm run build` で検証できます。Docker Compose では既存の hospital サービスを使用します。

## デザインシステム（HX）

`docs/10_デザインシステム.md` のHX（医療機関向け）仕様に基づく共通基盤です。

- トークンは `app/globals.css` の `@theme` で定義（色 `hx-*`、タイポグラフィ `text-hx-*`、形状 radius）。個別画面で任意の色・文字サイズを直書きせず、必ずトークン経由のユーティリティを使います。
- 共通コンポーネントは `components/design-system/`（`HxButton` / `HxField` / `HxStatusBadge` / `HxDataTable` / `HxPageHeader` / `HxAppShell` / `HxDialog` / `HxConfirmActionDialog` / `HxLoadingState` / `HxEmptyState` / `HxErrorPanel` / `HxSkeleton` など）に配置します。
- 未認証ページの共通ヘッダーは `components/layout/portal-header.tsx`、認証後のシェルは `HxAppShell` を使い、画面ごとにヘッダーを自前実装しません。
- 開発時のみ `http://localhost:3000/dev/catalog` で各コンポーネントの状態を確認できます（本番ビルドでは404）。
- 状態バッジのラベルは `components/design-system/hx-status-badge.ts(x)` の `DELIVERY_STATUS` を唯一の対応表とし、色だけで状態を伝えません。

## 職員認証・セッション（H-001）

- `/login` で Firebase Auth（メール/パスワード）にサインインし、MFA 未登録なら TOTP 登録、登録済みなら TOTP 検証を経て、`POST /api/session` が実 API で credential を検証し（本番ではMFAクレームも確認）、HttpOnly Cookie（本番 `__Host-mmr-session`、SameSite=Strict、最長55分）を発行します。失敗してもアカウントの存在有無を示さない応答にします。
- 業務画面は `app/(workspace)/layout.tsx` がセッション Cookie と `GET /v1/me/facility-memberships` で検証します。401/403 なら `GET /api/session/logout` で Cookie を消して `/login` へ、5xx・接続失敗ではセッションを維持したまま再試行可能なエラー画面を出します。`proxy.ts` は Cookie の有無だけの楽観的リダイレクトで、認可の正本は API 側です。
- クライアントの API 呼び出しは `lib/hx-api.ts` 経由で `/api/hx/*` のみを使い、サーバ側が Bearer + App Check を付けて転送します。`/api/session` と `/api/hx/*` は必須カスタムヘッダー `x-hx-client: portal`・`Sec-Fetch-Site`/`Origin` の同一オリジン確認で CSRF を防ぎます。
- セッション維持は `workspace-shell.tsx` の `SessionKeeper` が Firebase の ID トークン変更・定期更新・タブ復帰を監視して行います。サインアウト・失効・再読み込み後の未認証では `GET /api/session/logout` 経由で Cookie を削除して `/login` に戻ります（Firebase はインメモリ永続化のため再読み込みは再ログイン）。

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
職員画面は HttpOnly Cookie セッション＋`/api/hx/*` BFF 経由で API を呼び、ID トークンを
ブラウザ JS・localStorage に置きません（ADR-0020）。運営画面の既存経路はトークンをメモリ内に
保持する方式のままです。Firebase Auth はインメモリ永続化のため、ブラウザの再読み込みでは
Firebase 側の認証状態が消え、Cookie も消去して再ログインになります。
本番では `/api/session` 側でもMFA済みトークンのクレームを確認し、未MFAの Cookie 発行を
拒否します（サーバ側のMFA強制・運営権限の認可は引き続きBEが担います）。
権限はBEがfacilityMemberships正本で判定します。
MFA登録は初回ログイン時の画面で行います。他の運営機能は完成扱いにしません。
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
病院APIのテナント境界も、別々の実Auth Emulator職員tokenで検証します。
患者が実APIで作成した配送を自院一覧→詳細→受領確認へ進め、閲覧だけでは状態を変えないこと、
受領の再試行が冪等で成功監査も重複しないことを確認します。別院一覧/詳細/受領は拒否し、
自院URLに別院の配送IDを指定した場合は存在しないIDと同じ404、配送の無変更、拒否監査を確認します。
所属取消は管理者の実APIから実行し、同じログインtokenで一覧/詳細/受領が403になることを確認します。
職員管理は招待201・重複409、ロール変更、所属取消の冪等性と監査、一般職員の管理操作拒否、
別院管理者の拒否、他院所属IDの404、管理者自身の降格/取消拒否を検証します。招待は台帳登録まででメール配信の試験ではありません。
このAPI結合試験は未完成の病院画面・Cookie/CSRF経路・職員管理画面のブラウザE2Eを代用しません。
この読取経路はStorage/RTDBへアクセスしませんが、BEの接続整合性検証のためそのloopback設定も明示します。
実クラウドのApp Check/MFA/CORS受入や、他の画面のAPI接続をこの試験だけで完了扱いにしません。

macOSでChromeをインストールしている場合は、同じコマンドに `HOSPITAL_BROWSER_SMOKE=true` を
追加すると、実画面でのログイン・実BEからの一覧/監査表示・施設審査の承認/却下・確認前の未変更・施設受信停止・ログアウトと、CSP違反が発生しないことも確認します。
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
