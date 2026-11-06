# メール登録のローカル結合テスト

このテストは合成アカウントと同意データを作成します。**必ず使い捨ての Firebase Emulator と、すべての接続先をそのエミュレータに向けたローカル API だけで実行してください。** 共有環境・実クラウド・実データに対して実行しないでください。Auth ユーザーは可能な限り削除しますが、API の Firestore データは残るため、テスト後は使い捨てのエミュレータ環境ごと破棄してください。

API を `127.0.0.1:8080`、Auth Emulator を `127.0.0.1:9099`、Firestore Emulator を `127.0.0.1:8081` で起動します。API は `demo-mmr-dev` を使い、Firebase サービスをすべてエミュレータに向けます。実行前にエミュレータと API が起動完了していることを確認してください。

`apps/patient` で以下を実行します。通常のテストではスキップされます。

```sh
flutter test --dart-define=RUN_DEMO_AUTH_INTEGRATION=true test/integration/demo_email_registration_test.dart
```

このテストのサインインは Auth Emulator の REST API を使います。Firebase Flutter SDK 自体やブラウザでの統合は別途検証が必要です。
