# バックアップ・復旧手順（Issue #43）

## 適用範囲と未完了条件

対象は `project-7efcc4c4-6c86-490c-ba5` の単一projectです。stg/prodを新設しません。
目標RPO≤24時間・RTO≤8時間は [運用設計書§8](../../docs/06_医療安全_セキュリティ_運用設計書.md) の暫定値です。
本書と設定確認だけでは達成を証明しません。最新バックアップの実時刻、復元終了、
削除再適用、Rules/TTL/IAM、業務受入、再開までの時間を演習で測ります。

通常のPITR/日次7日保持は [Terraform](../terraform/firestore.tf) で管理します。
Firestoreのマネージドバックアップを第一経路にし、追加GCS exportの定期ジョブや
90日保持の別バケットを重ねません。GCS exportが必要になった場合は、保存対象・
削除整合・保持費用を別途決定します。手動exportを「定期バックアップ稼働」とは扱いません。

## 事前確認

1. 障害担当・実施者・検証者、復旧点・許容損失、費用を記録します。公開Issueへ患者情報、UID、バックアップ本文や資格情報を載せません。
2. 元DBへの書込み、配送・削除等のworker再実行、患者/病院からのアクセスを制御する計画を確定します。元DBを削除したり、同名へ上書きしたりしません。
3. 次の読取りで設定と利用可能なバックアップを確認します。設定があることと、成功した新鮮なバックアップがあることは別です。バックアップ時刻と障害起点の差を測り、24時間超や成功バックアップなしはRPO不達として扱います。

```sh
PROJECT_ID=project-7efcc4c4-6c86-490c-ba5 bash infra/firestore/backup-export.sh --check
gcloud firestore backups list \
  --project project-7efcc4c4-6c86-490c-ba5 --location asia-northeast1
python3 infra/firestore/backup_freshness.py \
  --project project-7efcc4c4-6c86-490c-ba5
```

`backup_freshness.py` は現在のDBとバックアップのメタデータだけを読み取ります。
東京のdefault DBと同じ `databaseUid`（再作成前の同名DBを除外）のバックアップから、
READY・未失効・snapshotTimeが未来でないものを選び、最新snapshotの経過時間を判定します。
本文、復元、設定変更は扱いません。出力は判定・時刻・経過秒のみで、UIDやresource IDは出しません。
exit 0は確認時点で24時間以内（境界を含む）、1は古い/利用可能なバックアップなし、
2は不正な引数/メタデータ、3は取得失敗（権限不足・timeout等）です。取得失敗を
バックアップなしや成功へ読み替えず、原因を確認してから再実行します。
この結果は確認時点の鮮度であり、障害発生時点のRPO・継続的保証・復元可能性・RTO達成の証明ではありません。

ローカルの全Firestore運用スクリプト試験（クラウドへ接続しません）:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/firestore -p 'test_*.py' -v
```

メタデータ定義: [Backup REST resource](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.locations.backups)、
全ページ取得: [gcloud backups list](https://docs.cloud.google.com/sdk/gcloud/reference/firestore/backups/list)（limit省略）。

日次scheduleには実行時刻の固定指定がありません。単に「日次だからRPOを保証」と判定しません。
PITRは日次バックアップとは別経路です。本手順の `databases restore` はバックアップからの復元です。
PITR時点へのcloneを同じコマンドと混同しないでください。

## Firestoreの復元と再開判定

[公式restoreコマンド](https://docs.cloud.google.com/sdk/gcloud/reference/firestore/databases/restore)
はバックアップと同じ場所の新DBを作ります。復元先のDB IDが未使用であること、
アプリと通常runtimeがそのDBへ接続しないこと、IAMの隔離を確認してから実行します。
次は実施者がバックアップIDと新DB IDを検証した後の例です。プレースホルダーのまま実行しません。

```sh
gcloud firestore databases restore \
  --project project-7efcc4c4-6c86-490c-ba5 \
  --source-backup=projects/project-7efcc4c4-6c86-490c-ba5/locations/asia-northeast1/backups/BACKUP_ID \
  --destination-database=dr-exercise-YYYYMMDD
