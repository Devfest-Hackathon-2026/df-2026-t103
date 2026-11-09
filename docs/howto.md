# もしもし問診 — ローカル動作確認・実機テスト手順

- 対象：開発者がローカルで Web / Mobile（Android・iOS）の動作確認を行うための手順
- 関連：[07_環境構築手順書](07_環境構築手順書.md)、[08_Docker_Makefile運用](08_Docker_Makefile運用.md)、[09_USEFUL_COMMANDS](09_USEFUL_COMMANDS.md)、[11_患者画面プレビュー](11_患者画面プレビュー.md)、[apps/patient/README.md](../apps/patient/README.md)、[apps/hospital/README.md](../apps/hospital/README.md)
- 方針：ローカル検証は **Firebase Emulator + 合成データ** 前提。実患者データ・実在施設の非公開情報・本番資格情報は使わない。

## 1. 前提ツール

| ツール | 用途 | 必須度 |
|---|---|---|
| Docker（Compose 同梱） | Firebase Emulator / API / 病院ポータル | 必須 |
| Make | 起動・停止の統合コマンド | 必須 |
| Flutter SDK（Dart 同梱） | 患者アプリ（Web/ネイティブ）。CI は **3.47.4** で検証 | 患者アプリ確認時に必須 |
| Node.js 22 以降 | API / Next.js をホストで直接動かす・テスト実行 | Docker 利用時は任意 |
| JRE（Java 21 以降） | `firebase-tools` でエミュレータをホスト起動する場合（E2E 等） | E2E 実行時に必須 |
| Android Studio + SDK | Android エミュレータ / 実機 | Android 確認時に必須 |
| Xcode + CocoaPods | iOS シミュレータ / 実機 | iOS 確認時に必須（macOS のみ） |

```bash
make doctor   # 導入状態と Docker デーモンの確認
```

Nix flakes が使える環境では `nix develop` で Flutter / Node / Docker CLI / Make を一括導入できる
（`x86_64-linux` / `aarch64-linux` / `aarch64-darwin` のみ。Intel Mac・Android SDK・Xcode は対象外。
詳細は [Nix開発環境](Nix開発環境.md)）。

## 2. Web のローカル動作確認

### 2.1 一括起動

```bash
make up           # env生成 → Docker(エミュレータ/API/ポータル) → ファイル監視 → Flutter Web
make up SEED=1    # 上記に加えて起動完了後に合成テストデータ（シード）を投入
make urls         # 起動後のURL一覧
make ps           # 起動状態の確認
make down         # 全停止
```

`make up` は `apps/hospital/package.json` / `services/api/package.json` / `apps/patient/pubspec.yaml`
の存在を検出して起動対象を決める。冪等なので再実行で差分が適用される。

**テストデータ（シード）の投入**

通常の `make up` ではシードは入らない（エミュレータは前回 `make down` 時に
エクスポートされた状態を復元するだけ）。合成テストデータを投入するには:

```bash
make up SEED=1    # 起動と同時にシード投入（api/エミュレータの healthy を待って実行）
make seed         # 起動済み環境に後から投入
```

いずれも `services/api/scripts/seedPatientE2E.mjs` を api コンテナ内で実行し、
以下の合成アカウント等が作られる（すべてローカルエミュレータ専用。実環境では絶対に使わない）:

| 用途 | Email | Password | 状態 |
|---|---|---|---|
| 登録済み患者 | `synthetic-intake-ui@example.test` | `local-only-intake-123!` | 同意・プロフィール完了 |
| 同意ゲート用 | `synthetic-consent-gate@example.test` | `local-only-gate-123!` | 同意未完了（`legal_pending`） |
| 病院ポータル職員 | `synthetic-staff@example.test` | `local-only-staff-123!` | 施設 `fac-synthetic-demo` の `facility_admin` |
| ポータル運営 | `synthetic-operator@example.test` | `local-only-operator-123!` | `platform_security_admin` |

加えて `appConfigs/publicLegalVersion`（`/auth/register` の同意文書バージョン）と
施設 `fac-synthetic-demo`（verified・受付有効）も投入される。

**ログイン先の対応**

- 患者アプリ（http://localhost:5050）: 患者アカウント。未登録なら
  「利用開始」→「メールアドレスで続ける」→「新規登録」で実登録も可能
  （`POST /v1/auth/register` + 必須同意チェック）。
- 病院ポータル（http://localhost:3000/login）: 職員アカウント
  （`facility_staff`/`facility_clinician`/`facility_admin` の active membership が必要。
  患者アカウントでは所属が無く使えない）。
