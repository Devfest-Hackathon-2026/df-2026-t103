# 医療機関ポータル（デモ）

合成データのみの画面雛形です。認証・認可、受信・閲覧、監査などは未実装であり、実運用や実データの入力は禁止です。画面は API や Firebase に接続しません。

Node.js 22 以降で `npm ci`、`npm run dev` を実行し、http://localhost:3000 を開きます。`npm run lint`、`npm test`、`npm run build` で検証できます。Docker Compose では既存の hospital サービスを使用します。

`lib/firebase-demo.ts` は将来のデモ向けの明示的な初期化関数です。`NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-mmr-dev`、`NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true` と Compose が指定する localhost の Auth / Firestore / Storage エミュレータのアドレスがすべて必要で、異なる設定は拒否します。SDK は画面から呼び出されません。ブラウザとエミュレータが同じホストにある構成のみ対応します。

本番配信基盤は未決定です。以下のnonce方式はNext.jsサーバーを必要とするため、既存のHosting静的配信案との調整が必要です。実用化には認証・施設単位の認可・監査・医療情報保護の実装と検証も必要です。

## Next.js配信のセキュリティ（#90）

`proxy.ts` はHTML・RSC・prefetch・404を含む応答に `Cache-Control: private, no-store`、
nonce付きCSP、フレーム埋め込み拒否、no-referrer、nosniff、機器権限制限を付与します。
本番ではHSTSとHTTPSへのupgradeを有効化し、開発時のみHMR・ローカルEmulatorを許可します。
nonceはクライアントのヘッダを上書きし、リクエストごとに生成します。
外部サービス未接続の現デモでは本番 `connect-src` はself限定です。将来のAuth/API連携時は
必要な正確なoriginを追加し、ワイルドカードで解除しないでください。

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
実ブラウザでのCSP施行や認証後のPHI検証は別途必要です。
現デモはCookieを発行せず、変更APIもありません。Cookie/CSRFは未実装の#82に依存するため、
`HttpOnly`・`Secure`・`SameSite`・CSRF token・サーバでの認可の最終確認を省略できません。

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
