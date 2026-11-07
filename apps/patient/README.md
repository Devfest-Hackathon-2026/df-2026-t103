# 患者アプリ

Flutter の Android / iOS / Web 向けデモ雛形です。現在は準備画面のみで、認証・問診・配送は未実装です。実患者データや実在施設の非公開情報は使用しないでください。

## ローカル起動

ルートの `make up` は Firebase Emulator と Flutter Web を起動します。Flutter SDK と稼働中の Docker が必要です。患者アプリだけを起動するには、エミュレータを別途起動した上で `make patient-start` を使ってください。起動の成否は `make logs-patient` と http://localhost:5050 で確認します。

この雛形は `USE_FIREBASE_EMULATOR=true` と `FIREBASE_PROJECT_ID=demo-mmr-dev` が明示された場合にのみ Firebase を初期化し、実環境への接続は未対応です。これらは Makefile のデフォルト設定に含まれます。Firebase には単一のホストガードが入っており、許可されるのは `localhost` と `127.0.0.1`、そして Android 非 Web ビルドだけが `10.0.2.2` のみです。比較は完全一致・大文字小文字区別で、`localhost:9099` のようなポート付きや `localhost.evil.example` のような類似値は拒否され、Firebase を初期化する前に `StateError` になります。`--dart-define=FIREBASE_EMULATOR_HOST=<host>` で上書きする場合もこの範囲で、範囲外のホストを指定すると起動時に失敗します。デフォルトは Android エミュレータが `10.0.2.2`、それ以外（Web / iOS シミュレータ）が `localhost` です。つまり Android エミュレータからは `10.0.2.2`、Web と iOS シミュレータからは `localhost` を使い、物理端末（実機）から開発機の LAN IP など任意の LAN ホストで接続する構成は未対応です。エミュレータを外部ネットワークに公開することも想定していません。Messaging はネイティブ SDK による外部への自動登録を避けるため、通知実装時まで依存を追加しません。

### ブラウザで画面を確認する

Flutter SDK を PATH に設定した上で、リポジトリルートで `make up` を実行し、Firefox 等で http://localhost:5050 を開きます。Nix を利用する場合は、先に `nix develop` に入ることで Flutter を利用できます。Flutter の `web-server` を使うため、Flutter が Chrome を検出できなくてもブラウザから開けます。実データではなく合成データだけを使ってください。

画面だけ確認する場合は、Flutter SDK（CI は 3.47.4 を使用）と Bash を用意し、リポジトリルートから次のいずれかを実行します。Windows の場合は WSL 上の Bash を使用してください。Nix は不要です。準備完了後に表示される URL を開き、確認が終わったら **Ctrl+C** でそのプレビューだけを停止します。`home` や `symptom` は、該当プレビューの実装があるブランチで利用できます。

```sh
bash apps/patient/preview.sh welcome
bash apps/patient/preview.sh home
bash apps/patient/preview.sh symptom
```

Nix を使う場合は、ホストに Flutter をインストールせず次のようにも実行できます。

```sh
nix develop --command bash apps/patient/preview.sh welcome
nix develop --command bash apps/patient/preview.sh home
nix develop --command bash apps/patient/preview.sh symptom
```

現在の画面は準備中の雛形のみで、問診やログインの操作はできません。ブラウザの文字拡大やキーボード操作も確認できますが、Web の見え方は Android や iOS と同一とは限らず、実機やスクリーンリーダーによる確認の代替にはなりません。

Android Emulator での確認には別途 Android SDK、エミュレータとシステムイメージ、仮想化対応環境が必要です。iOS のエミュレータやビルドには macOS と Xcode が必要です。

症状入力の独立プレビューは Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5052 を開いて確認できます。確認後は Ctrl+C で停止します。Nix は不要です。入力は画面内だけに保持し、保存・送信しません。実際の症状や個人情報ではなく架空の内容を使用してください。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5052 -t lib/demo_symptom_preview.dart
```

ホーム画面の見た目を単独で確認するには、Flutter SDK を用意し、`apps/patient` から以下を実行してブラウザで http://localhost:5051 を開きます。確認後は Ctrl+C で停止します。Nix は不要です。このプレビューは認証や API に接続せず、各操作は未実装です。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5051 -t lib/demo_home_preview.dart
```

## 検証

`apps/patient` で `flutter pub get`、`flutter analyze`、`flutter test` を実行します。iOS のビルドには macOS と Xcode が別途必要です。Android のビルドにも対応する SDK が必要です。

## 認証方式選択プレビュー

認証方式選択（P-003）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5056 を開きます。確認後は Ctrl+C で停止します。このプレビューは認証・API に接続せず、選択操作は未接続です。実患者情報は入力しないでください。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5056 -t lib/demo_auth_method_preview.dart
```

Passkey は審査承認まで既定で非表示です。表示状態だけを確認する場合は、承認済みのレビュー環境に限り `--dart-define=PASSKEY_AUTH_ENABLED=true` を追加します。このフラグは公開承認を意味しません。

### 架空の問診デモ

架空の患者・施設データだけを使う問診フローのデモ手順は [FICTIONAL_DEMO.md](FICTIONAL_DEMO.md) を参照してください。Flutter SDK のみで起動でき、Docker・Firebase Emulator・Node API は不要です。

## 薬の一覧プレビュー

薬剤一覧（P-020）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5053 を開きます。確認後は Ctrl+C で停止します。現在・過去・不明の薬剤を、服薬状況・登録元・確認日とともに表示します。このプレビューは API に接続せず、編集・削除はメモリ上のみ、追加（P-021 処方箋撮影）は未接続です。実患者情報は入力しないでください。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5053 -t lib/demo_medication_list_preview.dart
```

