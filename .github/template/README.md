# GitHub テンプレート

このディレクトリがPR・Issueテンプレートの**正本**です。

GitHubが自動で認識するのは固定パス（`.github/PULL_REQUEST_TEMPLATE.md`、
`.github/ISSUE_TEMPLATE/`）のみのため、編集後は以下で正式パスへ反映してください。

```bash
make install-templates
```

| 正本（ここ） | 反映先 |
|---|---|
| `pull_request_template.md` | `.github/PULL_REQUEST_TEMPLATE.md` |
| `bug_report.md` | `.github/ISSUE_TEMPLATE/bug_report.md` |
| `feature_request.md` | `.github/ISSUE_TEMPLATE/feature_request.md` |
