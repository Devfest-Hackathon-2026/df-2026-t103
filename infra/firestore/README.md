# Firestore 本番設定（Issue #35 / docs/04 §7/§8/§11・ADR-0002）

正本DB（Cloud Firestore）の本番設定。リージョン・デプロイ経路・インデックス・
バックアップ・課金方針をまとめる。

> IAM 付与・DB 作成・バックアップ有効化は owner 権限で実施（`roles/editor` では IAM 不可）。
> `PROJECT_ID` は対象プロジェクト（例 `project-7efcc4c4-...`）に置換。

## データベース

| 項目 | 値 | 根拠 |
|---|---|---|
| 種別 | Firestore **Native**・Standard Edition | ADR-0002・docs/04 冒頭 |
| ロケーション | `asia-northeast1`（東京） | docs/04（国内保管方針） |
| Storage | `asia-northeast1` | docs/04 |

作成（存在しなければ）:

```sh
gcloud firestore databases create \
  --project PROJECT_ID --location asia-northeast1 --type firestore-native
```

## rules / indexes のデプロイ経路

CI/CD（`.github/workflows/cd.yaml` の `deploy-rules` ジョブ）が
`firebase deploy --only firestore:rules,firestore:indexes` を実行する。
手動実行時:

```sh
firebase deploy --only firestore:rules,firestore:indexes \
  --project PROJECT_ID --non-interactive
```

- Rules は `firebase/firestore.rules`（deny-by-default＋公開版のみ読可）。
  更新は医療監修レビュー前提（docs/02 §13.1-7）。
- Rules の構文は CI の `firebase-config` ジョブ（emulator コンパイル）で検証済み。

## 複合インデックス（docs/04 §8/§11）

`firebase/firestore.indexes.json` は **API実装（`services/api`）の実クエリと照合済み**の
現在有効な索引のみを収録する。docs/04 §8 の候補のうち、対応クエリが未実装の
ものは実装時に追加する:

| クエリ | インデックス | 状態 |
|---|---|---|
| 本人問診一覧 | `intakes` patientUid+updatedAt | 未実装（一覧APIなし。追加時に索引も追加） |
| 本人薬剤一覧 | `medications` patientUid+updatedAt | ✓ 定義済み（currentStatus フィルタ未使用） |
| 病院受信一覧 | `deliveries` facilityId+deliveredAt+createdAt | ✓ 定義済み |
| 病院状態別一覧 | `deliveries` facilityId+status+deliveredAt | 未実装（statusフィルタなし。追加時に索引も追加） |
| 退会対象ジョブ | `deletionJobs` status+executeAfter ほか3件 | ✓ 定義済み |
| 施設職員所属 | `facilityMemberships` userUid+status | ✓ 定義済み |

このほか uploads・ocrJobs・pushDevices・legalConsents・questionnaires の
実クエリ分を含む。未使用索引の削除はデプロイ時に上書きではなく
**追加のみ**行われる（`firebase deploy --only firestore:indexes` は既存索引を
消さない）。不要索引の消去はコンソール/`firebase firestore:indexes` で個別実施。

実際に必要な索引は Firestore エミュレータ／Explain で継続検証する（§8）。

## バックアップ / 輸出方針（docs/04 §5.11 注記・§11）

通常の設定管理は `infra/terraform/firestore.tf` のPITR・日次7日保持が正本です。
マネージドバックアップを利用し、GCS export用バケットは自動作成しません。
旧スクリプトが作成したバケットは、この変更では削除・保持変更しません。

```sh
PROJECT_ID=project-7efcc4c4-6c86-490c-ba5 bash infra/firestore/backup-export.sh --check
```

省略時も `--check`。DBメタデータとスケジュールのみを読み、PITR・日次7日保持が
揃っていればexit 0、不足は1、想定外構成は2、gcloud失敗はその終了コードです。
週次だけでは日次ありと判定しません。取得失敗・不正JSON・異なる保持期間は更新せず停止します。
対象は指定単一projectの東京 `(default)` に限定します。Python 3とgcloudが必要です。

障害対応でTerraform以外から設定を補う場合だけ、費用とTerraform stateの所有関係を
確認して `--apply` を明示します。PITR有効化と不足する日次7日スケジュールの作成に限定し、
最後に独立した再読取で検証します。既存の保持期間・週次設定・バケットは変更しません。
部分的な成功後に失敗した場合は状態を再確認して再実行します。PITRの自動無効化や
バックアップ削除で巻き戻しません。手動作成したscheduleは正本stateへimport・照合し、
Terraformで重複作成しないでください。

復旧手順、Storage/RTDB方針、削除競合と演習の受入は [DR手順](DR_RUNBOOK.md) を参照。

## 課金への影響（docs/04 §11 / [S08]）

- Firestore は Read/Write/Delete に加え **index entry reads・ストレージ・ネットワーク転送**
  にも課金される。一覧は `limit`＋cursor（offset 不使用）、必要列のみ返す。
- `onSnapshot` の常時全件監視を避ける（病院受信一覧など）。
- バックアップ/エクスポートもストレージ課金対象。保持期間で費用を制御する。
