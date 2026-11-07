# IAM / 運営アカウント / 監査の責任分界案（#46）

状態: 東京の監査bucket/view/sinkは実作成済み。実グループ・メンバーの準備と職務分離は未完了。
対象: **project-7efcc4c4-6c86-490c-ba5 の単一プロジェクト**。

根拠: docs/06 §11（RACIドラフト）、docs/02 §2.1/§5.3、ADR-0014。
本書の役割名は責任の分類であり、実在するGoogle Groupのアドレスではない。
実在確認・責任者承認前に架空のアドレスや人名でIAMを設定しない。

## 役割別グループと付与範囲

Google Workspace / Cloud Identityで次の4グループを分離し、各グループの
責任者・メンバー・代理者・失効日を非公開のアクセス台帳に登録する。
リポジトリに個人メール、UID、患者情報、秘密値を載せない。

| 責任分類 | 通常の操作 | GCP IAMの付与案 | 通常付与しない権限 |
|---|---|---|---|
| 開発 | コード/合成データでの検証、PR作成 | クラウド権限なしを基本。稼働設定閲覧が必要なら対象Cloud Run serviceのrun.viewerを個別検討 | Editor/Owner、Secret値参照、実画像/Firestoreの直接操作 |
| 運用 | 稼働監視、承認済みリリース、復旧の起票 | projectのmonitoring.viewer、必要なserviceのrun.viewer。本文ログは別の限定viewで必要性を審査 | project全体のlogging.viewer/privateLogViewer、全SAのなりすまし、IAM変更 |
| 監査 | 分離した監査証跡の閲覧、アクセス棚卸し | 監査log view自体へのlogging.viewAccessor。project全体には付与しない | logsの削除/保持期間変更、sink変更、実患者DBの直接参照 |
| セキュリティ | IAM・監査設定のレビュー、侵害調査の承認 | projectのiam.securityReviewer。必要な監査viewへのviewAccessorは別途付与 | 常設Owner/Editor/projectIamAdmin、常設Secret値参照、自己承認の権限変更 |

上記は最小構成案であり、一括apply用のIAM policyではない。権限不足時は
必要なpermissionとresourceを特定し、狭いscopeまたは期限付き権限で補う。
既存project/folder/org継承権限や別グループ経由の権限も含めて判定する。

IAM変更の実行者は、通常グループと分けた権限管理者とする。
付与対象者・承認者・実行者を台帳で区別し、対象者自身が承認しない。
少人数で分離できない場合は残存リスクと代替レビューをPOへ明示する。
Google Group作成権限はGCP Project IAM権限とは別である。

## 人間・デプロイSA・実行SAの分離

- 人間の開発/運用グループへ、runtime SAの権限を直接コピーしない。
- GitHub WIFのdeployerはinfra/README.mdの専用SAを使い、許可repo/branch/
  Environmentの制約とPR/デプロイ承認を通す。長寿命SAキーを作らない。
- `iam.serviceAccountUser` は対象runtime SAへのattach/actAs用途、
  `iam.serviceAccountTokenCreator` は短命credentialや署名の発行用途。
  どちらもproject全体へ常設付与しない。
- V4署名URLのsignBlobは署名対象SAだけに限定する。Storage object権限は
  対象bucketへ、Secret Accessorは必要なsecret自体へ付与する。
  既存infra/README.mdのproject単位例を、そのまま最小権限の完成形と扱わない。
- runtimeへ任意のコードをdeployできる人は、間接的にruntimeのデータ・Secretへ
  到達し得る。人間へSecret Accessorを付けないだけでデータアクセス分離が
  完成するとはみなさず、deploy権限とCI設定変更の承認も同じ強度で管理する。

## アプリ内ロールとGCP IAMの対応

| アプリの権限 | 現行実装の根拠 | GCP IAMへの自動マッピング |
|---|---|---|
| patient | Firebase ID tokenと所有権検証 | なし。Cloud API権限を本人へ付与しない |
| facility_staff / facility_clinician / facility_admin | active membershipのfacilityId・roleをサーバで照合 | なし。施設ロールからGCP権限を付与しない |
| platform_security_admin | active membershipに同roleがあることをrequirePlatformSecurityAdminが検証 | なし。Google GroupやGCP Ownerから自動昇格させない |

