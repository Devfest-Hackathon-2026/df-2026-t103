# もしもし問診 — Docker / Makefile 運用ガイド

- 文書ID：MMR-OPS-001 / v1.0 / 2026-11-05
- 対象：ローカル開発環境の Docker Compose / Makefile
- 関連：`07_環境構築手順書.md`（導入手順・env管理）、`adr/0001_ローカル開発基盤の構成.md`

## 1. 構成

| サービス | 実行場所 | ポート | 起動条件 |
|---|---|---|---|
| `firebase` | Docker | UI 4000 / Auth 9099 / Firestore 8081 / RTDB 9000 / Storage 9199 | 常時 |
| `api` | Docker | 8080 | `services/api/package.json` が存在 |
| `hospital` | Docker | 3000 | `apps/hospital/package.json` が存在 |
| `patient` | ホスト（flutter run -d web-server） | 5050 | `apps/patient/pubspec.yaml` が存在 |
| `watch` | ホスト（docker compose watch） | - | `make up` で自動起動 |

ファイルの対応：

| ファイル | 役割 |
|---|---|
| `docker-compose.yml` | サービス・ポート・ボリューム・watch定義 |
| `docker/firebase/Dockerfile` + `entrypoint.sh` | Firebase Emulator Suite イメージ（Node 22 + JDK 25 + firebase-tools） |
| `docker/api/Dockerfile` | APIイメージ（`dev`/`prod` マルチステージ） |
| `docker/hospital/Dockerfile` | Next.jsイメージ（`dev`/`prod` マルチステージ） |
| `firebase.json`・`.firebaserc`・`firebase/` | エミュレータ設定・Security Rules・索引 |
| `.env.local` / `.secret.local` | コンテナとmakeへ渡す環境変数（生成は `make env`） |
| `.local/run/*.pid`・`.local/logs/*.log` | ホスト側プロセス（watch/patient）のPIDとログ |

## 2. Makefileコマンド一覧

### 基本

| コマンド | 内容 |
|---|---|
| `make help` | コマンド一覧 |
| `make doctor` | ツール導入状態の確認 |
| `make env` | `.env.local` / `.secret.local` を雛形から生成 |
| `make urls` | 各サービスのURL一覧 |
| `make ps` | コンテナ＋ホストプロセスの状態 |

### 起動・停止（全体）

| コマンド | 内容 |
|---|---|
| `make up` | 全部起動：env生成 → `docker compose up -d --build` → watch起動 → flutter起動 |
| `make down` | 全部停止：watch・patient・`docker compose down` |
| `make restart` | `down` → `up` |
| `make rebuild` | イメージ再ビルドして起動 |
| `make clean` | `down`＋ボリューム削除（**エミュレータデータ消去**）＋`.local`削除 |

### サービスをひとつずつ止める

| 対象 | 停止 | 起動 | 再起動 |
|---|---|---|---|
| Firebaseエミュレータ | `make stop-firebase` | `make start-firebase` | `make restart-firebase` |
| API | `make stop-api` | `make start-api` | `make restart-api` |
| 病院ポータル | `make stop-hospital` | `make start-hospital` | `make restart-hospital` |
| 患者アプリ | `make stop-patient` | `make patient-start` | `make restart-patient` |
| ファイル監視 | `make stop-watch` | `make watch-start` | `make restart-watch` |

docker compose を直接使って止める場合: `docker compose stop api`（サービス名指定）。
コンテナごと消したい場合: `docker compose rm -sf api`。

### ログ

| コマンド | 内容 |
|---|---|
| `make logs` | 全Dockerサービス |
| `make logs-firebase` / `make logs-api` / `make logs-hospital` | サービス別 |
| `make logs-patient` | Flutter Web ログ（`.local/logs/patient.log`） |
| `make logs-watch` | compose watch ログ |

### その他