- 運営コンソール（http://localhost:3000/operator）: 運営アカウント
  （`platform_security_admin` membership が必要）。
投入内容の正本は `seedPatientE2E.mjs`（E2E と同一フィクスチャ）。
`make seed` は `docker compose watch` 起動直後のコンテナ再作成にも耐えるよう
api/firebase の `healthy` を待機するため、初回実行は数十秒かかることがある。

### 2.2 起動後の URL と確認ポイント

| URL | 内容 | 確認ポイント |
|---|---|---|
| http://localhost:5050 | 患者アプリ（Flutter Web、`flutter run -d web-server`） | `main.dart` の通常起動。Firebase Emulator に接続する |
| http://localhost:3000 | 病院ポータル（Next.js dev） | `/login`（職員）、`/operator`（運営）、`/facilities`、`/deliveries`、`/staff`、`/settings`。職員はシードの `synthetic-staff@example.test`、運営は `synthetic-operator@example.test` |
| http://localhost:3000/dev/catalog | 病院ポータルのデザインカタログ | dev のみ有効（本番ビルドでは 404） |
| http://localhost:8080 | API（Fastify） | `curl http://localhost:8080/healthz`、Swagger UI は `/docs` |
| http://localhost:4000 | Firebase Emulator Suite UI | Auth / Firestore / RTDB / Storage の中身を閲覧・編集できる |

エミュレータの個別ポート（ホスト側）:

| サービス | ポート | 確認方法 |
|---|---|---|
| Auth | 9099 | `curl 'http://localhost:9099/identitytoolkit.googleapis.com/v1/projects'` |
| Firestore | 8081（コンテナ内 8080） | `curl http://localhost:8081/` |
| Realtime DB | 9000 | `curl 'http://localhost:9000/.json?ns=demo-mmr-dev'` |
| Storage | 9199 | `curl http://localhost:9199/` |

### 2.3 個別起動・停止・ログ

| 対象 | 起動 | 停止 | ログ |
|---|---|---|---|
| Firebase Emulator | `make start-firebase` | `make stop-firebase` | `make logs-firebase` |
| API | `make start-api` | `make stop-api` | `make logs-api` |
| 病院ポータル | `make start-hospital` | `make stop-hospital` | `make logs-hospital` |
| 患者アプリ（Web） | `make patient-start` | `make stop-patient` | `make logs-patient` |
| ファイル監視 | `make watch-start` | `make stop-watch` | `make logs-watch` |

### 2.4 患者アプリの画面単体プレビュー（Docker・Firebase 不要）

画面の見た目だけを確認したい場合、Flutter SDK さえあれば Firebase Emulator や API なしで
1 画面ずつ起動できる（`lib/demo_*_preview.dart` は Firebase/API/実送信に接続しない）。

```bash
# 起動できるプレビュー名と割り当てポートの一覧（lib/demo_*_preview.dart から自動導出）
bash apps/patient/preview.sh list

# 指定画面を単独起動（例: home, symptom, body_diagram, review, account ...）
bash apps/patient/preview.sh <name>          # 既定ポート
bash apps/patient/preview.sh <name> 5080     # ポート明示

# welcome は main.dart の通常起動で Firebase Emulator が前提
bash apps/patient/preview.sh welcome
```

起動後は表示される `http://127.0.0.1:<port>` をブラウザで開く。終了は Ctrl+C。
`flutter run -d web-server --web-hostname=127.0.0.1 --web-port=<port> -t lib/demo_<name>_preview.dart`
と同等。詳細は [11_患者画面プレビュー](11_患者画面プレビュー.md) と
[apps/patient/README.md](../apps/patient/README.md)。

### 2.5 架空の問診フローデモ（Docker・Firebase 不要）

同意→部位選択→症状→模擬送信までの一連フローを、固定サンプルだけで確認できる
（実送信はしない。詳細は [FICTIONAL_DEMO.md](../apps/patient/FICTIONAL_DEMO.md)）。

```bash
cd apps/patient
flutter pub get
flutter run -d web-server --web-hostname=127.0.0.1 --web-port=5059 -t lib/demo_fictional_flow.dart
```

### 2.6 変更の自動反映

