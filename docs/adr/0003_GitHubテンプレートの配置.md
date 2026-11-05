# 0003. GitHubテンプレートの配置（.github/template/ に正本を集約）

- ステータス: 承認
- 日付: 2026-11-05
- 作成者: はるたぬ
- 関連: .github/template/README.md, Makefile `install-templates`

## コンテキスト

- 医療安全・セキュリティ上の観点（PHIのログ混入、テナント分離、同意フロー）をPR/Issue段階から確認させたいため、テンプレートは実務的なチェックリストにしたい。
- GitHub が自動認識するのは `.github/PULL_REQUEST_TEMPLATE.md` と `.github/ISSUE_TEMPLATE/` の固定パスのみ。
- プロジェクトとして `.github/template/` にテンプレートをまとめて管理する方針が指定された。

## 検討した選択肢

| 選択肢 | 概要 | 利点 | 欠点・犠牲になる点 |
|---|---|---|---|
| A. 固定パスに直接置く | `.github/PULL_REQUEST_TEMPLATE.md` 等 | そのまま動く | 指定された集約方針とずれる |
| B. 固定パスからシンボリックリンク | 正本は template/、実体は1つ | 二重管理にならない | Windows環境のクローンで壊れやすい |
| C. template/ を正本＋コピー運用（採用） | `make install-templates` で正式パスへコピー | 集約とGitHub認識を両立。Windowsでも安全 | 編集後に手続きが1ステップ必要 |

## 決定

- PR/Issueテンプレートの**正本は `.github/template/`** に置く。
- `make install-templates` で `.github/PULL_REQUEST_TEMPLATE.md`・`.github/ISSUE_TEMPLATE/` へコピーしてGitHubへ反映する。
- `.github/template/README.md` に対応表と手順を記載し、正本側だけを編集する運用とする。

## 理由

- 指定された集約方針を保ちつつ、GitHubの制約上必要な固定パスにも確実に反映できる。
- シンボリックリンクはクローン環境差で壊れる可能性があり、コピーは最も単純で安全。

## 結果・影響

- テンプレート編集の手順が「正本を編集 → `make install-templates` → 両方コミット」になる。片方だけの更新に注意が必要。

## 再評価条件

- 編集頻度が増えてコピー運用が負担になった時（CIでの自動同期チェックを検討）。
