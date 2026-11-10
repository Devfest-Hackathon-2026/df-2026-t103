# クライアント監視の収集境界とSentry評価（Issue #40）

本書は導入検討と実装時の受入条件です。SDKの導入・収集有効化・法務上の承認を
実施済みとするものではありません。対象は指定単一projectの患者アプリと病院ポータルです。

## 現在の実装と要件

- [NFR-11 / FR-O06](../../docs/01_要件定義書.md) はCrashlytics・GA4の監視と、
  医療情報をサニタイズできる場合の任意のSentry導入を区別しています。
- [ADR-011 / データ分類](../../docs/02_システム設計書.md) は症状・薬剤・住所の監視送信を禁止し、
  運用イベント例を `intake_completed` / `delivery_failed` としています。
  [運用設計§2](../../docs/06_医療安全_セキュリティ_運用設計書.md) は分析への相関IDも禁止します。
- [公開患者APIクライアント](../../apps/patient/lib/public_patient_api.dart) はHTTPエラーを
  status code、通信例外を `UNAVAILABLE` に変換します。原文を含み得る例外・応答bodyを
  監視へそのまま転送する変更は、この境界を壊します。
- [公開入口](../../apps/patient/lib/main_public.dart) の起動失敗は固定文言です。
  [患者manifest](../../apps/patient/pubspec.yaml) には公式Analytics SDKを追加しました。
  Crashlytics/Sentryの導入とアプリ全体のサニタイズ完了は未達です。

## 最初の実装範囲（収集停止）

[PatientAnalytics](../../apps/patient/lib/patient_analytics.dart) は固定した2イベント名だけを
受け取り、属性・例外・URL・識別子を渡す引数を持ちません。公開APIの成功したfinalize後に
`intake_completed`、配送APIの失敗時に `delivery_failed` を通知します。
後者は失敗した要求試行数であり配送レコード数ではありません。前者も再試行の重複を除去した
監査台帳ではなく、統計用のbest-effortイベントです。元のrequest/body/responseは渡しません。
監視の例外や未完了FutureはAPI応答を失敗・待機させません。

iOSは実SDKの `logEvent` へ接続しますが、このリリースのInfo.plistでは
`FIREBASE_ANALYTICS_COLLECTION_DEACTIVATED=true` により収集を停止しています。
SDK初期化でもcollection=falseを設定し、自動画面計測・IDFVも無効にします。
標準iOSビルド補助は公式pluginの `FIREBASE_ANALYTICS_WITHOUT_ADID=true` を設定して
広告識別子サポートを除いたSPM productを選びます。手動ビルドでも同変数が必要です。
Androidのnative設定も収集停止。公開Webではadapterを無効にし、外部bootstrapで
Analyticsの自動script loaderを抑止します。CSPを緩めません。

アプリ操作やDart defineだけで収集を有効にするスイッチは設けていません。
送信を試験する際はnative停止設定を含む別の変更・ビルドと、以下の実送信受入が必要です。
この実装ではダッシュボード到達・端末全体の非送信を実証済みとはしません。