| 変更対象 | 反映方法 |
|---|---|
| `services/api` のコード | バインドマウント + コンテナ内 `tsx watch` が自動再起動 |
| `apps/hospital` のコード | バインドマウント + Next.js dev のホットリロード |
| `package.json`（依存追加） | `make restart-api` / `make restart-hospital` |
| `firebase.json`・`firebase/` 配下 | compose watch の `sync+restart` でエミュレータ再起動 |
| `apps/patient` のコード | `flutter run` のホットリロード |

## 3. 自動テスト・結合試験（ローカル検証）

CI と同等のチェックをローカルで実行できる。対象ディレクトリで実行すること。

| 対象 | コマンド | 前提 |
|---|---|---|
| API 単体/型/静的 | `npm run typecheck` / `npm run lint` / `npm test` / `npm run build`（`services/api`） | `npm ci` 済み |
| API エミュレータ結合 | `make test-api-emulator` | compose のエミュレータ起動中 |
| Security Rules 単体 | `make test-firebase-rules` | compose のエミュレータ起動中 |
| 病院ポータル 単体 | `npm run lint` / `npm test` / `npm run build` / `npm run test:security`（`apps/hospital`） | `npm ci` 済み |
| 病院 エミュレータ結合 | `npm run test:emulator`（`apps/hospital`。env 指定は README 参照） | Auth/Firestore/Storage エミュレータ起動中 |
| 病院 実API結合（HTTP） | `npm run test:api`（`apps/hospital`） | 下記の専用エミュレータ経由 |
| 病院 実ブラウザ E2E | `npm run test:browser`（`apps/hospital`） | macOS は標準 Chrome、Linux は `/usr/bin/google-chrome`（`HOSPITAL_CHROME_PATH` で上書き可） |
| 患者アプリ 単体/静的 | `flutter analyze` / `flutter test`（`apps/patient`） | `flutter pub get` 済み |
| 患者 実 E2E（E2E-001/001B/002） | `bash apps/patient/tool/run_intake_e2e.sh` | JRE + firebase-tools + node + Flutter。エミュレータ・実 API・シード投入・flutter test を自動で立上げ・破棄 |
| 患者 メール登録結合 | `flutter test --dart-define=RUN_DEMO_AUTH_INTEGRATION=true test/integration/demo_email_registration_test.dart` | API `127.0.0.1:8080` + Auth 9099 + Firestore 8081 起動中（使い捨て環境のみ） |
| 患者 問診 UI 統合 | `flutter test --dart-define=RUN_INTAKE_UI_INTEGRATION=true test/integration/` | 同上（`tool/run_intake_e2e.sh` が内部で実行） |

病院の `test:api` / `test:browser` は、専用ポートのエミュレータ設定
（`firebase.hospital-test.json`：Auth 19099 / Firestore 18081）を `firebase-tools` で起動して実行する。

```bash
cd apps/hospital
FIREBASE_PROJECT_ID=demo-mmr-dev \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:19099 \
FIRESTORE_EMULATOR_HOST=127.0.0.1:18081 \
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:19199 \
FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:19000 \
npx --yes firebase-tools@15.35.0 emulators:exec --project demo-mmr-dev \
  --config ../../firebase.hospital-test.json --only auth,firestore 'npm run test:api'
# ブラウザ込みにする場合は末尾を 'npm run test:browser'
```

CI との対応：`ci`（API 型/単体/結合・Docker build）、`hospital-ci`（lint/test/build/test:security + test:browser）、
`patient-ci`（analyze/test + `run_intake_e2e.sh`）、`security`（gitleaks/npm audit/OSV/コンテナ scan/rules 検証）。

## 4. 実機テスト（Mobile）

### 4.1 前提：エミュレータ接続のホストガード

患者アプリには **ループバック限定のホストガード**（`lib/firebase_bootstrap.dart` と
`lib/demo_registration_transport.dart`）があり、実機テストの可否はこの制約で決まる。

- Firebase 接続先は `localhost` / `127.0.0.1` のみ許可。**Android 非 Web ビルドだけ** `10.0.2.2` も許可。
  `--dart-define=FIREBASE_EMULATOR_HOST=<host>` で上書きできるがこの範囲内に限る（範囲外は起動時 `StateError`）。
- `FIREBASE_PROJECT_ID` は `demo-mmr-dev` 固定、`USE_FIREBASE_EMULATOR=true` 必須。
  **実 Firebase プロジェクトへの接続はコード上未対応**（`validate` で拒否）。
