# 医療機関ポータル（デモ）

合成データのみの画面雛形です。認証・認可、受信・閲覧、監査などは未実装であり、実運用や実データの入力は禁止です。画面は API や Firebase に接続しません。

Node.js 22 以降で `npm ci`、`npm run dev` を実行し、http://localhost:3000 を開きます。`npm run lint`、`npm test`、`npm run build` で検証できます。Docker Compose では既存の hospital サービスを使用します。

`lib/firebase-demo.ts` は将来のデモ向けの明示的な初期化関数です。`NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-mmr-dev`、`NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true` と Compose が指定する localhost の Auth / Firestore / Storage エミュレータのアドレスがすべて必要で、異なる設定は拒否します。SDK は画面から呼び出されません。ブラウザとエミュレータが同じホストにある構成のみ対応します。

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
