# 架空の問診デモ

必要なのは Flutter SDK のみで、Docker、Firebase Emulator、Node API は不要です。Nix も不要です。通常アプリの入口とは独立したデモ用エントリーポイントです。デモ内ではホームの「問診を始める」callback から架空の同意へ進み、部位選択のcallbackで架空の部位例をメモリ内で受け取ります。

`apps/patient` で次を実行し、http://127.0.0.1:5059 を開きます。終了は **Ctrl+C** です。既定ポート 5059 が他のプロセスに占有されている場合は、`--web-port` の値を空いているポートに変更してください。

```sh
flutter pub get
flutter run -d web-server --web-hostname=127.0.0.1 --web-port=5059 -t lib/demo_fictional_flow.dart
```

架空の患者・施設・同意と固定サンプルだけを使う非医療デモです。実際の患者情報を入力しないでください。診断、予約、実際の同意取得や送信は行いません。このデモのコードは患者データを外部へ送信せず、永続保存もしません。進行状態はアプリ内メモリにのみ保持されます。再開始すると架空の同意も解除されます。Flutter Web で起動する場合、SDK やフォントなどの静的アセット取得のために実行環境が外部と通信することがありますが、それは患者データの送信ではありません。

対象テスト: `flutter test test/demo_fictional_flow_test.dart`
