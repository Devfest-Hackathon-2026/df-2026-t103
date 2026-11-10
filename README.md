# もしもし問診（moshimoshimonshin）

DevFest Hackathon 2026 / チーム「社会課題.exe」の提出用リポジトリです。

患者が医療機関へ伝える情報の整理と、許可した医療機関への安全な提出を支援するサービス（診断・治療・予約は行わない）。

## 審査の入口

- **患者 Web:** https://moshimoshi-patient-842827776169.web.app/
- **医療機関 Web:** https://hospital-842827776169.asia-northeast1.run.app/login
- [現行の資料一覧](docs/README.md) / [運営の提出ガイド](SUBMISSION_GUIDE.md)

患者Hostingは `a5083cd` を配信済みです（2026-11-10 07:24 UTC のリリース記録）。配信完了は認証後デモの完走や病院受領の確認を意味しません。既存サンプルの認証情報は公開しません。実患者情報・実処方箋を使わず、架空のプロフィール・症状だけで確認してください。

### 短いデモ手順

1. 患者 Web で新規登録し、規約同意・メール確認・必須プロフィールを完了します。認証用には本人が受信できるメールを使い、画面収録には映さないでください。
2. **自己専用デモ（送信保存のみ）:** ホームに「合成デモを開始」が表示される場合、説明を確認し「架空情報のみで開始」を選びます。新規登録者は既存サンプル施設ではなく、この操作で準備される本人専用の送信先を利用します。部位・症状入力→質問回答→問診票確認・確定→専用送信先・共有範囲確認→個別同意→送信保存へ進みます。利用可否はサーバ設定・配信版に依存します。表示されない場合や拒否された場合は停止し、別施設への送信で代用しません。**公開環境での認証後デモ完走、病院側の閲覧・受領は未確認です。**
3. **通常フローは別です:** 問診票確定後、運用者が承認した受信先施設コードを入力し、施設情報・共有範囲を確認して個別同意後に送信します。病院側は正規の職員権限でログイン→施設選択→受信一覧→詳細→受領確認へ進みます。承認済み合成データと職員権限がない場合は実行できません。通常登録だけで職員権限や合成施設への送信権限は付与されません。

### 実装と確認範囲

- 患者の公開接続入口は `apps/patient/lib/main_public.dart`。問診・同意・配送APIと病院ポータルの実装を収録しています。実装の存在と公開環境での動作確認は別です。
- 患者登録・メール確認・パスワード再設定・iPhone Safariでのスクロールは**ユーザー確認済み**です。本資料更新作業での独立再検証ではなく、ネイティブiOS/Androidアプリの公開動作確認を意味しません。
- AI質問生成は実装がありますが、**実Geminiでの生成成功は未確認**です。固定質問へのフォールバックをAI成功と扱いません。OCRの実画像読取成功、通常フロー全体の公開環境E2Eも未確認です。
- 自己専用デモは実APIへの送信保存までを対象とし、病院側の閲覧・受領とは区別します。未接続プレビューの表示を実API処理成功の証拠には使いません。

## 構成

| 層 | 技術 | 場所 |
|---|---|---|
| 患者アプリ（公開Web、ネイティブiOS/Androidの公開動作は未確認） | Flutter（Dart） | `apps/patient` |
| 医療機関ポータル（管理画面・Web） | Next.js + TypeScript + Tailwind CSS | `apps/hospital`（公開先はCloud Run） |
| API（Cloud Run 相当） | Node.js + TypeScript + Fastify | `services/api`（[ADR-0004](docs/adr/0004_APIフレームワーク選定.md)） |
| データ | Firestore(東京) / Storage(東京) / RTDB(非PHI・SG) | Firebase Emulator でローカル再現 |

## クイックスタート

```bash
make doctor   # Docker / Make / Flutter の導入確認
make up       # env自動生成 → エミュレータ等のコンテナ起動 → ファイル監視 → Flutter起動
make urls     # 各サービスのURL
make down     # 全停止
```

Docker / Docker Compose / Make / Flutter SDK が必要です。`make up` はローカルの実API・Firebase Emulator・患者アプリの `main.dart` を起動します。公開版 `main_public.dart` や自己専用デモとは別の起動経路です。起動後は `make ps`、`make logs-patient` で状態を確認してください。本資料更新作業では起動試験は行っていません。

個別の実行・検証方法は [患者アプリ](apps/patient/README.md) / [病院ポータル](apps/hospital/README.md) を参照してください。APIはNode.js 22以降を用意し、`services/api` で `npm ci`、`npm run typecheck`、`npm test` を実行します。単体試験は公開環境のE2E確認を代用しません。

Firebase EmulatorとFlutter widget hostを使う試験も、実ブラウザのFirebase SDK・公開環境のApp Check・実メール配信の確認を代用しません。

- Firebase Emulator UI: http://localhost:4000
- API ヘルスチェック: `curl http://localhost:8080/healthz`
- API 仕様（Swagger UI）: http://localhost:8080/docs （OpenAPI JSON は `/docs/json`。ローカル既定で有効、本番は `API_DOCS_ENABLED` で制御）
- `apps/hospital` / `apps/patient` / `services/api` は収録済みです。独立プレビューは実API未接続の表示例です。
- 詳しい手順・ツール導入・個別停止は [docs/07_環境構築手順書](docs/07_環境構築手順書.md) と [docs/08_Docker_Makefile運用](docs/08_Docker_Makefile運用.md)

