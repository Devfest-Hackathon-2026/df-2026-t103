# 環境変数の配線（Issue #44 / docs/07 §4・ADR-0002）

ローカル（`.env.local` / `.secret.local`）・GitHub（Variables / Secrets）・
GCP（Cloud Run env / Secret Manager）・クライアントビルド（Flutter dart-define /
Next.js `NEXT_PUBLIC_*`）の対応を定める正本。

> orchestrator 指示により**単一プロジェクト（stg/prod 区別なし）**。将来 stg を分ける
> 場合は GitHub Environment（`stg`/`prod`）ごとに同じキーを値違いで定義する。
> 実値の投入（GitHub Variables/Secrets・Secret Manager）は owner が実施。

## 分類の原則（docs/07 §4）

| 種別 | ローカル | GitHub | 実行時の供給先 |
|---|---|---|---|
| 非シークレット | `.env.local`（雛形 `.env.example`） | **Variables** | Cloud Run env / ビルド引数 |
| シークレット | `.secret.local`（雛形 `.secret.example`） | **Secrets** | Secret Manager → Cloud Run `secretKeyRef`（#32） |

## 非シークレット（GitHub Variables / Cloud Run env）

| キー | 本番値（例） | 供給先 | 備考 |
|---|---|---|---|
| `FIREBASE_PROJECT_ID` | `project-7efcc4c4-...` | API env | `.firebaserc` の ID と要確定（別ID）|
| `APP_CHECK_MODE` | `enforce` | API env | 本番は強制（#33） |
| `API_DOCS_ENABLED` | `false` | API env | 本番は非公開 |
| `API_CORS_ORIGINS` | `https://hospital.moshimoshimonshin.com` | API env | 許可 origin を厳密指定 |
| `NEXT_PUBLIC_API_BASE_URL` | `https://api.moshimoshimonshin.com/v1` | hospital ビルド | ブラウザから見える URL |
| `API_BASE_URL_SERVER` | -（本番は不要） | hospital コンテナ env | Compose 内 Route Handler から API へ到達する内部 URL（ローカルは `http://api:8080/v1`、未設定時は `NEXT_PUBLIC_API_BASE_URL` を使用） |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `project-7efcc4c4-...` | hospital ビルド | |
| `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` | `false` | hospital ビルド | 本番は false |
| `TZ` | `Asia/Tokyo` | API env | |

### CD（#38）が使う Variables

| キー | 用途 |
|---|---|
| `GCP_PROJECT_ID` | デプロイ対象プロジェクト |
| `GCP_WIF_PROVIDER` | Workload Identity Federation プロバイダ |
| `GCP_DEPLOY_SA` | デプロイ SA（`github-deployer`） |
| `GCP_AR_REPO` | Artifact Registry リポジトリ名 |
| `RUN_SERVICE_API` | Cloud Run サービス名（`api`） |

## シークレット（GitHub Secrets / Secret Manager）

実値は **Secret Manager** が正（#32 `infra/secret-manager/`）。CD の通知のみ GitHub Secret。

| キー | 供給先 | 調達 |
|---|---|---|
| `SERVER_HMAC_SECRET` | Secret Manager → API/Worker env | 自動生成（#32） |
| `INTERNAL_JOB_TOKEN` | Secret Manager → API/Worker env | 自動生成（#32） |
| `GOOGLE_PLACES_API_KEY` | Secret Manager → API env | owner 調達 |
| `VERTEX_AI_API_KEY` | Secret Manager → API/Worker env | owner 調達 |
| `DEPLOY_NOTIFY_WEBHOOK` | GitHub Secret → CD notify | 任意 |

> 命名ドリフト注記: `.secret.example` の `GEMINI_API_KEY`/`LLM_MODEL_ID` に対し、
> 実コードは `VERTEX_AI_API_KEY`/`VERTEX_AI_MODEL` を読む（#32 README 参照）。

## クライアントビルドの本番値配線

### 患者 Flutter Web（dart-define）

ローカル（`.env.example`）:
```
--dart-define=API_BASE_URL=http://localhost:8080 --dart-define=USE_FIREBASE_EMULATOR=true --dart-define=FIREBASE_PROJECT_ID=demo-mmr-dev
```
本番（CD `deploy-hosting` の `flutter build web` に渡す）:
```
--dart-define=API_BASE_URL=https://api.moshimoshimonshin.com \
--dart-define=USE_FIREBASE_EMULATOR=false \
--dart-define=FIREBASE_PROJECT_ID=project-7efcc4c4-...
```

> `API_BASE_URL` はパスを含まない origin を指定する（アプリ側が `/v1` を付与する。
> `/v1` 付きはクライアント側の origin 検証で起動時に拒否される）。

### 病院 Next.js（`NEXT_PUBLIC_*`）

`npm run build` 実行時の環境変数として上表の `NEXT_PUBLIC_*` 本番値を供給する
（ビルド時にバンドルへ埋め込まれるため、CD の `deploy-hosting` ジョブに env で渡す）。

> **follow-up（owner/別PR）**: CD の `deploy-hosting` ジョブに、これら dart-define /
> `NEXT_PUBLIC_*` 本番値を GitHub Variables から注入するステップ追加が必要
> （本 PR は対応表の正本化まで）。

## ローカル運用との接続（docs/07 §4）

- `make env` が `.env.example`/`.secret.example` から `.env.local`/`.secret.local` を生成。
- ローカルはエミュレータ前提でダミー値／空で動作。本番値は GitHub/Secret Manager 側にのみ置く。
- 秘密値を issue・PR・ログ・スクショに貼らない（§4.3）。
