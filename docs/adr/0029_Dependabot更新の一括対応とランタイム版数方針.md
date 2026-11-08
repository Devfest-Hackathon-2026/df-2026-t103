# 0029. Dependabot更新の一括対応とランタイム版数方針

- ステータス: 承認
- 日付: 2026-11-08
- 作成者: Devin
- 関連: Issue #191（Epic）・#192・#193・#194・#195・#196, .github/dependabot.yml, docs/DEPENDENCY_SECURITY_CI.md, docker/*/Dockerfile

## コンテキスト

Dependabot が週次で作成した PR が 18 件滞留し、Epic #191 でテーマ別（GitHub Actions / Node.js / TypeScript・ESLint / Firebase / Flutter）に整理された。うちランタイム系メジャー更新（Node 25 Docker イメージ 3 件、Temurin 26、TypeScript 7）はオーナー判断で「検証済み構成の維持」のため未マージクローズ済みで、残る 11 件の対応方針を決める必要があった。

## 検討した選択肢

| 選択肢 | 概要 | 利点 | 欠点・犠牲になる点 |
|---|---|---|---|
| A | 各 Dependabot PR を個別にマージする | 変更が小さく追跡しやすい | 相互に干渉する更新（eslint 10×2、@types/node×2、actions 6件）を 11 回 CI で逐次確認する必要があり、組合せ不良の切り分けが難しい |
| B | 採用する更新を 1 本の PR に集約し、個別 PR は理由付きでクローズ | 組合せで一度だけ検証すればよく、採用/不採用の判断を記録として残せる | 個別差分の自動生成ではないため、採否の根拠を ADR で明記する責任が生じる |
| C | 全件クローズして現行維持 | リスク最小 | GitHub Actions の旧メジャーは Node 20 強制実行の警告対象で将来的に動作しなくなる。eslint/firebase の修正も取り込めない |

## 決定

選択肢 B を採用し、以下の版数方針で一括対応する。

### 採用する更新

- **GitHub Actions**（#192）: `checkout@v7`、`setup-node@v7`、`setup-go@v7`、`setup-java@v6`、`google-github-actions/auth@v3`、`setup-gcloud@v3`
- **ESLint 10**（#194）: `eslint@^10.14.0`（services/api・apps/hospital）、あわせて `@eslint/js@^10`（api。推奨設定は eslint メジャーに揃える）。typescript-eslint 8.72・eslint-config-next 16.4.5 は peer 範囲上 eslint 10 と整合
- **Firebase JS SDK 13**（#195）: `firebase@^13.2.0`（apps/hospital）。13.2.0 が `@firebase/app@0.16.5` を固定要求するため npm が旧解決の 0.16.2 をトップレベルに残し二重化（コンポーネントレジストリ分離で `initializeAuth` が失敗）していたのを `npm dedupe` で 0.16.5 単一へ解消した
- **@types/node のランタイム整合**（#193）: `@types/node@^22` に services/api を揃える（^24 → ^22。apps/hospital は既に ^22）

### 採用しない更新（個別 PR はクローズ）

- **`@types/node` 26**（#182・#187）: 型定義のメジャーはランタイム（Node 22 LTS）と一致させる。26 を入れると Node 22 に存在しない API がコンパイルを通ってしまう
- **Node 25 Docker イメージ**（#173・#178・#180・クローズ済み）: 奇数バージョンは非 LTS。Node 22 は 2027-04 まで保守 LTS であり、検証済み構成を維持する
- **TypeScript 7**（#184・#188・クローズ済み）: typescript-eslint の peer 範囲（`typescript >=4.8.4 <6.1.0`）を超え、今回の機能完成に必須でない
- **Temurin 26 JRE**（#176・クローズ済み）: エミュレータ用 JRE は CVE-2026-114820 修正を含む `25.0.5_8-jre-noble` をダイジェストピンで検証済み。26 系への更新は別途検証してから行う
- **`apps/patient` 側は対象なし**（#196 クローズ済み、`cupertino_icons` は PR #190 でマージ済み）

## 理由

- Node は偶数 LTS 系で揃え、ランタイム（Docker・CI `setup-node`）・`engines`・`@types/node` のメジャーを一致させる。これにより型定義が実ランタイムに存在しない API を許容する事故を防ぐ。
- GitHub Actions の新メジャー群はいずれも破壊的変更が本リポジトリに非該当であることを確認済み: checkout v7 の fork PR 遮断は `pull_request_target`/`workflow_run` 限定（本リポジトリ未使用）、auth v3 で削除された旧パラメータ・setup-gcloud v3 の `skip_tool_cache` は未使用、全ランナーは `ubuntu-latest` で Node 24 実行要件を満たす。
- Firebase JS SDK v13 の破壊的変更は AI Logic（Vertex AI）系のみで、apps/hospital が使う app/auth/app-check/firestore/storage には影響しない。
- ESLint 10 は flat config 完全移行だが両パッケージとも既に `eslint.config.*` 移行済み。`@eslint/js` 10 の推奨設定で `no-useless-assignment` が新たに実効し、`src/routes/staff.ts` の実質的なコード臭 1 件を検出したため修正済み。
- `firebase@13.2.0` 系の `@firebase/*` パッケージは `engines.node >=24.12.0` を宣言するが、本 SDK はブラウザバンドル向けで `npm ci` は engine-strict 未設定のため警告のみ。Node 22 上のエミュレータ結合テストが CI・ローカルとも通過しており実害は確認されていない。ランタイム整合の観点では Node 24+ 移行検討の材料とする（再評価条件を参照）。

## 結果・影響

- 採用分を `chore/dependabot-batch-191` ブランチの 1 PR に集約し、open の Dependabot PR（#172・#174・#175・#177・#179・#181・#182・#183・#185・#187・#189）は本 PR への参照コメント付きでクローズする。
- `npm run lint`（eslint 10）は両パッケージで通過、api の typecheck/test(471件)/build、hospital の test(41件)/build、全ワークフロー YAML パースを確認済み。
- 今後も Dependabot は週次で PR を作成する。ランタイム/コンパイラのメジャー更新は本 ADR の版数方針（偶数 LTS 一致・peer 互換確認・必須性）に照らして個別判断する。

## 再評価条件

- Node 24/26 LTS への移行（firebase-tools・eslint・Next.js の要件、検証コストが許容される時点で一括移行）
- TypeScript 7 の採用（typescript-eslint が peer 範囲へ追加し、IDE/ビルドの互換確認が取れた時点）
- Temurin 26 系への更新（エミュレータイメージの CVE 修正が 26 系のみになった、または 25 系が EOL になった時点）
