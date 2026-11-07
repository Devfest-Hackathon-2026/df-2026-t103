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

`infra/firestore/backup-export.sh` が冪等に設定する。

1. **PITR（Point-in-Time Recovery）**: 直近 7 日の任意時点へ復元可能にする。
2. **マネージドバックアップスケジュール**: 日次・保持 7 日（+ 週次・保持 14 週を任意）。
3. **GCS エクスポート（任意）**: 長期保管・可搬性が必要な場合に
   `gcloud firestore export gs://PROJECT_ID-firestore-backups` を Cloud Scheduler で定期実行。

> **PHI 注意（§5.11）**: バックアップ内 PHI は退会削除直後に物理消滅しない。
> バックアップ TTL（保持期間）・復元時の tombstone 再適用・独立保管を明示し、
> 退会削除の完了条件と整合させる。

## 課金への影響（docs/04 §11 / [S08]）

- Firestore は Read/Write/Delete に加え **index entry reads・ストレージ・ネットワーク転送**
  にも課金される。一覧は `limit`＋cursor（offset 不使用）、必要列のみ返す。
- `onSnapshot` の常時全件監視を避ける（病院受信一覧など）。
- バックアップ/エクスポートもストレージ課金対象。保持期間で費用を制御する。
