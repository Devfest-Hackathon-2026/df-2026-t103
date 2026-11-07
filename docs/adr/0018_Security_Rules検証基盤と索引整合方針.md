# 0018. Security Rules 検証基盤と Firestore 索引の整合方針

- ステータス: 承認
- 日付: 2026-11-07
- 作成者: Devin
- 関連: #24, docs/02 §6, docs/04, docs/06, `firebase/`, `infra/firestore/README.md`, ADR-0017

## コンテキスト

#24 で Security Rules（Firestore/RTDB/Storage）の本実装に対する
エミュレータ単体テスト、CI 接続、索引整合を行った。前提は以下。

- クライアント直読は公開経路のみ許可という設計方針は rules 本体で
  既に実装済み（Firestore `appConfigs/publicLegalVersion` のみ read、
  RTDB `/publicOperationalStatus` のみ read、Storage は全面 deny）
- それ以外の deny-by-default 挙動は実装済みだが「deny を期待する」
  回帰テストがなく、rules 変更時の誤解放を防ぐ手段がなかった
- `firebase/firestore.indexes.json` と docs/04・`infra/firestore/README.md`
  の記述が乖離（設計候補とデプロイ済み実態の区別なし）状態だった
- テスト用ファイルを `firebase/` 配下に置くと `docker compose watch` が
  エミュレータを再起動し、開発中のテストが不定に失敗する（実測で確認済み）

## 検討した選択肢

| 選択肢 | 概要 | 利点 | 欠点・犠牲になる点 |
|---|---|---|---|
| A. `@firebase/rules-unit-testing` + チェックイン済み rules ファイルを readFileSync（採用） | `initializeTestEnvironment` に `firestore.rules`/`database.rules.json`/`storage.rules` を直接読込 | テストが常に実ファイルを対象。`firebase.json` の参照齟齬に影響されない | rules ファイル変更時はテスト実行も必須（CI で担保） |
| B. `firebase.json` 経由で rules 読込 | エミュレータのプロジェクト設定に任せる | 配備と同一経路 | `firebase.json` の file 参照が変わるとテスト対象が追従できない |
| C. エミュレータ REST で rules を注入 | 起動後に rules を差し替える | テスト毎に rules を変えられる | deny-by-default 検証では不要な複雑さ |

| 索引の管理方針 | | | |
|---|---|---|---|
| A. `indexes.json` を「実際の API クエリに必要な複合索引のみ」に揃える（採用） | 全クエリを列挙照合し、未使用の 5 索引を削除。README/設計書は「設計候補」として区別 | デプロイ対象が実クエリと一致し無駄な索引コストを防ぐ | indexes.json から消しても既デプロイ索引は残る（加算型）ため手動削除案内が必要 |
| B. 設計候補を全て indexes.json に残す | 将来のクエリ追加に備え維持 | クエリ追加時に indexes.json 変更不要 | 使われない索引が本番に残り書込コスト・管理負債になる |

## 決定

1. **rules テストは `firebase/tests/` に独立パッケージ**として配置し、
   `@firebase/rules-unit-testing` の inline `rules` で
   `readFileSync` したチェックイン済み rules 本体を評価する。
   Firestore/RTDB/Storage の3サービスを同一スイートで網羅する。
2. **deny カバレッジを網羅** — `idempotencyKeys`/`deliveryAttempts`/
   `appConfigs`（list/read/write/subcollection）/`ocrJobs/*/candidates`、
   RTDB ルート read/write/push、Storage `updateMetadata`/`putString`/
   `listAll` 等の「deny であるべき」全パスをテストで固定する。
3. **ループバック + `demo-` プロジェクトのみ**（ADR-0017 と同じ
   fail-closed 原則）。`FIRESTORE_EMULATOR_HOST` 等が未設定・
   非ループバック・不正なら throw。`demo-mmr-dev` を固定。
4. **CI は `security.yaml` に `rules-tests` ジョブ**として分離し、
   `firebase-tools@15.35.0` をピン（`docker/firebase/Dockerfile` と揃える）。
   `npm ci`（lockfile 固定）で再現性を確保。
5. **索引は実クエリ照合で削る**。`infra/firestore/README.md`・
   `docs/04` は「設計候補」と「デプロイ済み実態」を区別して記述し、
   Firebase の索引デプロイが**加算型**（削除は反映されない）である
   ことを明記（本番索引の手動削除が必要な場合がある）。
6. **`firebase/tests` を compose watch の `ignore` と `.dockerignore` に追加**
   し、テストファイル変更でエミュレータが再起動しないようにする。

## 理由

- rules は「deny であるべき経路が allow になる」回帰がセキュリティ上
  最悪系。許可経路だけでなく全 deny 対象をテストで固定することで、
  rules 編集時の緩め過ぎを機械的に防ぐ。
- `readFileSync` による直接読込は「テストが `firebase.json` の
  ミス設定を検出せず素通りする」失敗を排除する。テスト対象が
  常にデプロイ対象と一致することをファイル単位で保証する。
- 索引の削除は Firebase デプロイが加算型のため即時効果を持たない。
  だが「実クエリに不要な索引を indexes.json に残す」選択は、
  新規環境構築時に不要索引が作られ続ける原因になるため正すべき点。
  デプロイ実態と設計意図の区別を文書で固定し、別途手動削除の
  案内を残すのが最小かつ誠実な整合方法。
- compose watch 再起動は「テストファイルを編集するたびにエミュレータが
  落ちてテストが失敗する」開発中の実害として観測されたため、
  `ignore` による除外は回避不能な前提条件。

## 結果・影響

- 追加資産: `firebase/tests/`（firestore/database/storage 3 rules スイート、
  helpers/env のループバック検証、vitest config、独自 package.json）
- CI: `.github/workflows/security.yaml` に `rules-tests` ジョブ
  （Java 21・`firebase-tools@15.35.0`・`emulators:exec`）
- `firebase/firestore.indexes.json`: 未使用 5 索引を削除
  （intakes/medications/deliveries/facilityMemberships の未照合複合索引）
- `infra/firestore/README.md`・`docs/04`: 索引を「設計候補」
  vs「デプロイ済み実態」で区別、加算型デプロイの注意を明記
- `docker-compose.yml`・`.dockerignore`: `firebase/tests` を
  watch/イメージから除外しエミュレータ再起動を防止
- 203 テスト（rules 3 サービス合計）が安定して通ることを確認

## 再評価条件

- rules が read/write 両方を許可する経路を持つようになった時
  （deny 固定から挙動網羅へのテスト拡張）
- RTDB/Storage のクライアント経路が新設される時
- indexes.json の加算型デプロイによる本番索引と定義の乖離が
  許容できなくなった時（手動削除・インフラコード化を検討）