```

1. 操作完了を確認し、復旧点・所要時間・件数の照合を機密の演習記録に残します。コマンド受付だけで復元成功にしません。
2. 接続を開放する前に、バックアップ後の退会・削除・同意撤回・所属失効を再適用します。削除済み情報を再び配送・表示できる状態にしません。
3. IAM、Rules、TTL policy、indexesを確認します。TTLはバックアップから自動復元されません。通常CDはdefault DB向けなので、復元先にそのまま流用せず対象DBを明示してレビューします。RulesだけではAdmin SDKのアクセスを制限できません。
4. 合成データで本人/別人・所属/別院の拒否、配送receiptと病院受領の整合、削除済み情報の非表示を検証します。配送ジョブを無条件再送せず、冪等性と通知重複を確認します。
5. 現APIは [firebase.ts](../../services/api/src/firebase.ts) の接続方式を使います。別DBへの切替・復元後再削除の自動化が完成したとは扱いません。接続切替の実装・テスト・戻し方が確定するまで本番トラフィックを向けません。
6. 復元・削除再適用・権限と業務検証・再開の合計をRTOとして測ります。8時間超または未実施なら不達/未検証を記録します。

## 削除競合の扱い

[システム設計書§11.3](../../docs/02_システム設計書.md) のとおり、バックアップには削除済み情報が残り得ます。
復元DB内の `deletionJobs` だけではバックアップ後に完了した削除を把握できません。
最新の削除/同意撤回記録との照合と再帰削除が必要です。直接識別子を公開ログへ残さず、
正当な権限を持つ独立した記録から照合します。対応表・保管責任・照合実装を確認できない場合は復旧公開を停止します。
既存Storageの空オブジェクト化（upload tombstone）を、退会情報の復元後削除manifestの代替にしません。

## StorageとRTDB

- Storageは [画像バケット設定](../terraform/storage.tf) の現行TTL・soft deleteを維持します。Firestore backupには画像原本は含まれません。独立コピー・versioning・保持lockは削除要件/費用の確認なしに有効化しません。画像復旧時も削除・同意撤回を再照合し、参照だけ復元して原本なしの場合は成功表示しません。現行soft deleteだけでRPO/RTOを検証済みとはしません。
- RTDBは非PHI状態の投影であり、Firestoreと同時点の整合したsnapshotとは限りません。正本からの再構築と照合を優先し、Rulesは [正本](../../firebase/database.rules.json) から再確認します。再構築の自動化・受領状態の整合は演習で検証する残要件です。
- RTDBの独立バックアップが必要な場合、[公式の自動バックアップ](https://firebase.google.com/docs/database/backups) はBlazeでconsoleから設定する方式です。データ/Rulesの保存先と削除保持を決めてから採用します。この変更では有効化しません。

## 演習記録と終了

隔離した新DBにも実データが含まれ得ます。演習を合成データで実施できる準備と、
実バックアップを扱う場合のアクセス・後片付け計画を先に確定します。勝手に別projectを作りません。
記録には、復旧点、障害/演習開始・restore完了・再適用完了・再開の各UTC時刻、
実測RPO/RTO、Rules/TTL/IAM・権限境界・削除再適用の検証、残不整合と責任者を残します。
検証後の新DB削除は別の承認された作業として行い、default DBやバックアップを自動削除しません。
演習未実施・削除再適用/接続切替未完成の間はIssue #43を閉じません。

## 演習時刻のローカル判定

`dr_timing.py` は機密の演習記録から**時刻6項目だけ**を標準入力で受け取り、
RPO（障害起点−snapshot）とRTO（サービス再開−障害起点）を判定します。
クラウド接続・復元・削除・接続切替は実行しません。次は架空の記録です。

```sh
python3 infra/firestore/dr_timing.py <<'JSON'
{
  "snapshotTime": "2026-11-08T00:00:00Z",
  "incidentTime": "2026-11-09T00:00:00Z",
  "restoreCompletedAt": "2026-11-09T01:00:00Z",
  "deletionReappliedAt": "2026-11-09T02:00:00Z",
  "validationCompletedAt": "2026-11-09T03:00:00Z",
  "serviceResumedAt": "2026-11-09T08:00:00Z"
}
JSON
```

実演習では各工程の完了を検証してから時刻を記録します。未実施工程に仮の時刻を
埋めません。`incidentTime` は検知時刻やrestore開始時刻ではなく、障害/演習の起点です。
RTOはrestore完了で打ち切らず、削除再適用・権限/業務検証・再開までを含みます。
各時刻は上記順で同時刻または昇順、UTCの `Z` 表記、秒または小数点以下6桁までです。
精度を黙って丸めないため、7桁以上の小数秒は拒否します。
全6項目が必須で、余分なキー・重複キー・不正な日付・時刻逆転はexit 2です。
UIDや自由記述、元の演習記録全体を渡さないでください。

両目標内（24時間/8時間の境界を含む）はexit 0 `timing_targets_met`、どちらか超過は
exit 1 `timing_targets_exceeded`。出力は判定と秒数のみです。秒数は切り上げ表示ですが、
判定は入力の小数秒精度で行います。不正入力時も入力値や例外内容は出力しません。
この判定は入力時刻の計算に限定されます。工程実施の真偽、削除の網羅性、復旧データの
正しさや再開承認を証明せず、exit 0だけで復旧公開やIssue完了を判断しません。
別途、上記の権限・削除・業務検証の証跡と実施者/検証者の記録が必要です。
全ローカル試験は事前確認節のunittest discoverコマンドに含まれます。

参照: [Firestoreバックアップ](https://firebase.google.com/docs/firestore/backups)、
[スケジュール作成](https://docs.cloud.google.com/sdk/gcloud/reference/firestore/backups/schedules/create)。