公式参照: [iOS収集停止と優先順位](https://firebase.google.com/docs/analytics/ios/configure-data-collection)、
[自動画面計測](https://firebase.google.com/docs/analytics/screenviews)。

## FCMの送信直前検査

[通知カタログ](../../services/api/src/domain/notifications.ts) を業務処理と
[Admin SDKアダプタ](../../services/api/src/push.ts) で共有します。タイトル/本文だけでなく、
`data.type` と文言の対応、dataキーが `type`/`refId` に限定されることも検査します。
`refId` を指定する場合は空でない文字列が必要です。拒否したメッセージはSDKへ渡さず、
固定の失敗分類を返します。アダプタは許可したキーだけで送信メッセージを再構築します。

[アダプタ試験](../../services/api/test/push.test.ts) はSDK送信引数のシリアライズ結果と、
余分な症状・UID・token等のdataがSDKへ到達しないことを確認します。実FCM送信・端末受信の
証明ではありません。`refId` は既存仕様の不透明docIDを維持し、呼出元が生成済みIDを渡す
責任は残ります。文字列がPHIでないことをこの検査だけで証明したとは扱いません。

## Sentry導入の評価結果

現段階ではSentryを追加せず、NFR-11のCrashlytics/GA4について収集境界と検証を先に整える案です。
FR-O06はCOULDであり、未検証の自動例外送信を追加することを必須作業にしません。
同じ例外を複数の外部送信先へ流す経路を増やす前に、実送信データを確認できる必要があります。
これは本Issueの技術評価であり、Sentryの恒久的禁止や既存要件の取り下げではありません。

Sentry公式SDKには [beforeSend / sendDefaultPii](https://pub.dev/documentation/sentry_flutter/latest/sentry_flutter/SentryOptions-class.html)
などの制御があります。また、[Flutter固有の設定](https://pub.dev/documentation/sentry_flutter/latest/sentry_flutter/SentryFlutterOptions-class.html)
にはnative breadcrumb等の別経路があります。これらの設定があるだけで本アプリからの
PHI漏えいを防止できたとは判断しません。採用する場合は固定したSDK版・各platformについて、
例外、breadcrumb、request、attachment、native crash等の実際に有効な送信経路を検証します。
クラッシュ解析の有用性・追加の送信先/保持/アクセス管理・NFR-06のデータ移転条件を比較して再評価します。

## 実装する場合の収集案

最初の送信対象は上記の固定イベント名と、ビルド由来のplatform/release、固定の失敗分類だけに絞ります。
イベント名や属性の値をUI入力・例外メッセージ・URLから組み立てません。
未登録イベント、未知の属性、型が異なる値は送信前に破棄するallowlist方式にします。
正規表現で医療語を置換した原文を送る方式は、未知の医療語や識別子を見逃すため採用しません。

| 入力/送信経路 | 扱い |
|---|---|
| 症状、質問/回答、要約、薬剤、画像、氏名/住所/電話/生年月日 | 送信しない。free textのcustom key/logにも入れない |
| UID、メール、施設/問診/配送ID、request/idempotency ID、これらのhash | 分析/クラッシュ属性に付けない。監査の相関と分離する |
| Auth/App Check token、Cookie、header、API body | SDKのHTTP自動計測やbreadcrumbにも渡さない |
| 実URL、route引数、画面テキスト、例外のtoString | 原文を転送しない。固定分類への変換を経由する |
| screenshot、replay、attachment、console/native自動収集 | 有効化する経路を個別に列挙し、送信データを検証するまでは採用しない |
| 監視SDKの障害・設定不足 | 患者処理の成否を変えない。原文ログや別providerへの暗黙fallbackを追加しない |

この案はアプリから渡すpayloadの境界です。SDK自体の端末/instance情報、通信メタデータや
保存・再送を除去できたという保証ではありません。各SDKの既定値と実送信を別に調べ、
不要な自動収集を停止できない場合はその経路を採用しません。

## #40を完了とする前の検証

1. 収集provider・固定SDK版・platform・初期化箇所・自動収集設定を記録します。
   WebではCSP/追加通信先、iOS/Androidではnative経路と配布設定も確認します。
2. 合成の症状/薬剤/住所/識別子/tokenを例外・URL・属性に混ぜた負の試験で、
   シリアライズ後payloadに含まれないことを確認します。正規化関数のunit testだけで完了にしません。
3. Dartだけでなくnative crash、breadcrumb、network失敗、offline保存/再送、logout/ユーザー切替を
   含む実送信と、受信側ダッシュボードの結果を確認します。実患者情報で再現しません。
4. 設定無効時の送信停止と、監視サービスが落ちても問診が継続できることを確認します。
   送信先の保持・閲覧主体とデータ移転の受入は、アプリ内のredaction試験とは区別します。

現時点の実装は上記の固定イベント境界と収集停止までです。
Crashlytics導入と各platformの実送信試験・ダッシュボード受入は未実施です。
本書によるSentry評価だけで、Crashlytics/GA4/FCMのPHI非送信を検証済みとしたり、Issue #40を閉じたりしません。