- API の `API_BASE_URL` は origin 完全一致で `http://localhost:8080` / `http://127.0.0.1:8080`
  （Android 非 Web は `http://10.0.2.2:8080`）のみ許可。**`/v1` などのパスを付けると
  `ArgumentError` になる**（アプリ内で `/v1` を付与する）。API ホストは Firebase ホストと
  一致している必要がある。
- Android の HTTP 平文（cleartext）は `android/app/src/debug/AndroidManifest.xml` の
  `usesCleartextTraffic="true"` で許可済み。**debug ビルドのみ**。release では無効。

| 実行形態 | Firebase 接続先（既定） | `API_BASE_URL` 指定例 | 可否 |
|---|---|---|---|
| Web（`web-server`） | `localhost` | `http://localhost:8080` | 対応（`make up` の既定構成） |
| Android エミュレータ | `10.0.2.2` | `http://10.0.2.2:8080` | 対応（§4.2） |
| iOS シミュレータ | `localhost` | `http://localhost:8080` | 対応（§4.4、要 macOS+Xcode） |
| Android 実機 | `localhost`（adb reverse 経由） | `http://localhost:8080` | 構成上は可能だが**リポジトリとして未検証**（§4.3） |
| iOS 実機 | - | - | **未対応**（§4.5） |
| 実機ブラウザで Web 版 | - | - | **未対応**（§4.6。画面のみの例外あり） |

### 4.2 Android エミュレータ

最も手軽なネイティブ確認経路。Android Studio / SDK と AVD（仮想デバイス）を用意し、
Docker 側（エミュレータ + API）を起動した状態で実行する。

```bash
# 1. Docker 側を起動（firebase + api が必須）
make start-firebase start-api    # または make up

# 2. AVD の確認・起動（Android Studio の Device Manager でも可）
flutter emulators                          # 作成済み AVD 一覧
flutter emulators --launch <emulator_id>   # 起動
flutter devices                            # emulator-5554 等のデバイスIDを確認

# 3. 患者アプリを起動（FIREBASE_EMULATOR_HOST 未指定 → 自動で 10.0.2.2）
cd apps/patient
flutter run -d emulator-5554 \
  --dart-define=USE_FIREBASE_EMULATOR=true \
  --dart-define=FIREBASE_PROJECT_ID=demo-mmr-dev \
  --dart-define=API_BASE_URL=http://10.0.2.2:8080
```

- `10.0.2.2` は Android エミュレータから見たホストマシンの別名。ホストに公開された
  Docker ポート（9099/8081/9000/9199/8080）経由でエミュレータと API に到達する。
- `API_BASE_URL` は `http://10.0.2.2:8080`（`/v1` なし）を指定する。未指定でも
  `http://<host>:8080` が既定で組み立てられるが、明示を推奨。
- ホットリロードは `flutter run` のターミナルで `r`、再起動は `R`、終了は `q`。

### 4.3 Android 実機（USB）

1. 端末で「開発者向けオプション」→「USB デバッグ」を有効化し、USB 接続。
2. `flutter devices`（または `adb devices`）で認識を確認し、`flutter run -d <device-id>` で起動。

**Firebase/API への接続**：端末から開発機の LAN IP への直結はホストガードで拒否される
（リポジトリ方針としても実機 LAN 接続は未対応・エミュレータの外部公開は想定外）。
代替として `adb reverse` で端末の localhost を開発機の localhost に転送する構成が
**コード上は成立する**（ホストガードは `localhost` を全プラットフォームで許可）。
ただし本リポジトリの文書・CI で実機検証は実施されていないため、**未検証の経路**として扱うこと。

```bash
# 端末 localhost:<port> → PC localhost:<port>（Docker 公開ポート）へ転送
adb reverse tcp:9099 tcp:9099   # Auth
adb reverse tcp:8081 tcp:8081   # Firestore
adb reverse tcp:9000 tcp:9000   # Realtime DB
adb reverse tcp:9199 tcp:9199   # Storage（署名 URL の公開ホストも localhost:9199）
adb reverse tcp:8080 tcp:8080   # API

cd apps/patient
flutter run -d <device-id> \
  --dart-define=USE_FIREBASE_EMULATOR=true \
  --dart-define=FIREBASE_PROJECT_ID=demo-mmr-dev \
  --dart-define=FIREBASE_EMULATOR_HOST=localhost \
  --dart-define=API_BASE_URL=http://localhost:8080

# 転送の解除（USB 切断でも消える）
adb reverse --remove-all
```

- debug ビルドは `usesCleartextTraffic="true"` で平文 HTTP が許可される。profile/release は不可。
- USB 経由なので同一 Wi-Fi 不要。ただし `adb reverse` は端末の localhost 宛のみで、
  LAN の他端末からは使えない。
