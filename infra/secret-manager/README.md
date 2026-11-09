# Secret Manager 構成（Issue #32 / NFR-12・docs/07 §4・ADR-0002）

本番の秘密情報は GCP Secret Manager に置く。ローカル開発は `.env.local` /
`.secret.local` を Secret Manager の代替として使う（docs/07 §4・ADR-0002）。

> orchestrator 指示により**プロジェクトは単一（stg/prod の区別なし）**。
> IAM 付与・シークレット作成は owner/projectIamAdmin 権限が必要（`roles/editor` では不可）。
> `PROJECT_ID` は対象プロジェクト（例 `project-7efcc4c4-...`）に置換。

## 秘密情報の一覧（本番で Secret Manager 管理）

| シークレット名 | 用途 | 調達 | ローカル（`.secret.local`） |
|---|---|---|---|
| `SERVER_HMAC_SECRET` | 冪等キー・監査ハッシュ用の HMAC | **自動生成**（`openssl rand`） | `change-me-local-dev` |
| `INTERNAL_JOB_TOKEN` | `/v1/internal/jobs/*` 呼出しトークン | **自動生成** | `dev-internal-job-token` |
| `GOOGLE_PLACES_API_KEY` | 施設検索（Places API） | owner が実値を用意 | 空（未設定ならモック） |

Vertex AIはSecret/APIキーを使用しない。API実行SAのADCから短命OAuthトークンを取得する。
必要権限は指定projectの`roles/aiplatform.user`で、Terraformの`api_vertex`が管理する。
旧`VERTEX_AI_API_KEY`の箱は既存資源を削除しないため残すが、API/worker envと
Accessorは除去する。既存versionの削除・無効化は別途利用先を確認して行う。

## 作成・バージョニング・IAM

`infra/secret-manager/setup-secrets.sh` が冪等に実施する:

1. シークレットが無ければ作成（`--replication-policy user-managed --locations asia-northeast1` = 東京固定）
2. 新バージョンを追加（値は環境変数/標準入力から。スクリプトに実値は書かない）
3. ランタイム SA（`api-run-sa` / `worker-run-sa`）に**のみ** `roles/secretmanager.secretAccessor` を
   シークレット単位で付与（最小権限）

```sh
PROJECT_ID=project-7efcc4c4-6c86-490c-ba5 \
GOOGLE_PLACES_API_KEY=... \
  ./infra/secret-manager/setup-secrets.sh
# SERVER_HMAC_SECRET / INTERNAL_JOB_TOKEN は未指定なら自動生成される
```

ローテーションは `gcloud secrets versions add <name> --data-file=-` で新バージョンを
投入し、Cloud Run を再デプロイ（`:latest` 参照のため次回起動で反映）。

## Cloud Run への注入方式

env 変数として `secretKeyRef`（`key: latest`）で注入する。定義は
`infra/cloud-run/service-api.yaml` / `service-worker.yaml` に記載済み。
ボリュームマウントは使わない（env で十分かつ取り回しが容易）。

```yaml
env:
  - name: SERVER_HMAC_SECRET
    valueFrom:
      secretKeyRef:
        name: SERVER_HMAC_SECRET
        key: latest
```

## 運用ルール（docs/07 §4.3）

- 秘密の実値を issue・PR・ログ・スクリーンショットに貼らない。
- `.secret.local` に本番の鍵・実患者データを置かない。
- チーム共有はパスワードマネージャ等の別チャネルで。
