import 'package:flutter/material.dart';

/// 接続前の画面プレビュー。患者情報や認証状態は表示しない。
///
/// [onStartQuestionnaire] を明示的に指定した場合のみ「問診を始める」を操作可能にする。
/// 未指定時は従来どおり全導線が未接続のプレビュー表示のままで、他の導線は指定しても未接続。
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, this.onStartQuestionnaire, this.onSignOut});

  /// 「問診を始める」が押されたときに呼ばれる。未指定なら問診開始導線は無効のまま。
  final VoidCallback? onStartQuestionnaire;

  /// 「ログアウト」が押されたときに呼ばれる。未指定なら導線は出さない。
  final VoidCallback? onSignOut;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final startEnabled = onStartQuestionnaire != null;
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 600),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('もしもし問診', style: theme.textTheme.headlineMedium),
                  const SizedBox(height: 16),
                  Text(
                    // 実フローから接続されるときのみ「ホーム」表記にする
                    // （onStartQuestionnaire だけ渡す架空デモがあるため onSignOut で判定）。
                    onSignOut != null ? 'ホーム' : 'ホーム（プレビュー）',
                    style: theme.textTheme.titleLarge,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    startEnabled
                        ? '画面の表示例です。問診を始められます。他の機能は未接続のため利用できません。'
                        : '画面の表示例です。各機能は未接続のため利用できません。',
                  ),
                  const SizedBox(height: 24),
                  _HomeAction(
                    icon: Icons.edit_note,
                    label: '問診を始める',
                    onPressed: onStartQuestionnaire,
                  ),
                  const _HomeAction(
                    icon: Icons.medication_outlined,
                    label: '薬を見る',
                  ),
                  const _HomeAction(
                    icon: Icons.history,
                    label: 'これまでの問診',
                  ),
                  const SizedBox(height: 16),
                  Text('その他', style: theme.textTheme.titleMedium),
                  const SizedBox(height: 8),
                  const _HomeAction(
                    icon: Icons.notifications_none,
                    label: '通知',
                  ),
                  const _HomeAction(
                    icon: Icons.account_circle_outlined,
                    label: 'アカウント',
                  ),
                  if (onSignOut != null)
                    _HomeAction(
                      icon: Icons.logout,
                      label: 'ログアウト',
                      onPressed: onSignOut,
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// ホームの導線。`onPressed` が null のときは未接続として操作できない。
class _HomeAction extends StatelessWidget {
  const _HomeAction({required this.icon, required this.label, this.onPressed});

  final IconData icon;
  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: OutlinedButton(
        onPressed: onPressed,
        style: OutlinedButton.styleFrom(
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.all(16),
        ),
        child: Row(
          children: [
            Icon(icon),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: Theme.of(context).textTheme.titleMedium),
                  if (onPressed == null) const Text('未接続'),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
