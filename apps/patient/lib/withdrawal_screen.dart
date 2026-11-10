import 'package:flutter/material.dart';

/// deletion-request / cancel API に接続しない退会フロー（P-040/P-041）の
/// プレビュー。
///
/// 退会申請（P-040）では影響・30 日の保留・取消期限を明示し、二重確認を経てから
/// 申請する（FR-A11）。本番では再認証が必要。申請後（P-041）は通常機能の停止を示し、
/// 取消手続を提供する（E2E-005）。deletion-request / cancel API は未接続。
class WithdrawalScreen extends StatefulWidget {
  const WithdrawalScreen({super.key});

  @override
  State<WithdrawalScreen> createState() => _WithdrawalScreenState();
}

class _WithdrawalScreenState extends State<WithdrawalScreen> {
  bool _understood = false;
  bool _requested = false;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('退会フローデモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: _requested
              ? _buildRequested(textTheme)
              : _buildRequest(textTheme),
        ),
      ),
    );
  }

  Widget _buildRequest(TextTheme textTheme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('架空のデモです。実際の退会は行われません。'),
        const SizedBox(height: 16),
        Semantics(
          header: true,
          child: Text('退会の申請', style: textTheme.titleLarge),
        ),
        const SizedBox(height: 16),
        Text('退会するとどうなるか', style: textTheme.titleMedium),
        const SizedBox(height: 8),
        const Text('・これまでの問診の記録が見られなくなります。'),
        const Text('・登録したお薬やプロフィールの情報が削除されます。'),
        const Text('・すでに医療機関へ送信した内容の取り消しは保証されません。'),
        const SizedBox(height: 16),
        Text('取り消せる期限', style: textTheme.titleMedium),
        const SizedBox(height: 8),
        const Text('お申し込みから30日間は保留され、その間は退会を取り消せます。'),
        const Text('30日を過ぎると情報が削除され、取り消せなくなります。'),
        const SizedBox(height: 16),
        const Text('本番では、ご本人確認のため再度のログイン（再認証）が必要です。'),
        const SizedBox(height: 8),
        CheckboxListTile(
          title: const Text('退会による影響と、30日後に削除されることを理解しました。'),
          value: _understood,
          onChanged: (value) => setState(() => _understood = value ?? false),
        ),
        const SizedBox(height: 8),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _understood ? _request : null,
            style: FilledButton.styleFrom(
              minimumSize: const Size(48, 48),
              textStyle: const TextStyle(fontSize: 20),
            ),
            child: const Text('退会を申請する'),
          ),
        ),
      ],
    );
  }

  Widget _buildRequested(TextTheme textTheme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('架空のデモです。実際の退会は行われません。'),
        const SizedBox(height: 16),
        Semantics(
          header: true,
          child: Text('退会を受け付けました', style: textTheme.titleLarge),
        ),
        const SizedBox(height: 16),
        const Text('お申し込みから30日後に情報が削除されます。'),
        const Text('それまでは、このページから退会を取り消せます。'),
        const SizedBox(height: 16),
        Text('いまの状態', style: textTheme.titleMedium),
        const SizedBox(height: 8),
        const Text('退会の手続き中のため、問診などの通常の機能は停止しています。'),
        const SizedBox(height: 24),
        SizedBox(
          width: double.infinity,
          child: FilledButton.tonal(
            onPressed: _cancel,
            style: FilledButton.styleFrom(
              minimumSize: const Size(48, 48),
              textStyle: const TextStyle(fontSize: 20),
            ),
            child: const Text('退会を取り消す'),
          ),
        ),
      ],
    );
  }

  Future<void> _request() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('退会の最終確認'),
        content: const Text(
          '退会を申請します。30日後に情報が削除されます。よろしいですか？'
          '（本番ではこの前に再認証が必要です）',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('やめる'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('退会を申請する'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _requested = true);
  }

  void _cancel() {
    setState(() {
      _requested = false;
      _understood = false;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('退会を取り消しました（デモ）。')),
    );
  }
}