## 薬の候補確認プレビュー

OCR 候補の人手確認（P-023）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5054 を開きます。確認後は Ctrl+C で停止します。候補の名前・容量・用法・数量・処方日を確認・編集でき、全件を確認するまで「確定」はできません（自動確定しません）。このプレビューは API に接続せず、写真参照・確定（medications API）は未接続です。実患者情報は入力しないでください。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5054 -t lib/demo_ocr_candidate_preview.dart
```

## 病院検索プレビュー

病院検索（P-030）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5055 を開きます。確認後は Ctrl+C で停止します。位置情報は取得前に都度同意を求める前提で、許可しない場合は住所・郵便番号の手入力で続けられます。参加施設には「このアプリで問診を受け取れる」旨と運営確認日を表示し、非参加施設は「場所の案内のみ（送信不可）」とします。このプレビューは位置情報取得・検索 API に接続せず、施設選択（P-031）も未接続です。実在する施設の情報は入力しないでください。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5055 -t lib/demo_hospital_search_preview.dart
```

## 病院詳細プレビュー

病院詳細（P-031）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5057 を開きます。確認後は Ctrl+C で停止します。名称・所在地・参加状況・送信可否を表示し、送信できるのは参加施設のみ（非参加施設は「場所の案内のみ（送信不可）」）です。地図サービス由来の情報には帰属表示を添えます。このプレビューは送信 API に接続せず、送信（P-032）も未接続です。実在する施設の情報は入力しないでください。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5057 -t lib/demo_hospital_detail_preview.dart
```

## 送信前の確認プレビュー

送信前確認・個別同意（P-032）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5058 を開きます。確認後は Ctrl+C で停止します。送信先・送信する内容・提供目的を明示し、送信するお薬を個別に選べます。要配慮情報の第三者提供についての個別同意を取るまで送信できません。このプレビューは送信 API に接続せず、実際の送信（deliveries API）は未接続です。実在する施設や実際の処方情報は入力しないでください。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5058 -t lib/demo_send_confirm_preview.dart
```

## 問診Q&Aプレビュー

AI 質問 Q&A（P-013）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5059 を開きます。確認後は Ctrl+C で停止します。1 画面 1 問・原則 3 択に加え「わからない」「答えたくない」「前に戻る」「中断」を固定操作として表示します。質問は架空の表示例で医学的な判断は行いません。回答はメモリ上の下書きのみ、AI 連携・保存（next-question / answers API）は未接続です。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5059 -t lib/demo_ai_question_preview.dart
```

## 問診票の確認プレビュー

問診票レビュー＋確定（P-014/P-015）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5060 を開きます。確認後は Ctrl+C で停止します。回答の要約を表示し、未回答は「未確認／未回答」、推定した内容は「（推定）」として区別します。医学的な断定は行いません。確定するまで送信できず、確定後は内容を変更できません。このプレビューは summary/finalize/送信 API に接続しません。実際の問診内容は入力しないでください。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5060 -t lib/demo_review_preview.dart
```

## 処方箋の取り込みプレビュー

処方箋撮影・選択（P-021）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5061 を開きます。確認後は Ctrl+C で停止します。処方箋に個人情報が含まれる旨を説明し、カメラ・写真・PDF の取り込み方法と対応形式を案内します。このプレビューは image_picker/file_picker・uploads API に接続せず、読み取り（P-022）も未接続です。実際の処方箋は取り込まないでください。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5061 -t lib/demo_prescription_capture_preview.dart
```

## 退会フロープレビュー

退会フロー（P-040/P-041）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5062 を開きます。確認後は Ctrl+C で停止します。申請前は影響・30日保留・取消期限を示し、理解チェックと二重確認を経て申請します（本番では再認証が必要）。申請後は通常機能の停止を示し、退会を取り消せます。このプレビューは deletion-request / cancel API に接続しません。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5062 -t lib/demo_withdrawal_preview.dart
```

## アカウントプレビュー

アカウント（P-008）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5063 を開きます。確認後は Ctrl+C で停止します。プロフィール変更・認証設定（パスワード変更/再設定）・同意履歴・退会（P-040）への導線を集約し、機微操作の前に再認証を求める前提を案内します。このプレビューはプロフィール/consents/認証/退会 API に接続しません。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5063 -t lib/demo_account_preview.dart
```

## プロフィール登録プレビュー

プロフィール登録（P-006）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5064 を開きます。確認後は Ctrl+C で停止します。氏名・カナ・生年月日・電話・郵便番号・住所の必須項目と任意の持病を分けて表示し、妥当性を検証します。入力は画面内に保持されますが、保存（PATCH /me/profile）は未接続です。実在する個人情報は入力しないでください。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5064 -t lib/demo_profile_form_preview.dart
```
