# もしもし問診（moshimoshimonshin）

DevFest 社会課題.exeの開発用リポジトリです。

患者が医療機関へ伝える情報の整理と、許可した医療機関への安全な提出を支援するサービス（診断・治療・予約は行わない）。

## 構成

| 層 | 技術 | 場所 |
|---|---|---|
| 患者アプリ（Android/iOS/Web） | Flutter（Dart） | `apps/patient`（未作成） |
| 医療機関ポータル（管理画面・Web） | Next.js + TypeScript + Tailwind CSS | `apps/hospital`（未作成、デプロイはFirebase Hosting） |
| API（Cloud Run 相当） | Node.js + TypeScript + Fastify | `services/api`（[ADR-0004](docs/adr/0004_APIフレームワーク選定.md)） |
| データ | Firestore(東京) / Storage(東京) / RTDB(非PHI・SG) | Firebase Emulator でローカル再現 |

## クイックスタート

```bash
make doctor   # Docker / Make / Flutter の導入確認
make up       # env自動生成 → エミュレータ等のコンテナ起動 → ファイル監視 → Flutter起動
make urls     # 各サービスのURL
make down     # 全停止
```

- Firebase Emulator UI: http://localhost:4000
- API ヘルスチェック: `curl http://localhost:8080/healthz`
- API 仕様（Swagger UI）: http://localhost:8080/docs （OpenAPI JSON は `/docs/json`。ローカル既定で有効、本番は `API_DOCS_ENABLED` で制御）
- アプリ実装（`apps/hospital`/`apps/patient`/`services/api`）を追加すると `make up` が自動で起動対象に含めます
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