## 環境変数・秘密情報

- `.env.local`（非シークレット）/ `.secret.local`（シークレット）は `make up` 時に雛形から自動生成
- 両方ともコミット禁止。本番・stgはGCP Secret Managerを使用
- 詳細は [docs/07_環境構築手順書](docs/07_環境構築手順書.md) §4 と [ADR-0002](docs/adr/0002_ローカルのシークレット管理.md)

### API のブラウザ接続

設計上は患者 Web と API が別ドメインのため、API で許可元限定 CORS を使用します。`API_CORS_ORIGINS` にブラウザから見た正確な origin をカンマ区切りで指定します（パス、末尾スラッシュ、ワイルドカード不可。本番は HTTPS のみ）。`development` の未設定時は `http://localhost:5050` と `http://127.0.0.1:5050` のみ、`production` と `test` の未設定時または空文字は許可なしです。staging/production では実際に承認された公開 origin を明示し、変更後は API を再起動してください。ローカル Compose は `.env.local` を API に渡します。

許可メソッドは GET / POST / PATCH / DELETE、許可ヘッダは Authorization / Content-Type / X-Firebase-AppCheck / Idempotency-Key / X-Request-Id です。Cookie 等の credentials は許可しません。CORS は認証・認可や App Check の代わりではなく、ブラウザ以外のアクセスを制限するものでもありません。Storage の署名 URL は別途 Storage 側の CORS 設定が必要です。

### API の Firebase 接続

- ローカルは `demo-mmr-dev` 等の `demo-` プロジェクト ID と、`FIREBASE_AUTH_EMULATOR_HOST`、`FIRESTORE_EMULATOR_HOST`、`FIREBASE_STORAGE_EMULATOR_HOST`、`FIREBASE_DATABASE_EMULATOR_HOST` の全４つを設定する。API 側エミュレータ接続先は `localhost`・`127.0.0.1`・Compose の `firebase` のいずれかとポートに限定する。Compose はこれらを設定済み。Storage のクライアント向けアドレスは `FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST` で別指定でき、内部接続先が `firebase` の場合は必須。エミュレータのアップロード URL に使う公開ホストは `localhost`・`127.0.0.1` と有効ポート（1〜65535）に限定する。現行 Compose の既定値は `localhost:9199`。
- 本番は実プロジェクト ID を `FIREBASE_PROJECT_ID` または `GCLOUD_PROJECT` に設定し、上記エミュレータ変数をすべて未設定にする。両方のプロジェクト ID を指定する場合は一致が必要。`NODE_ENV=production` では実際の `SERVER_HMAC_SECRET` も必須。
- 片方だけの Auth/Firestore を含む部分エミュレータ構成、実プロジェクトとエミュレータの組み合わせ、エミュレータなしの demo プロジェクトは起動時に拒否する。旧名 `DATABASE_EMULATOR_HOST` は使用せず、Admin SDK が使用する `FIREBASE_DATABASE_EMULATOR_HOST` を使う。
- これらは設定の整合性検査であり、指定先の実在・安全性や、Firebase 以外の外部サービスへの接続を保証するものではない。ローカルに本番資格情報や実患者データを置かない。
- Storage Emulator のメディアアップロードは、`ifGenerationMatch=0` を付けても既存オブジェクトの上書きを拒否しない場合がある。実際に使う Emulator で検証し、デモでは使い捨てデータを使う。本番の署名 URL の新規作成制約が Emulator でも検証できたとはみなさない。

## ドキュメント

- メール登録は登録操作台帳が残っている間、同じ `Idempotency-Key` と同じ本文で再開できます。Firestore commit済み状態は期限経過だけでは巻き戻さず、異なる本文は409です。台帳がTTL等で物理削除された後の再開は保証されず、既存Authとの競合はfail-closedになります。別キーの登録では disabled Auth ユーザーを孤児と推定して削除しません。孤児の自動回収・安全な復旧手順は未実装です。後日、担当者確認と所有権・期限の確認を伴う復旧が必要です（認証情報は開示・記録しません）。詳細は [システム設計書 §5.1](docs/02_システム設計書.md) と [DB設計書 §5.14](docs/04_DB設計書.md) を参照。

- [docs/01_要件定義書](docs/01_要件定義書.md) / [02_システム設計書](docs/02_システム設計書.md) / [03_機能仕様書](docs/03_機能仕様書.md) / [04_DB設計書](docs/04_DB設計書.md) / [05_コスト試算表](docs/05_コスト試算表.md) / [06_医療安全_セキュリティ_運用設計書](docs/06_医療安全_セキュリティ_運用設計書.md)
- [docs/07_環境構築手順書](docs/07_環境構築手順書.md) / [docs/08_Docker_Makefile運用](docs/08_Docker_Makefile運用.md) / [docs/09_USEFUL_COMMANDS](docs/09_USEFUL_COMMANDS.md)
- [患者画面のローカルプレビュー手順](docs/11_患者画面プレビュー.md)
- 意思決定記録: [docs/adr/](docs/adr/README.md)

## 開発運用

- PR/Issueテンプレートの正本は `.github/template/`。GitHubへ反映は `make install-templates`
- 注意: 医療情報（PHI）をログ・通知・Analyticsに含めない。`.secret.local` や実患者データをコミットしない