正本: `services/api/src/domain/types.ts`、`src/repos/facilities.ts`、
`src/auth/gates.ts`。パスはAPI package内。

`src/routes/operator.ts`の施設認証/受付停止は、上記role確認に加えて
`requireFreshAuth`を要求する。失敗ジョブ一覧も同roleで保護するが再認証要求はない。
Firebase custom claimsやGCP IAMだけを変更しても、このmembership認可は付かない。
初期運営アカウントをどの手順でactive membershipへ登録するかは別途承認が必要。
本書はAuthユーザー作成・membership直接書換え・custom claims設定を行わない。

運営アプリのロール付与/取消は、承認対象のUIDを非公開で照合し、目的・承認者・
有効期限・実行者・監査参照を残す。GCPグループ加入/退出とは別項目で棚卸しする。
退職や担当交代時は両方を失効し、別経路で権限が残っていないことを確認する。

## 単一project内の監査保管分離

Issue本文は別projectの監査保管先を要求するが、今回の実行指示では単一project
のみが許可されているため、新しい監査projectは作らない。代替案は東京の
専用Cloud Logging bucketと監査専用viewへのsink転送とする。

1. runtimeの構造化監査イベント `jsonPayload.auditEvent:*` を収集対象とする。
   これはADR-0014と `services/api/src/lib/audit.ts` の出力契約。
2. Cloud Audit LogsのIAM変更・Secretアクセス等はアプリイベントとは別の
   ログである。必要なData Accessログの有効化範囲、費用、filterを別に確定する。
   アプリイベントだけのsinkで全クラウド管理操作が監査できるとはしない。
3. 専用bucket（location: asia-northeast1）とviewを作成し、sinkのwriterには
   そのbucketへ必要な書込み権限だけを付与。人間の監査グループはviewだけを読む。
4. 通常の運用/開発担当へsink/bucket/viewの変更権限・監査viewの閲覧権限を
   付けない。`logging.viewAccessor` をprojectへ付けると全viewへ広がるため避ける。
5. 認可前の拒否・レート制御による監査間引き等、ADR-0014の収集範囲の限界を
   記録する。実患者の本文・トークン・署名URLを監査ログへ転送しない。

単一projectのOwner/IAM管理者はポリシーを変更でき、別projectの独立した
管理境界と同等ではない。この残存リスクをPO/法務/セキュリティが評価する。
監査保持日数と閲覧者が未確定なのでbucket/view/sinkは未作成。
retention lockは不可逆な制約になるため、本案で自動適用しない。

## 権限レビューと失効

提案周期: 四半期ごと＋入退社/職務変更/事故/新機能公開時。周期自体も運用承認対象。

| 作業 | R（実施） | A（承認責任） | C / I |
|---|---|---|---|
| 通常アクセス申請と目的・期限登録 | 各グループ責任者 | 事業PO | セキュリティC、監査I |
| GCP IAM付与/取消 | 権限管理者 | セキュリティ責任者 | 対象グループ責任者C、監査I |
| 運営アプリrole付与/取消 | 承認された運営アカウント管理担当 | 事業PO | セキュリティC、監査I |
| 監査保管先・保持設定変更 | 限定されたログ管理担当 | セキュリティ責任者 | 法務C、監査C、運用I |
| 定期棚卸しと完了記録 | 監査担当 | セキュリティ責任者 | 各グループ責任者C、PO I |

具体手順:

1. 各scopeのIAM policy、継承権限、Google Groupの実メンバーと管理者、
   WIF条件、SAなりすまし経路、アプリactive membershipを非公開台帳で突合する。
2. 申請目的/期限/在籍と合わないgrantを取消候補へ。未知のservice agentを
   名前だけで削除せず、依存サービスを確認する。
3. 承認後は対象bindingだけを変更し、全policyの上書きを避ける。before/afterと
   操作の監査参照を保存し、対象本人と別の拒否されるべき主体で再検証する。
