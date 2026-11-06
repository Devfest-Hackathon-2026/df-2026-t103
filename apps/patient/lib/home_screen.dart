import 'package:flutter/material.dart';

/// 接続前の画面プレビュー。患者情報や認証状態は表示しない。
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
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
                  Text('ホーム（プレビュー）', style: theme.textTheme.titleLarge),
                  const SizedBox(height: 8),
                  const Text('画面の表示例です。各機能は未接続のため利用できません。'),
                  const SizedBox(height: 24),
                  const _UnavailableAction(
                    icon: Icons.edit_note,
                    label: '問診を始める',
                  ),
                  const _UnavailableAction(
                    icon: Icons.medication_outlined,
                    label: '薬を見る',
                  ),
                  const _UnavailableAction(
                    icon: Icons.history,
                    label: 'これまでの問診',
                  ),
                  const SizedBox(height: 16),
                  Text('その他', style: theme.textTheme.titleMedium),
                  const SizedBox(height: 8),
                  const _UnavailableAction(
                    icon: Icons.notifications_none,
                    label: '通知',
                  ),
                  const _UnavailableAction(
                    icon: Icons.account_circle_outlined,
                    label: 'アカウント',
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

class _UnavailableAction extends StatelessWidget {
  const _UnavailableAction({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: OutlinedButton(
        onPressed: null,
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
                  const Text('未接続'),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
