import 'package:flutter/material.dart';

/// 患者が利用する認証方式。
enum AuthMethod { google, email, passkey }

/// P-003 認証方式選択。
///
/// この画面は表示と選択の通知だけを担当し、Firebase Auth には接続しない。
/// 実際のサインインと P-002/P-004/P-005 への遷移は呼び出し側で行う。
class AuthMethodScreen extends StatelessWidget {
  const AuthMethodScreen({
    super.key,
    this.passkeyEnabled = false,
    this.enabledMethods = AuthMethod.values,
    this.onMethodSelected,
  });

  /// Passkey の審査承認後にだけ true にする。
  ///
  /// 未承認時は Widget 自体を生成せず、読み上げにも出さない。
  final bool passkeyEnabled;

  /// 実装済みの認証方式。含まれない方式は無効表示（未接続）になる。
  /// 既定は全方式（接続時）。
  final List<AuthMethod> enabledMethods;

  /// 認証方式が選ばれたときに呼ばれる。
  ///
  /// null の場合はプレビューとして各方式を無効表示する。
  final ValueChanged<AuthMethod>? onMethodSelected;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final connected = onMethodSelected != null;
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 600),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Semantics(
                    header: true,
                    child: Text(
                      'ログイン方法を選ぶ',
                      style: theme.textTheme.headlineMedium,
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text('初めての方も、同じ画面から登録できます。'),
                  if (!connected) ...[
                    const SizedBox(height: 16),
                    const Text('この画面は表示例です。認証は未接続のため利用できません。'),
                  ],
                  const SizedBox(height: 24),
                  _MethodButton(
                    icon: Icons.account_circle_outlined,
                    label: 'Googleで続ける',
                    onPressed:
                        connected && enabledMethods.contains(AuthMethod.google)
                        ? () => onMethodSelected!(AuthMethod.google)
                        : null,
                  ),
                  const SizedBox(height: 12),
                  _MethodButton(
                    icon: Icons.mail_outline,
                    label: 'メールアドレスで続ける',
                    onPressed:
                        connected && enabledMethods.contains(AuthMethod.email)
                        ? () => onMethodSelected!(AuthMethod.email)
                        : null,
                  ),
                  if (passkeyEnabled) ...[
                    const SizedBox(height: 12),
                    _MethodButton(
                      icon: Icons.fingerprint,
                      label: 'パスキーで続ける',
                      onPressed:
                          connected &&
                              enabledMethods.contains(AuthMethod.passkey)
                          ? () => onMethodSelected!(AuthMethod.passkey)
                          : null,
                    ),
                  ],
                  const SizedBox(height: 24),
                  const Text('認証後、必要な同意やプロフィール登録へ進みます。'),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _MethodButton extends StatelessWidget {
  const _MethodButton({
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        alignment: Alignment.centerLeft,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
        minimumSize: const Size.fromHeight(64),
        textStyle: const TextStyle(fontSize: 20),
      ),
      child: Row(
        children: [
          Icon(icon, size: 28),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: theme.textTheme.titleMedium),
                if (onPressed == null) const Text('未接続'),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