4. log viewの許可/拒否、運営APIの許可/拒否を**別々に**確認する。
   合成データを使い、患者DBを調査用にコピーしない。
5. 判定結果と未完項目に責任者・期限を付けて記録。緊急権限は目的・期限を
   明示して付与し、対応後は失効と実際の拒否を確認する。

## 適用前に必要な入力と受入条件

必要入力: 4グループの正式アドレス/責任者、権限管理の実行者・承認者、
監査ログの保持日数と閲覧者、初期platform_security_admin登録主体。
公開Issue/PRへ個人情報を貼らず、既存の非公開アクセス台帳を使用する。

受入条件はグループ実在確認、bindingのresource scope確認、非公開台帳との照合、
log view/IAM/アプリそれぞれの許可・拒否試験、継承経路のレビュー、承認記録。
本書の追加だけではこれらを満たさず、Issue #46を完了とはしない。

## 公式資料

- [Cloud Logging access control](https://docs.cloud.google.com/logging/docs/access-control)
- [Log views](https://docs.cloud.google.com/logging/docs/logs-views)
- [Log bucket retention](https://docs.cloud.google.com/logging/docs/buckets)
- [Service account authentication roles](https://docs.cloud.google.com/iam/docs/service-account-permissions)

## 2026-11-07 委任に基づく初期運用設定

- 事業PO/初期の承認責任者: taichi。グループの個人メンバーやメールは公開しない。
- 監査証跡: 東京 `operator-audit` bucket、400日、限定view `security-audit`。
  年次レビューをまたぐ調査期間として選定した運用値で、法定保持期間とは主張しない。
  retention lockは適用しない。短縮や削除は別途変更レビューを必要とする。
- アプリ監査とCloud Audit Logsをsinkで選別する。bucket内のviewは単一projectのsourceに限定。
  Google CloudのData Accessログは別途有効化が必要で、sink追加だけでは生成されない。
- 開発には通常GCP権限を付けない。運用はmonitoring.viewer、セキュリティはiam.securityReviewer、
  監査/セキュリティには対象viewのviewAccessorのみ。実在確認したGoogle Groupだけ入力可能。
- グループ値の既定は空集合。Cloud Identityの実在グループを確認できない間は誰にも新しい
  権限を付けない。架空のアドレス、空の運営用SA、個人へのOwner追加で代用しない。
- 四半期/異動時のアクセス棚卸し。メンバー追加・承認・実行は非公開台帳へ記録。
  独立監査担当が未配置の初期段階では職務分離は未達であり、本番利用可とはしない。

実装: `infra/terraform/operator_audit.tf`。既存IAM bindingを上書きするpolicy/bindingリソースを
使わずmember単位で追加する。既存の4人のEditorと1人のOwnerは調査で確認したが、
在籍・依存関係を推測して削除していない。Editor経由の広いデータ権限という残存リスクは解消していない。

このセッションの認証を `testIamPermissions` で検査した結果、
`resourcemanager.projects.setIamPolicy` / `logging.buckets.create` /
`logging.sinks.create` / `logging.views.setIamPolicy` がなく、実適用はブロックされる。
設定値の再確認ではなく、権限を持つ実行者による適用と実グループの作成・メンバー照合が必要。
本書とTerraformの追加だけでIssue完了とはしない。

同一project内のlog bucketへのsinkはwriter用の追加project IAM付与が不要:
https://docs.cloud.google.com/logging/docs/export/configure_export_v2

## Owner権限反映後の実適用

前段の403は当時の認証に対する履歴。Owner付与反映後、testIamPermissionsで必要な
権限が許可され、東京の `operator-audit`（400日）・`security-audit` view・同名sinkを作成した。
単一project内のsinkに追加writer IAMは付けない。groupへの権限は未付与のまま。
GCP Project OwnerだけではCloud Identityのグループ管理者権限を意味しない。

API署名URL用のToken Creatorはapi-run-sa自身を同じSAへ紐付ける。project全体の
Token Creatorを人間/運営グループへ付けない。合成アップロード検証用の人間のgrantは
15分期限付き・同じSAだけに限定し、検証終了時に除去する。
