# もしもし問診 — 開発でよく使うコマンド集

- 文書ID：MMR-OPS-009 / v1.0 / 2026-11-05
- 前提：[07_環境構築手順書](07_環境構築手順書.md) のセットアップ済み。詳細な運用は [08_Docker_Makefile運用](08_Docker_Makefile運用.md) を参照。
- 原則このリポジトリのルート（`Makefile` がある階層）で実行する。

## 1. 日々の起動・停止（Makefile）

| コマンド | 内容 |
|---|---|
| `make doctor` | Docker / Make / Flutter の導入状態を確認 |
| `make up` | env自動生成 → Firebaseエミュレータ等のコンテナ起動 → ファイル監視 → Flutter Web起動 |
| `make up SEED=1` | 上記＋起動完了後に合成テストデータを投入 |
| `make seed` | 起動済み環境へ合成テストデータを投入（`services/api/scripts/seedPatientE2E.mjs`） |
| `make urls` | 各サービスのURL一覧 |
| `make ps` | コンテナ＋ホストプロセスの状態 |
| `make down` | 全停止（コンテナ・watch・Flutter） |

### 個別操作

| コマンド | 内容 |
|---|---|
| `make start-firebase` / `make stop-firebase` / `make restart-firebase` | Firebaseエミュレータのみ |
| `make start-api` / `make stop-api` / `make restart-api` | APIのみ（`services/api` 存在時） |
| `make start-hospital` / `make stop-hospital` / `make restart-hospital` | 病院ポータルのみ（`apps/hospital` 存在時） |
| `make patient-start` / `make patient-stop`（別名 `stop-patient`）/ `make restart-patient` | Flutter患者アプリのみ（`apps/patient` 存在時） |
| `make watch-start` / `make watch-stop` | ファイル変更の自動適用（compose watch） |
| `make logs` / `make logs-firebase` / `make logs-api` / `make logs-hospital` / `make logs-patient` | ログ表示 |
| `make rebuild` | イメージ再ビルドして起動 |
| `make restart` / `make restart-firebase` / `make restart-api` / `make restart-hospital` / `make restart-watch` | 全体・個別の再起動 |
| `make clean` | コンテナ・ボリューム・ローカル状態を全削除（エミュレータのデータも消える） |
| `make install-templates` | `.github/template/` をGitHub正式パスへコピー |

## 2. Docker / Compose を直接触る

```bash
docker compose ps                    # サービス状態
docker compose logs -f firebase      # ログをフォロー
docker compose up -d firebase        # firebaseだけ起動
docker compose stop api              # 個別停止
docker compose exec firebase sh      # コンテナに入る
docker compose config                # 最終構成を検証・表示
docker compose watch                 # 変更の自動適用（make up の内部処理）
docker system df                     # 使用量確認
docker system prune                  # 使っていないリソースの掃除（-a は全イメージ消去なので注意）
```

## 3. エミュレータの動作確認（curl）

```bash
curl http://localhost:4000                                  # Emulator Suite UI
curl http://localhost:8081/                                 # Firestoreエミュレータ
curl 'http://localhost:9099/identitytoolkit.googleapis.com/v1/projects'  # Authエミュレータ
curl http://localhost:9199/                                 # Storageエミュレータ
curl 'http://localhost:9000/.json?ns=demo-mmr-dev'          # Realtime DBエミュレータ
curl http://localhost:8080/healthz                          # API（実装後）
```

## 4. Flutter / Dart（患者アプリ：`apps/patient` 作成後）

```bash
flutter doctor                       # Flutter環境の診断
flutter pub get                      # 依存取得（package変更時も）
flutter run -d web-server --web-port=5050   # make up が内部で実行（Web確認用）
flutter run -d ios                   # iOSシミュレータ（要Xcode）
flutter run -d android               # Androidエミュレータ/実機
flutter analyze                      # 静的解析
flutter test                         # テスト
flutter build apk / ios / web        # リリースビルド
dart format .                        # フォーマット
```

### FlutterFire（Firebase接続設定）

```bash
dart pub global activate flutterfire_cli   # 初回のみ
firebase login                             # 初回のみ（実プロジェクト利用時）
cd apps/patient
flutterfire configure --project=<project-id>   # firebase_options.dart を生成
```

- ローカル開発はエミュレータ（`demo-mmr-dev`）を使うため、`flutterfire configure` は本番/stg向けの実プロジェクトが出来てから行う。
- エミュレータ接続はアプリ側で明示する（例：`FirebaseAuth.instance.useAuthEmulator('localhost', 9099)`、`FirebaseFirestore.instance.useFirestoreEmulator('localhost', 8081)`）。接続先は `.env.local` の値と揃える。

### Security Rules 単体テスト（`firebase/tests`）

```bash
make test-firebase-rules   # compose のエミュレータ起動中に実行
# または: npm --prefix firebase/tests run test:compose
# CI相当（エミュレータを自動起動）: firebase emulators:exec --only firestore,database,storage --project demo-mmr-dev "npm --prefix firebase/tests test"
```

## 5. Firebase CLI（ホストで直接使う場合）

ホストから利用する場合は、リポジトリルートで `nix develop` に入ると利用できます。
Nix を使わない場合は `firebase-tools` を別途導入します。認証やデプロイは必要な場合のみ手動で実行してください。

```bash
npm install -g firebase-tools@15.35.0  # Nix devShell を使わない場合のみ
firebase login                         # 必要な場合のみ（認証情報はローカルに保存）
firebase use <project-id>              # プロジェクト切替（.firebaserc）
firebase emulators:start               # ローカルエミュレータ（Dockerを使わない場合）
firebase emulators:export ./backup     # エミュレータデータのエクスポート
firebase deploy --only hosting         # Hostingデプロイ（本番/stg、権限・審査後）
firebase deploy --only firestore:rules # Security Rulesデプロイ
```

- **本番 `deploy`・`firebase use` は本ドキュメント対象外**。まずエミュレータで完結させる（docs/02 の環境分離方針）。

## 6. Node.js / npm（`services/api`、`apps/hospital` 作成後）

```bash
cd services/api  # or apps/hospital
npm install        # 依存取得（package.json変更時も。コンテナ内でも自動実行）
npm run dev        # 開発サーバ（コンテナではなく直で動かす場合）
npm run build      # ビルド
npm run lint       # Lint
npm run test       # テスト
npx tsc --noEmit   # TypeScriptの型チェックのみ
```

### API エミュレータ結合テスト（`services/api/test/integration`）

```bash
make test-api-emulator     # compose のエミュレータ起動中に実行
# または: npm --prefix services/api run test:emulator:compose
# CI相当（エミュレータを自動起動）: firebase emulators:exec --only auth,firestore --project demo-mmr-dev "npm --prefix services/api run test:emulator"
```

## 7. よくある確認・トラブル対処

```bash
make logs-firebase                   # エミュレータが起動しない時
lsof -i :4000 -i :8081 -i :9099      # ポートの使用元を確認（macOS）
docker compose config --quiet        # compose定義の文法チェック
git status --short                   # 変更差分の確認（.env.local/.secret.local が出たらコミット禁止を確認）
```

| 症状 | まず試す |
|---|---|
| コンテナが起動しない | `make logs-<サービス>` → `make rebuild` |
| 変更が反映されない | `make ps` でwatchが動いているか → `make watch-stop && make watch-start` |
| ポートが既に使われている | `lsof -i :<port>` で停止してから `make up` |
| エミュレータのデータを初期化したい | `make clean` → `make up`（全削除に注意） |
