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

## 薬の一覧プレビュー

薬剤一覧（P-020）の見た目を単独で確認できます。Flutter SDK を用意し、`apps/patient` で次を実行して http://localhost:5053 を開きます。確認後は Ctrl+C で停止します。現在・過去・不明の薬剤を、服薬状況・登録元・確認日とともに表示します。このプレビューは API に接続せず、編集・削除はメモリ上のみ、追加（P-021 処方箋撮影）は未接続です。実患者情報は入力しないでください。

```sh
flutter run -d web-server --web-hostname=localhost --web-port=5053 -t lib/demo_medication_list_preview.dart
```
