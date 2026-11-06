# 0007. OpenAPI/Swagger による API 契約の単一ソース化

- ステータス: 承認
- 日付: 2026-11-08
- 作成者: Devin
- 関連: ADR-0004（APIフレームワーク選定）

## コンテキスト

`services/api` は Zod スキーマでリクエスト/レスポンスを検証しているが、
スキーマはサービス層での実行時検証に留まり、API 全体像を把握する手段が
ソースコードの読解だけだった。クライアント実装（patient/hospital）と
レビュー効率のため、機械可読な API 契約とブラウザで閲覧できる UI が必要。

## 検討した選択肢

| 選択肢 | 概要 | 利点 | 欠点・犠牲になる点 |
|---|---|---|---|
| A. Zod スキーマから OpenAPI を生成（fastify-type-provider-zod + @fastify/swagger） | ルートの `schema` に既存 Zod をそのまま載せ、実行時検証と仕様生成を一体化 | 仕様と実装が乖離しない。バリデーションがルート層に前倒しされ薄くなる | スキーマを正確に書かないと仕様も嘘をつく（実装と同期する運用が前提） |
| B. OpenAPI を手書き YAML で管理 | `docs/` に OpenAPI YAML を別途保守 | 実装と独立して設計できる | 二重管理で必ず乖離する。医療系APIで契約の嘘は事故元 |
| C. 仕様なし（現状維持） | コードが唯一の真実 | 追加コストなし | クライアント・レビュー・外部連携の認知コストが高い |

## 決定

**A** を採用する。

- `@fastify/swagger` + `@fastify/swagger-ui` + `fastify-type-provider-zod` を導入し、
  ルートの `schema`（body/params/response）に既存 Zod スキーマを付与して
  OpenAPI 3 を自動生成する
- `validatorCompiler`/`serializerCompiler` を接続し、ルートスキーマでの
  入力検証を実行時にも有効化（サービス内の再検証は維持＝二重防御）
- Swagger UI は `/docs`、仕様 JSON は `/docs/json` に公開
- 公開可否は `API_DOCS_ENABLED`（true/false）で制御。既定は
  **エミュレータまたは非 production で有効、production で無効**。
  内部ジョブ系エンドポイントも仕様には含めるが `internal` タグで区別する
- 認証は OpenAPI の `bearerAuth`（Firebase ID Token）セキュリティスキームで表現

## 理由

- Zod が単一のソースになるため、仕様の陳腐化を構造的に防げる
- ルートスキーマの付与で validatorCompiler が境界検証を担い、
  ハンドラ内の手動 parse が不要なルートは素直になる
- PHI を含むエンドポイントの契約が明文化され、
  「エラー応答に PHI を含めない」等の規約をレビューで確認しやすい

## 結果・影響

- `@fastify/swagger` は `onRoute` フックでルートを収集するため、
  ルート登録を `app.register` 内に包み実行順を保証している（src/app.ts）
- validatorCompiler が投げるスキーマ検証エラーは
  `sendError` で `VALIDATION_FAILED`(400) にマップし既存の標準エラー形式を維持
- production で仕様を公開したい場合は `API_DOCS_ENABLED=true` を明示設定する

## 再評価条件

- 仕様駆動開発（OpenAPI → コード生成）に方針転換する場合
- Swagger UI を本番で恒常公開する要件が出た場合（認可・公開範囲の再検討）
