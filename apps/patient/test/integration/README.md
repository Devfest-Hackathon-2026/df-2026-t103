# メール登録のローカル結合テスト

このテストは合成アカウントと同意データを作成します。**必ず使い捨ての Firebase Emulator と、すべての接続先をそのエミュレータに向けたローカル API だけで実行してください。** 共有環境・実クラウド・実データに対して実行しないでください。Auth ユーザーは可能な限り削除しますが、API の Firestore データは残るため、テスト後は使い捨てのエミュレータ環境ごと破棄してください。

API を `127.0.0.1:8080`、Auth Emulator を `127.0.0.1:9099`、Firestore Emulator を `127.0.0.1:8081` で起動します。API は `demo-mmr-dev` を使い、Firebase サービスをすべてエミュレータに向けます。実行前にエミュレータと API が起動完了していることを確認してください。

`apps/patient` で以下を実行します。通常のテストではスキップされます。

```sh
flutter test --dart-define=RUN_DEMO_AUTH_INTEGRATION=true test/integration/demo_email_registration_test.dart
```

このテストのサインインは Auth Emulator の REST API を使います。Firebase Flutter SDK 自体やブラウザでの統合は別途検証が必要です。

## 実ブラウザ統合試験（#137）

`python3 apps/patient/tool/run_browser_integration.py` は使い捨て `demo-mmr-dev` Firebase Emulator、ローカルAPI、Flutter Web probe、Firefoxを起動し、共通の隔離・cleanup基盤上で試験します。CORSの許可originからの応答読み取り、別originからの読み取り拒否、App Check enforce時のtoken欠如を個別に検証します。専用 `tool/browser_api_probe.dart` を実ブラウザで実行し、Firebase Auth Flutter SDKによる合成ユーザー作成/サインインと実装済み `PublicPatientApi` 呼び出しを行います。Dart側が受け取った `items: []` 応答とAPIログ上のOPTIONS preflightを確認し、DOM表示だけで成功扱いしません。

Node.js/npm、Flutter、Java 21、Firebase CLI、Firefox、Xvfbが必要です。`FIREBASE_BIN`、`FLUTTER_BIN`、`FIREFOX_BIN`で実行ファイルを指定できます（Firebase CLIは引数付き可）。CIはGitHub-hosted runnerに用意されたFirefox/Xvfbを検査して使い、apt経由でFirefoxを追加導入しません。runnerは一時HOMEとrun専用PUB_CACHEを使い、GCP資格情報を子へ継承せず、API buildを5分、Firebase emulator/browser runを25分で制限して、期限切れや捕捉できた中断時には自己起動process groupを終了します。実GCP/実患者データへ接続しません。

OS/runnerからSIGKILLされた場合やGitHub job timeoutによる強制終了ではPythonの`finally`やsignal handlerが実行される保証はありません。process group cleanupは捕捉できたtimeout/SIGINT/SIGTERMに対するbest effortであり、CIでは専用hosted VMの破棄を最終cleanupとします。

範囲の制約: これは通常の患者画面の操作試験ではなく、専用probeの試験です。App Check token欠如時のfail-closed応答のみ検証し、有効なApp Check tokenの発行・検証、reCAPTCHA、実環境origin、本番データ経路は検証しません。

```sh
FIREBASE_BIN='npx -y firebase-tools@15.35.0' \
FLUTTER_BIN=flutter FIREFOX_BIN=firefox \
python3 apps/patient/tool/run_browser_integration.py
```
