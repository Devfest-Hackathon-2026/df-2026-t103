# 患者アプリの開発指針

- リポジトリルートの `AGENTS.md` と、`docs/01_要件定義書.md`、`docs/02_システム設計書.md` を併せて確認する。要件は承認前のドラフトであり、医療・法務上の未決事項を確定扱いしない。
- 患者アプリは Flutter の Android・iOS・Web を対象とする。ローカル起動はルートの `make patient-start` または `make up` を参照する。
- 開発・テストには合成データだけを使用し、実患者情報や秘密情報をソース、ログ、Issue、テストに含めない。
- 患者情報の永続操作は API 経由を原則とし、Firebase SDK の設定や App Check を認証・認可の代わりにしない。Realtime Database に患者識別子や医療情報を置かない。
- Firebase エミュレータ使用時は対象プロジェクトと各接続先を明示し、設定不足で実サービスへ暗黙接続しない。ホストからのポートは Auth 9099、Firestore 8081、Realtime Database 9000、Storage 9199。Android エミュレータや実機ではホスト名の違いに注意する。
- 大きな文字、OS の文字拡大、読み上げ、キーボード操作を考慮する。診断・治療の判断や未監修の安全文言を追加しない。
- 変更時は影響するテストを追加し、Flutter SDK が利用可能なら `flutter analyze` と `flutter test` を `apps/patient` で実行する。未実行の検証は理由とともに報告する。
