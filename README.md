# もしもし問診（moshimoshimonshin）

DevFest 社会課題.exeの開発用リポジトリです。

患者が医療機関へ伝える情報の整理と、許可した医療機関への安全な提出を支援するサービス（診断・治療・予約は行わない）。

## 構成

| 層 | 技術 | 場所 |
|---|---|---|
| 患者アプリ（Android/iOS/Web） | Flutter（Dart） | `apps/patient`（未作成） |
| 医療機関ポータル（管理画面・Web） | Next.js + TypeScript + Tailwind CSS | `apps/hospital`（未作成、デプロイはFirebase Hosting） |
| API（Cloud Run / Cloud Functions 第2世代相当） | Node.js + TypeScript | `services/api`（未作成） |
| データ | Firestore(東京) / Storage(東京) / RTDB(非PHI・SG) | Firebase Emulator でローカル再現 |

## クイックスタート

```bash
make doctor   # Docker / Make / Flutter の導入確認
make up       # env自動生成 → エミュレータ等のコンテナ起動 → ファイル監視 → Flutter起動
make urls     # 各サービスのURL
make down     # 全停止
```

- Firebase Emulator UI: http://localhost:4000
- アプリ実装（`apps/hospital`/`apps/patient`/`services/api`）を追加すると `make up` が自動で起動対象に含めます
- 詳しい手順・ツール導入・個別停止は [docs/07_環境構築手順書](docs/07_環境構築手順書.md) と [docs/08_Docker_Makefile運用](docs/08_Docker_Makefile運用.md)

## 環境変数・秘密情報

- `.env.local`（非シークレット）/ `.secret.local`（シークレット）は `make up` 時に雛形から自動生成
- 両方ともコミット禁止。本番・stgはGCP Secret Managerを使用
- 詳細は [docs/07_環境構築手順書](docs/07_環境構築手順書.md) §4 と [ADR-0002](docs/adr/0002_ローカルのシークレット管理.md)

## ドキュメント

- [docs/01_要件定義書](docs/01_要件定義書.md) / [02_システム設計書](docs/02_システム設計書.md) / [03_機能仕様書](docs/03_機能仕様書.md) / [04_DB設計書](docs/04_DB設計書.md) / [05_コスト試算表](docs/05_コスト試算表.md) / [06_医療安全_セキュリティ_運用設計書](docs/06_医療安全_セキュリティ_運用設計書.md)
- [docs/07_環境構築手順書](docs/07_環境構築手順書.md) / [docs/08_Docker_Makefile運用](docs/08_Docker_Makefile運用.md) / [docs/09_USEFUL_COMMANDS](docs/09_USEFUL_COMMANDS.md)
- 意思決定記録: [docs/adr/](docs/adr/README.md)

## 開発運用

- PR/Issueテンプレートの正本は `.github/template/`。GitHubへ反映は `make install-templates`
- 注意: 医療情報（PHI）をログ・通知・Analyticsに含めない。`.secret.local` や実患者データをコミットしない
