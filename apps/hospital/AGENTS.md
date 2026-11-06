# 医療機関ポータルの開発指針

- ルートの `AGENTS.md` と `docs/01_要件定義書.md`・`docs/02_システム設計書.md` を確認する。現在のデモは架空施設・合成データのみを使う。
- 病院職員の認証・施設所属・権限はサーバ側で検証し、クライアントの施設 ID や表示制限を認可とみなさない。患者情報をログ、通知、分析、SSR や共有キャッシュに含めない。
- ローカル開発は Firebase Emulator を使い、設定不足で実サービスへ暗黙接続しない。秘密情報や実患者データをソース・テスト・Issue に入れない。
- アクセシビリティ、キーボード操作、読み上げ、文字拡大、エラー時の再試行を考慮する。未実装の認証・受信機能を動作済みと表示しない。
- 変更後は `apps/hospital/package.json` の実際の検証スクリプトを確認して実行し、実行できなかったチェックを報告する。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
