import 'package:flutter/material.dart';

/// API に接続しないアカウント（P-008）のプレビュー。
///
/// プロフィール変更・認証設定（パスワード変更/再設定）・同意履歴・退会（P-040）
/// への導線を集約するハブ画面（FR-A06）。パスワード変更や退会などの機微操作の前には
/// 再認証を求める前提を示す。プロフィール/consents/認証/退会 API は未接続。
class AccountScreen extends StatelessWidget {
  const AccountScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('アカウントデモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです。実際のアカウント情報は含みません。'),
              const SizedBox(height: 8),
              const Text('パスワードの変更や退会など大切な操作の前には、本人確認のため再度のログイン（再認証）をお願いすることがあります。'),
              const SizedBox(height: 16),

              _section(textTheme, 'プロフィール', [
                const Text('お名前: サンプル太郎'),
                const Text('生年月日: 1950年1月1日（例）'),
                _action(context, 'プロフィールを変更する', 'プロフィールの変更'),
              ]),

              _section(textTheme, '認証の設定', [
                const Text('ログイン方法: メール／Google'),
                _action(context, 'パスワードを変更・再設定する', 'パスワードの変更・再設定'),
                _action(context, 'ログイン方法を設定する', 'ログイン方法の設定'),
              ]),

              _section(textTheme, '同意の履歴', [
                const Text('・利用規約 v1.0（2026-10-01 に同意）'),
                const Text('・プライバシーポリシー v1.0（2026-10-01 に同意）'),
                const Text('※ 同意内容はご本人のものだけを表示します。'),
              ]),

              _section(textTheme, '退会', [
                const Text('退会の申請・取消はこちらから行えます（P-040）。'),
                _action(context, '退会の手続きへ', '退会の手続き'),
              ]),
            ],
          ),
        ),
      ),
    );
  }

  Widget _section(TextTheme textTheme, String title, List<Widget> children) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            header: true,
            child: Text(title, style: textTheme.titleMedium),
          ),
          const SizedBox(height: 8),
          ...children,
        ],
      ),
    );
  }

  Widget _action(BuildContext context, String label, String what) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Align(
        alignment: Alignment.centerLeft,
        child: OutlinedButton(
          onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('（デモ）$what は未接続です。')),
          ),
          style: OutlinedButton.styleFrom(
            minimumSize: const Size(48, 48),
            textStyle: const TextStyle(fontSize: 20),
          ),
          child: Text(label),
        ),
      ),
    );
  }
}
