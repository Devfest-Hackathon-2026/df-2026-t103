# 依存関係・シークレット・コンテナの検査

Issue: https://github.com/haru-tanu/moshimoshimonshin/issues/47

`.github/workflows/security.yaml` は PR、main push、手動実行、毎週月曜
03:23 UTC に実行する。認証情報・GCP 接続・イメージの push は不要。
定期実行により、ソースの変更がなくても新しい advisory を検査する。

| 検査 | 対象 | CI失敗条件 |
|---|---|---|
| npm audit | API / 病院ポータルの本番・開発依存 | critical、または検査自体のエラー |
| OSV-Scanner v2.7.0 | 患者アプリのコミット済み `pubspec.lock` | 既知 advisory 全件（severity 未定義を含む）、または検査エラー |
| gitleaks | Git履歴（既存 `.gitleaks.toml` 適用） | 検出、または検査エラー |
| tracked path check | 現在のGitインデックス | `.env` / `.secret` とそれらのドット接尾辞付きファイル（場所を問わない） |
| Trivy v0.70.0 | API `prod`、病院 `dev`、Firebase Emulator のOS・ライブラリ | 未修正を含む critical、またはビルド・検査エラー |

npm / コンテナの critical 閾値は既存 npm audit 方針を踏襲する。
npm の high 以下は主検査の出力と既存 informational step で確認する。
コンテナの high 以下は現行ゲートの対象外。Dart は欠落severityを見逃さないため
全advisoryを失敗扱いにする。検出を理由に閾値を緩めたり、失敗を無視しない。

病院ポータルの公開物は Firebase Hosting の静的ファイルであり、
Docker ではローカル開発用 `dev` を検査する。未使用の病院 `prod` ターゲットは
検査していない。API は実際の最終 `prod` ターゲットを検査する。

`.env.example` と `.secret.example` という**正確なファイル名**だけを
path check の例外とする。例外は実値を置く許可ではない。
gitleaks は既存設定により docs / API test / 雛形 / ベンダー資産を除外するため、
それらの中の実秘密を網羅して検出する保証はない。path check は値を読み出さず
ファイル名だけを出力する。漏えい時はファイル削除に加えて資格情報を失効・更新する。

## 更新と対応

`.github/dependabot.yml` が毎週 npm / pub / GitHub Actions / Docker の
更新PRを作成する（各設定最大5件）。自動マージは設定しない。
検出時はActionsログの advisory と導入経路を確認し、対応するパッケージや
ベースイメージを更新して、アプリのテストと security workflow を再実行する。
更新PRも通常のレビュー・必須チェックを通す。

Dart標準pubは依存解決時に警告を表示するため、CIの強制ゲートには
`dart pub audit` ではなくOSV-Scannerを使用する。
スキャン対象は解決済みロックファイルで、Dartコードの実行や依存再解決はしない。
OSVのビルドには固定のGo 1.27.0を使用する。
Trivy ActionはコミットSHAで固定し、バイナリ版も明示する。

## ローカル確認

```sh
actionlint
python3 scripts/check-secret-paths.py
gitleaks git --config .gitleaks.toml --no-banner --redact
(cd services/api && npm audit --audit-level=critical)
(cd apps/hospital && npm audit --audit-level=critical)
osv-scanner scan source --lockfile=apps/patient/pubspec.lock
docker build -f docker/api/Dockerfile --target prod -t local/api:scan .
trivy image --scanners vuln --severity CRITICAL --exit-code 1 local/api:scan
```

検査サービスへの接続失敗は「脆弱性なし」とみなさない。
コンテナ検証には稼働中のDockerが必要。Actionsの全ジョブが通るまでは
Issue完了・安全性検証済みとはしない。

## 参照

- [Dart security advisories](https://dart.dev/tools/pub/security-advisories)
- [OSV対応lockfile](https://google.github.io/osv-scanner/supported-languages-and-lockfiles/)
- [OSV source scan](https://github.com/google/osv-scanner/blob/v2.7.0/docs/scan-source.md)
- [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [Trivy Action v0.36.0](https://github.com/aquasecurity/trivy-action/tree/ed142fd0673e97e23eac54620cfb913e5ce36c25)

## 初回スキャンで検出されたイメージ依存（2026-11-07）

PR #158の初回CIでは次を検出した。閾値・ignore設定は変更しない。

- API / 病院開発用のbookwormベース: `zlib1g` のCVE-2023-45853。
  [Debian tracker](https://security-tracker.debian.org/tracker/CVE-2023-45853)
  でtrixieの修正を確認し、両ベースを `node:22-trixie-slim` に統一する。
- Firebase CLI 14: `tar` 6.2.1のCVE-2026-59873。
  [修正版は7.5.19](https://github.com/isaacs/node-tar/security/advisories/GHSA-23hp-3jrh-7fpw)。
  `tar ^7.5.21` を要求するFirebase CLI 15.35.0へ更新する。
  CIはイメージ内でAuth / Firestore / RTDB / Storageの起動・終了も確認する。
  互換性の問題はバージョンを戻して隠さず、この検証で検出する。
- Firebase EmulatorのOpenJDK 25: CVE-2026-114820。
  初回スキャンのDebianパッケージ `25.0.5+8-1~deb13u1` は
  `affected`、Fixed Versionなし。ベース更新後も残る場合は上流の修正版を
  確認するまでCI失敗を維持し、PRをマージしない。
  [Debian tracker](https://security-tracker.debian.org/tracker/CVE-2026-114820)

ベース/CLI更新だけで検出が解消したとはみなさず、変更後のCIを確認する。
