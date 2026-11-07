# 監査ログの検索・抽出・保持（Issue #42）

対象は単一project `project-7efcc4c4-6c86-490c-ba5`。
[Terraform正本](../terraform/operator_audit.tf) の東京 `operator-audit` bucket、
`security-audit` view、同名sinkを利用します。400日保持は運用初期値で法定期間の主張ではありません。
この手順は既存の監査証跡の運用で、取り下げたAPI可用性監視・アラートを追加しません。

## 収集範囲と限界

sinkは `jsonPayload.auditEvent:* OR logName:cloudaudit.googleapis.com` を選別します。
アプリの構造化監査ログは [lib/audit.ts](../../services/api/src/lib/audit.ts)、
イベント名は [auditEvents.ts](../../services/api/src/domain/auditEvents.ts) が正本です。
[ADR-0014](../../docs/adr/0014_監査ログ基盤.md) の収集範囲とbest-effortの欠測可能性は残ります。
Cloud Audit Logsは別の証跡です。Data Accessログの生成設定はsinkとは独立して確認し、
sinkがあるだけでデータ参照を全件監査できるとは扱いません。

viewはこのprojectのsourceに限定します。bucketにはsink以外の経路からログを追加できる管理者も
存在し得るため、検索ではアプリ監査/Cloud Audit Logsの条件も明示します。
アプリログ中のHMAC hashは匿名情報とは扱わず、調査用の識別子としてアクセスを制限します。

## 設定を確認する（ログ本文なし）

```sh
gcloud logging buckets describe operator-audit \
  --project project-7efcc4c4-6c86-490c-ba5 --location asia-northeast1 \
  --format='value(retentionDays,locked)'
gcloud logging views describe security-audit \
  --project project-7efcc4c4-6c86-490c-ba5 --location asia-northeast1 \
  --bucket operator-audit --format='value(filter)'
gcloud logging sinks describe operator-audit \
  --project project-7efcc4c4-6c86-490c-ba5 \
  --format='value(destination,filter,disabled)'
```

期待値は400日、同projectの東京bucketへの宛先、上記sink/view条件、sinkが無効でないことです。
retention lockは現行で適用しません。単一projectのOwner等は設定を変更できるため、
独立projectの管理境界や改ざん不能性と同等ではありません。
保持短縮・削除・lockは別途の変更レビューを必要とします。

## 限定viewで検索する

調査目的・担当・承認・UTC期間・必要なフィールド・件数上限を先に決め、
正式な監査担当のアカウントで実行します。Ownerで読めても監査担当が読める証拠にはしません。
次の例の日付は調査対象のUTC期間へ置換します。患者UIDや本文を検索文字列へ入れません。

```sh
gcloud logging read \
  'timestamp>="2026-11-07T00:00:00Z" AND timestamp<"2026-11-08T00:00:00Z" AND jsonPayload.auditEvent:*' \
  --project project-7efcc4c4-6c86-490c-ba5 \
  --bucket operator-audit --location asia-northeast1 --view security-audit \
  --order=asc --limit=100 \
  --format='table(timestamp,jsonPayload.auditEvent.action,jsonPayload.auditEvent.decision)'
```

Cloud管理操作の調査はアプリ条件を `log_id("cloudaudit.googleapis.com/activity")` に置換し、
表示は `timestamp,protoPayload.serviceName,protoPayload.methodName` の必要最小限にします。
Data Accessは対応するlog IDと生成設定を別途確認します。0件は「操作なし」の証拠とは限りません。
時間帯・sink作成時点・生成設定・権限・収集障害・アプリ未配信を照合します。
`--limit` 到達時は期間を分割し、100件の出力を全件抽出と扱いません。

project全体へ検索scopeを広げたり、`_AllLogs` へ切り替えたりして拒否を迂回しません。
権限エラーの場合は [IAM手順](../iam/README.md) に沿って対象viewの
`roles/logging.viewAccessor` と継承経路を確認します。実在のグループ以外を付与しません。

## 抽出と証拠の管理

承認された端末のリポジトリ外の非公開保管場所を使用します。前記検索のformatを
必要最小限の `json(timestamp,jsonPayload.auditEvent.action,jsonPayload.auditEvent.decision)` に
変更し、`umask 077` を設定したシェルから保護されたファイルへ保存します。
全 `jsonPayload` / `protoPayload`、本文、principalEmail、トークン、HMAC対応表を一括抽出しません。
列を限定しても機密性が消えるわけではありません。

抽出前後の終了コード、UTC期間、filter、view、件数、limit到達の有無、抽出者/検証者、
ファイルのSHA-256、保存期限・削除担当を非公開の証拠台帳へ記録します。
原本を上書きせず、追加調査は別ファイルにします。公開Issue/Buzzには成否・参照番号だけを残し、
ログ本体・個人情報・対応表を添付しません。原本のアクセス履歴と抽出物のアクセス管理は別に確認します。

## 受入と残作業

- bucket/sink/viewと保持日数の設定確認は、収集到達・職務分離の実証とは別です。
- 承認された合成のアプリ操作/クラウド管理操作について、時刻と期待eventを照合して到達を確認します。実患者を使った再現はしません。
- 正式監査主体のview読取成功、権限のない別主体の拒否、sink/bucket変更の拒否を別々に確認します。Ownerの読取成功で代用しません。
- 個人Owner/Editorとグループ/継承権限による迂回経路、Data Access生成設定、400日保持・保持変更権限・抽出物の保管を棚卸しします。
- 正式グループ/責任者と上記許可・拒否/収集試験が揃うまでIssue #42を閉じません。設定確認のみで改ざん防止や監査完全性を達成扱いにしません。

参照: [限定viewの検索](https://docs.cloud.google.com/sdk/gcloud/reference/logging/read)、
[log views](https://docs.cloud.google.com/logging/docs/logs-views)、
[IAM・責任分界](../iam/README.md)。
