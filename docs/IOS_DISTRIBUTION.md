# 患者iOSアプリのビルド・TestFlight配布

患者アプリの公開接続は `apps/patient/lib/main_public.dart`。
エミュレータ用 `main.dart` と独立しており、本番接続失敗時にデモへ切り替えない。
Firebaseプロジェクトは `project-7efcc4c4-6c86-490c-ba5` のみを使う。

## Appleログイン前に確認できること

- Flutter 3.47.4、Xcode 26以降で解析・全テスト・署名なしRelease archiveを実行できる。
- 公開版は実Firebase Auth、App AttestのApp Check、実APIを使用する。
- iOSではプロセス起動時にAuthをログアウトし、前回利用者のセッションを自動再開しない。
- 問診情報は画面のメモリ内だけに保持する。認証変更時に消去する。
- 現在の公開フローは登録・メール認証・同意・プロフィール完了済みアカウントでの受入用。
  これだけでモバイルEpic全体の完了や一般公開可能とは扱わない。

## FirebaseのiOS設定

1. Bundle IDは `com.moshimoshimonshin.patient`。既存登録を確認してから使い、重複作成しない。
2. 指定プロジェクトで `firebase apps:list --project project-7efcc4c4-6c86-490c-ba5` を実行。
3. `firebase apps:sdkconfig IOS <IOS_APP_ID> --project project-7efcc4c4-6c86-490c-ba5 --out <LOCAL_PLIST>` で取得。
4. `apps/patient/ios/public-config.example.json` をリポジトリ直下の
   `.local/patient-ios.json` にコピーし、iOS設定と実API originを入れる。
   Web用App IDを流用しない。設定には秘密鍵・Authトークン・パスワードを入れない。
   Dart defineはアプリから抽出可能であり、秘匿領域ではない。
5. Appleログイン後、利用するTeamを確認し、FirebaseのiOSアプリに同じApple Team IDを設定。
   Firebase Console → App Check → Patient iOSでApp Attestを登録する。
   Bundle IDのApp Attest capabilityと署名プロファイルも一致させる。
   `Runner.entitlements` はproduction。Debug providerへの置換・APIのApp Check無効化は禁止。

App Attestは実機で検証する。シミュレータでコンパイル成功しても、実トークンの取得成功とは扱わない。
DeviceCheckへ自動切替しないため、DeviceCheck用p8秘密鍵の追加は不要。

iOSアイコンはオーナー提供の `apps/patient/assets/icon/source.png` を使用する。
`cd apps/patient && dart run tool/generate_app_icon.dart` でiOS・Android・Webのアイコンを再生成する。
起動画像は別の暫定素材で、`swift tool/render_ios_icon.swift` は起動画像だけを更新する。

## 署名なしビルド

リポジトリ直下で実行:

```sh
cd apps/patient
flutter pub get
flutter analyze
flutter test
python3 tool/build_ios.py --config ../../.local/patient-ios.json --build-number 1 --unsigned
```

出力は `apps/patient/build/ios/archive/Runner.xcarchive`。
署名なしarchiveは配布・インストールできない。ビルド番号はASCで未使用の番号にする。

## 所有者がAppleログインした後

1. Xcode → Settings → AccountsでApple Developerアカウントにログイン。
2. Developer PortalでBundle IDとApp Attestを確認。ASCで同じBundle IDのアプリレコードを作成または選択。
3. 次を実行。Team IDは所有者が確認したものを指定する。他アプリのTeamを推測して流用しない。

```sh
cd apps/patient
python3 tool/build_ios.py --config ../../.local/patient-ios.json --build-number 1 --team YOURTEAMID
open build/ios/archive/Runner.xcarchive
```

4. Xcode Organizer → Distribute App → App Store Connectで検証・アップロード。
   最初のexport時に保存したExportOptions.plistは、次回の `--export-options <FILE>` に指定できる。
5. ASCのTestFlightで内部テスターとビルドを紐付け、iPhoneのTestFlightからインストール。
   外部テスター向けには初回ベータ審査を通す。
6. 合成データだけでログイン→問診→レビュー→確定→明示同意付き施設送信→病院受信を確認。
   Auth/App Checkトークンや入力した問診情報をログ・Issueへ貼らない。
7. 実機受入・未完了のモバイル機能・リリースゲートを確認してからApp Store審査へ提出。
   初回の配布設定だけで本番リリース完了と報告しない。

## 参考

- https://docs.flutter.dev/deployment/ios
- https://firebase.google.com/docs/app-check/flutter/default-providers
- https://firebase.google.com/docs/app-check/ios/app-attest-provider
- https://developer.apple.com/testflight/