- この経路で問題が見つかった場合は、ホストガードの挙動・署名 URL・権限周りを個別に確認し、
  結果をチームへ報告する（公式な動作保証経路ではない）。

### 4.4 iOS シミュレータ（macOS のみ）

Xcode + CocoaPods が必要（`brew install cocoapods`）。Linux / Windows では不可。

```bash
# 1. Docker 側を起動
make start-firebase start-api    # または make up

# 2. シミュレータ起動（Xcode > Open Developer Tool > Simulator でも可）
open -a Simulator
flutter devices                  # ios シミュレータのデバイスIDを確認

# 3. 起動（既定ホスト localhost のまま）
cd apps/patient
flutter run -d <simulator-id> \
  --dart-define=USE_FIREBASE_EMULATOR=true \
  --dart-define=FIREBASE_PROJECT_ID=demo-mmr-dev \
  --dart-define=API_BASE_URL=http://localhost:8080
```

iOS シミュレータは macOS 上で動作するため `localhost` でホストのエミュレータ・API に届く。
localhost への HTTP は ATS の対象外のため `Info.plist` への例外追加は不要。
実機検証は未実施のため、初回起動時に問題があれば `flutter doctor` と CocoaPods の状態を確認する。

### 4.5 iOS 実機（現状未対応）

- 端末上の `localhost` は端末自身を指し、iOS には端末→PC 方向の公式 USB リバーストンネルがない。
- ホストガードがループバック限定のため、開発機 LAN IP への直結も拒否される。
- アプリは `demo-mmr-dev` + `USE_FIREBASE_EMULATOR=true` 固定で実 Firebase 接続も未対応。

したがって **iOS 実機でのローカル動作確認は現状できない**。実機確認には、本番相当の
Firebase プロジェクト + HTTPS API への接続実装と、それを許可する設定・審査が別途必要。

### 4.6 実機ブラウザで Web 版を見る場合（制約）

- 患者アプリ（`flutter run -d web-server`）は既定 `localhost` バインド。`--web-hostname=0.0.0.0`
  で起動すれば同一 LAN の実機ブラウザから `http://<開発機IP>:<port>` で開けるが、
  `main.dart` は Firebase 初期化でループバック限定ガードにかかり、実機ブラウザからは
  接続できない（実機から見て `localhost` は実機自身）。**通常起動の実機ブラウザ確認は未対応**。
  `demo_*_preview.dart` は Firebase に接続しないため、0.0.0.0 公開すれば画面の見た目だけは
  確認できる可能性がある（未検証・合成データのみ・LAN 公開の注意）。
- 病院ポータルは `next dev --hostname 0.0.0.0` 既定で外部公開されるが、`NEXT_PUBLIC_*` が
  localhost 前提のため、実機ブラウザでは Auth/API 接続が動かない。ログイン以降は未対応。
- 実用的な代替は、PC ブラウザの DevTools デバイスモードでのレスポンシブ確認。

### 4.7 実機・支援技術で確認すべき項目

自動テスト（`test/a11y_acceptance_test.dart`）の範囲外で、実機確認が必要な受入項目
（[ACCESSIBILITY.md](../apps/patient/ACCESSIBILITY.md) より）。

- TalkBack（Android）/ VoiceOver（iOS）の読み上げ順序と自然さ
- OS の文字拡大（最大 200% 想定）で全操作に到達できること
- 実機の表示サイズ・フォント設定との組み合わせ
- 色コントラスト比の最終確認（AA 比）
- キーボード / スイッチ操作でのフォーカス順序
- Web とは別に、Android / iOS 実機での表示・操作差の確認

## 5. 実環境（stg/本番相当）への接続

- 患者アプリは `validate` が `demo-mmr-dev` 固定のため、**実 Firebase / 本番 API への接続は未対応**。
  本番配線（`flutter build web --dart-define=USE_FIREBASE_EMULATOR=false ...`）は CD の
  `deploy-hosting` で扱う予定で、実機向け実環境接続も別途実装・審査が必要。
- 病院ポータルは `NEXT_PUBLIC_USE_FIREBASE_EMULATOR=false` + 実プロジェクト ID +
  `NEXT_PUBLIC_FIREBASE_API_KEY` / `APP_ID` / `AUTH_DOMAIN` / `APP_CHECK_SITE_KEY` +
  `NEXT_PUBLIC_API_BASE_URL=<https API>/v1` で実環境接続できる（本番値は GitHub Variables /
  Secret Manager が正。[infra/ENVIRONMENT.md](../infra/ENVIRONMENT.md)）。`NEXT_PUBLIC_*` は
  ビルド時埋め込みのため変更後は再ビルド。