| コマンド | 内容 |
|---|---|
| `make install-templates` | `.github/template/` を `.github/PULL_REQUEST_TEMPLATE.md`・`.github/ISSUE_TEMPLATE/` へコピー |

## 3. `make up` がやること（順序）

1. `.env.local` / `.secret.local` が無ければ雛形から生成
2. `.local/run/` `.local/logs/` とアプリ用ディレクトリを作成
3. Dockerデーモン起動確認
4. `package.json`/`pubspec.yaml` の有無を検出し、起動対象を決定（実装が無ければ firebase のみ）
5. `docker compose up -d --build <検出したサービス>`
6. `docker compose watch` をバックグラウンド起動（PID: `.local/run/watch.pid`）
7. `apps/patient` があれば `flutter run -d web-server` をバックグラウンド起動（PID: `.local/run/patient.pid`）
8. URL一覧を表示

冪等なので、実装追加後・設定変更後は `make up` を再実行すれば差分が適用される。

## 4. ファイル変更時の自動適用

| 変更 | 仕組み | 結果 |
|---|---|---|
| `services/api`・`apps/hospital` のコード | compose watch の `sync`（＋バインドマウント） | devサーバが検出してホットリロード |
| `package.json` | watch の `sync+restart` | コンテナ再起動→起動時 `npm install` で依存更新 |
| `firebase.json`・`firebase/` | watch の `restart` | エミュレータ再起動 |
| `apps/patient` | flutter run のホットリロード | 保存で即時反映 |
| `docker-compose.yml`・Dockerfile | `make up`/`make rebuild` の `--build` | イメージ再構築（キャッシュ利用） |

## 5. エミュレータデータ

- `firebase-emulator-data` ボリュームに `entrypoint.sh` が `--export-on-exit` で保存し、次回起動時に `--import` で復元する。
- `make down` ではデータは残る。消すのは `make clean` のみ。

## 6. よくある運用シナリオ

```bash
# 開発を始める
make up && make urls

# APIだけログを見ながら作業（別ターミナル）
make logs-api

# 依存を追加した（package.json変更）→ 自動で sync+restart。手動なら:
make restart-api

# エミュレータのルールを変えた → 自動再起動。確認:
make logs-firebase

# 全部リセットしたい（エミュレータデータも消す）
make clean && make up

# 終了
make down
```

## 7. docker compose を直接使う場合

Makefileは実装の有無でサービスを絞っているため、直接叩くときはサービス名を明示する。

```bash
docker compose up -d firebase                 # エミュレータのみ
docker compose up -d --build firebase api     # API実装がある場合
docker compose logs -f firebase
docker compose stop firebase
```

`.env.local` / `.secret.local` は `env_file`（`required: false`）で読むため、無くてもエミュレータ単体は起動する。

## 8. トラブル対応

| 症状 | 対処 |
|---|---|
| watch が死んでいる | `make restart-watch`。ログは `make logs-watch` |
| patient が止まらない | `make stop-patient` はPID kill＋`pkill`併用。最終手段 `pkill -f "web-port[= ]5050"` |
| `npm install` がコンテナ内で失敗 | `docker compose logs api`。`make rebuild` または `docker compose rm -sf api && make start-api` |
| ポート競合 | `.env.local` の `*_PORT` を変更し `make restart` |
| ボリュームのnode_modulesが古い | `docker compose down -v` 相当の `make clean` |
| Imageを作り直したい | `make rebuild`、完全にやり直すなら `docker compose build --no-cache firebase` |

## 9. セキュリティ上の注意

- `docker-compose.yml` の env_file は `.env.local` / `.secret.local` を読む。**秘密値をDockerfile・イメージ・gitに焼き込まない**。
- Firebase Emulator のプロジェクトIDは `demo-mmr-dev`（ダミー）。本番プロジェクトIDを `.env.local` に書いた場合でも、本番接続に必要な資格情報をローカルに置く運用は行わない。
- エミュレータに入れるデータは全て合成データとする（`mmr-dev` 方針に準拠）。
