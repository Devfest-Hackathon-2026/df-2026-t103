# 0009. OCRジョブのリースclaimと投入回収設計

- ステータス: 承認
- 日付: 2026-11-06
- 作成者: Devin
- 関連: 02_システム設計書 §8, 03_機能仕様書（FR-O01〜O07）

## コンテキスト

`ocrJobs` は `uploads complete` フックで作成され、Cloud Tasks の HTTP タスクが
`/v1/internal/jobs/ocr/{id}/run` を呼んで実行される。初期実装には三つの
耐久性上の穴があった。

1. `enqueueOcrJob` 失敗時、`queued` ジョブだけが残り再実行経路がなかった
2. `claim` が非原子的で、二重配送のタスクが同時実行・相互上書きできた
3. ワーカー中断時、最終 attempt の `running` ジョブが永遠に滞留した

## 検討した選択肢

| 選択肢 | 概要 | 利点 | 欠点・犠牲になる点 |
|---|---|---|---|
| A. ドキュメント上のリースclaim＋dispatchState（採用） | claim/完了をトランザクション化し、enqueue成功をフラグ管理 | 追加インフラ不要・Cloud Tasks の冪等再送と整合 | ワーカー中断の検知はリース期限まで遅延する |
| B. Cloud Tasks の再送のみに依存 | タスク側のリトライで全て回収 | 実装最小 | enqueue 自体の失敗（タスク未作成）を回収できない |
| C. 定期スイーパージョブ | 滞留ジョブを走査して再投入 | 能動的に回収 | スケジューラ追加・走査コスト・今回の規模では過剰 |

## 決定

**A** を採用する。

- `ocrJobs` に `claimOwner`（claimごとのUUID）、`claimExpiresAt`（リース期限）、
  `dispatchState: "pending" | "enqueued"` を追加する
- `claim` は Firestore トランザクション内で行う
  - `queued` → `running`（attempt+1, owner, lease）
  - `running` かつリース有効 → `already_running`（二重実行しない）
  - `running` かつリース切れ → 放棄とみなし、attempt 上限到達なら
    `worker_interrupted` で終端化、未到達なら自ワーカーが回収して再実行
- `finish` もトランザクション内で `status==="running" && claimOwner===owner` を
  確認した場合のみ結果を書き込む（失効後の遅延完了は上書きしない）
- enqueue 成功時のみ `dispatchState="enqueued"` にする。失敗時は `pending` のまま
  残し、次の `createOcrJobForUpload` 呼び出し（complete 冪等リプレイ等）で再投入する
- retryable 失敗で `queued` に戻す際は `dispatchState="pending"` にし、
  Cloud Tasks のタスク再送とは別に後続呼び出しでも回収できる経路を残す
- リース長は `OCR_LEASE_MS`（既定 300,000ms）
- `ocrJobs(uploadId, createdAt)` 複合インデックスを追加

## 理由

- Cloud Tasks は at-least-once 配送であり二重実行を前提に排他制御が必須
- enqueue 失敗（タスク未作成）はタスク側再送では回収不能なため、
  永続化した dispatch 状態による回収経路が必要だった
- リース切れ＝中断検知により「永遠の running」を排除できる

## 影響

- ジョブ実行ごとに claim/finish の各1トランザクションが増える（許容範囲）
- `worker_interrupted` が `OcrFailureCode` に追加された
- `OCR_LEASE_MS` の新規環境変数（既定値あり、未設定で動作）

## 再評価条件

- リース内に収まらない長時間OCR（大容量PDF等）を扱う場合
- 滞留検知の遅延が許容できなくなった場合（スイーパー導入を検討）