- ローカルには本番資格情報・実患者データを置かない（[07_環境構築手順書](07_環境構築手順書.md) §4）。

## 6. トラブルシューティング

| 症状 | 確認・対処 |
|---|---|
| `Docker daemonが起動していません` | Docker Desktop を起動 → `make doctor` |
| ポートが使えない | `lsof -i :<port>` で既存プロセスを停止、または `.env.local` の `*_PORT` を変更 |
| エミュレータが起動しない | `make logs-firebase` → `make rebuild` |
| 変更が反映されない | api/hospital はログ確認。firebase ルールは `make ps` で watch 確認 → `make restart-watch` |
| `StateError: Firebase requires the demo emulator configuration` | `USE_FIREBASE_EMULATOR=true` と `FIREBASE_PROJECT_ID=demo-mmr-dev` の両方が必要 |
| `StateError: Firebase demo emulator host must be ...` | `FIREBASE_EMULATOR_HOST` が `localhost`/`127.0.0.1`/`10.0.2.2` 以外 |
| `ArgumentError: Only explicit local demo API origins are allowed` | `API_BASE_URL` に `/v1` などのパス・ポート違い・LAN IP が含まれている（§7） |
| Android エミュレータから API に繋がらない | `API_BASE_URL=http://10.0.2.2:8080` を指定し、Firebase ホストと一致させる |
| Android 実機で接続できない | `adb reverse` の設定漏れ（`adb reverse --list` で確認）、debug ビルドか確認 |
| patient が止まらない | `make stop-patient`。最終手段 `pkill -f "web-port[= ]5050"` |
| エミュレータのデータを消したい | `make clean` → `make up`（全削除） |

## 7. 既知の不整合・注意点

- **`API_BASE_URL` には `/v1` などのパスを付けない**。`requireDemoApiOrigin` は
  `http://localhost:8080` 等のパスなし origin の完全一致のみ許可し、クライアント内部で
  `/v1` を付与する。`/v1` 付きを渡すと起動時に `ArgumentError` で白画面になる
  （`main.dart:12` → `FirebaseIntakeConnection` → `PatientIntakeApi`）。
  雛形・Makefile・`.env.local` の既定値は `http://localhost:8080`（パスなし）に修正済み。
  古い `.env.local` を保持している環境では同じ修正を手元の `.env.local` に反映すること。
- 実機 Android の `adb reverse` 経路（§4.3）はコード上成立する構成だが、リポジトリの文書は
  「実機の LAN 接続未対応」「実機確認未実施」を明記しており、公式な動作保証経路ではない。
- Firebase Emulator は `0.0.0.0` で listen するが、アプリ側ガードとリポジトリ方針により
  **LAN 公開しての実機接続は想定外**。エミュレータを外部ネットワークに公開しない。
- `apps/patient` は `google-services.json` / `GoogleService-Info.plist` を持たず、
  `FirebaseOptions` をコード内で dummy 値として生成する（エミュレータ専用構成）。
- エミュレータのデータは `firebase-emulator-data` ボリュームに保存され、`make down` では残る。
  消去は `make clean` のみ。

## 8. 関連ドキュメント

- [07_環境構築手順書](07_環境構築手順書.md) — ツール導入・`.env.local` / `.secret.local` の管理
- [08_Docker_Makefile運用](08_Docker_Makefile運用.md) — Makefile / Compose の詳細運用
- [09_USEFUL_COMMANDS](09_USEFUL_COMMANDS.md) — 日々のコマンド集
- [11_患者画面プレビュー](11_患者画面プレビュー.md) — 画面単体プレビューの詳細
- [apps/patient/README.md](../apps/patient/README.md) / [FICTIONAL_DEMO.md](../apps/patient/FICTIONAL_DEMO.md) / [ACCESSIBILITY.md](../apps/patient/ACCESSIBILITY.md)
- [apps/hospital/README.md](../apps/hospital/README.md) — 病院ポータルの接続・結合試験
- [infra/ENVIRONMENT.md](../infra/ENVIRONMENT.md) — ローカル/GitHub/GCP の環境変数配線
- [docs/CD.md](CD.md) — CI/CD と本番配信の運用
