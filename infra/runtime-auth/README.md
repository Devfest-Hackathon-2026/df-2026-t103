# APIのFirebase Auth失効検証権限

実公開ログインで、有効なFirebase ID tokenに対してAPIが401を返す問題を切り分ける。
`AdminAuthVerifier.verifyIdToken(token, true)` は署名検証だけでなくAuthユーザー状態を読む。
[GetAccountInfoの必要権限](https://docs.cloud.google.com/identity-platform/docs/access-control) は
`firebaseauth.users.get`。API runtimeの既存datastore/cloudtasks権限だけでは満たせない。

このrootは新設のcustom roleとAPI SAへの非排他的IAM memberの2件だけを管理する。
Auth設定変更、ハッシュ参照、ユーザー更新/削除、運営権限は含めない。
既存SAそのものやAPI runtimeをimport・再管理しない。旧rootにも同じrole/bindingを追加しない。
専用GCS backendを `prefix=runtime-auth` で初期化し、project_idを明示してplanを確認する。
新設2件だけの保存planをapplyし、実App Check/ID tokenでログイン・失効拒否を検証する。
state/保存planは公開しない。rollbackはこのmemberを外す差分planを確認して適用する。

本rootはユーザー作成・再有効化・退会workerの権限を解決した意味ではない。
それらを公開する際は実装ごとの必要権限と受入を別途確認する。
