# App Check 設定（Issue #33 / docs/02 §5/§10・ADR-010・[S05]）

不正クライアント抑制の App Check を各クライアントに登録し、段階的に強制化する手順。

> **原則**: App Check は**ユーザー認証の代替ではない**（ADR-010・[S05]）。
> API は「認証 → App Check → 状態/同意 → 認可 → 入力検証 → 業務処理 → 監査」の順で検証する
> （docs/02 §10）。`POST /auth/register` のみ ID token 不要だが App Check は必須。

## バックエンド（実装済み）

API（`services/api`）は App Check を検証済み:

- `config.APP_CHECK_MODE`（`enforce` | `permissive`、emulator 既定 `permissive` / 本番既定 `enforce`）
- `createAppCheckVerifier`（`src/index.ts`）→ `enforceAccess` に集約（`src/app.ts`）
- クライアントは `X-Firebase-AppCheck` ヘッダでトークンを送る（docs/02 §2.2）

段階的強制化は環境変数 `APP_CHECK_MODE` で切り替える（下記ロールアウト参照）。

## クライアント登録（owner / 各クライアント担当・Firebase Console）

| プラットフォーム | プロバイダ | 備考 |
|---|---|---|
| Web（病院ポータル / 患者 Web） | **reCAPTCHA Enterprise**（または reCAPTCHA v3） | サイトキーを Hosting 配信アプリへ設定 |
| iOS（患者アプリ） | **App Attest**（iOS 14+）＋ DeviceCheck フォールバック | Apple Team/BundleID 紐付け |
| Android（患者アプリ） | **Play Integrity** | Play Console 連携・SHA 登録 |

登録手順の要点:
1. Firebase Console → App Check → 各アプリでプロバイダを有効化。
2. クライアント SDK で App Check を初期化（アプリ起動時、Auth より前）。
3. 登録直後は **monitor（permissive）** で計測し、正当トラフィックの合格率を確認。

## エミュレータ / 開発用 debug token

- ローカルは `APP_CHECK_MODE=permissive`（emulator 既定）で検証を強制しない。
- 実デバイス/実ブラウザでの疎通確認が要る場合は **App Check debug token** を使う:
  1. クライアントを debug プロバイダで起動しコンソール出力の debug token を取得。
  2. Firebase Console → App Check → アプリ → 「デバッグトークンを管理」に登録。
  3. debug token は秘密情報として扱い、issue/PR/ログに貼らない（docs/07 §4.3）。

## 段階的強制化（monitor → enforce）

| 段階 | API `APP_CHECK_MODE` | Console | 完了条件 |
|---|---|---|---|
| 0. 実装確認 | `permissive` | 未登録 | API が App Check トークンを**検証可能**（実装済み） |
| 1. 計測 | `permissive` | プロバイダ登録・monitor | 正当クライアントの合格率が十分高い（指標を監視） |
| 2. 部分強制 | `permissive`→一部経路 `enforce` | monitor 継続 | `POST /auth/register` 等の重要経路から enforce |
| 3. 全面強制 | `enforce` | enforce | 非準拠クライアントの拒否が想定どおり |

- monitor 中は合格率・拒否数を監視（docs/02 §13.2 の権限拒否急増アラートと整合）。
- 強制化は不可逆的に正当クライアントを弾くリスクがあるため、各段階で合格率を確認してから進める。
- ロールバックは `APP_CHECK_MODE=permissive` へ戻す（Cloud Run 環境変数更新＋再デプロイ）。

## 関連

- 本番の `APP_CHECK_MODE=enforce` 配線は `infra/ENVIRONMENT.md`（#44）。
- API 検証経路は docs/02 §5.1.1 / §10。
