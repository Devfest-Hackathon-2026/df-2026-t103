import 'package:flutter/material.dart';

import 'patient_theme.dart';

/// `flutter run -t lib/demo_auth_preview.dart` で独立起動する。
void main() => runApp(const AuthPreview());

class AuthPreview extends StatelessWidget {
  const AuthPreview({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: '認証画面デモ',
    theme: buildPatientTheme(),
    home: const _AuthScreen(),
  );
}

class _AuthScreen extends StatefulWidget {
  const _AuthScreen();

  @override
  State<_AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<_AuthScreen> {
  bool registering = false;
  bool terms = false;
  bool privacy = false;
  bool health = false;
  bool attempted = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('認証画面デモ')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 600),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Text(
                '架空のデモです。送信先は未接続のため、登録・ログインはできません。実際のメールアドレスやパスワードを入力しないでください。',
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              const SizedBox(height: 16),
              SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(value: false, label: Text('ログイン')),
                  ButtonSegment(value: true, label: Text('新規登録')),
                ],
                selected: {registering},
                onSelectionChanged: (selection) => setState(() {
                  registering = selection.single;
                  attempted = false;
                  terms = false;
                  privacy = false;
                  health = false;
                }),
              ),
              const SizedBox(height: 24),
              const TextField(
                key: Key('demo-email'),
                decoration: InputDecoration(labelText: 'メールアドレス（架空）'),
                keyboardType: TextInputType.emailAddress,
                enableSuggestions: false,
                autocorrect: false,
              ),
              const SizedBox(height: 16),
              const TextField(
                key: Key('demo-password'),
                decoration: InputDecoration(labelText: 'パスワード（架空）'),
                obscureText: true,
                enableSuggestions: false,
                autocorrect: false,
              ),
              if (registering) ...[
                const SizedBox(height: 24),
                const Text('以下は画面確認用の仮項目です。正式な規約ではなく、法的な同意は取得されません。'),
                CheckboxListTile(
                  title: const Text('利用規約の確認（仮）'),
                  value: terms,
                  onChanged: (value) => setState(() => terms = value ?? false),
                ),
                CheckboxListTile(
                  title: const Text('プライバシーの確認（仮）'),
                  value: privacy,
                  onChanged: (value) =>
                      setState(() => privacy = value ?? false),
                ),
                CheckboxListTile(
                  title: const Text('医療情報の取得目的の確認（仮）'),
                  value: health,
                  onChanged: (value) => setState(() => health = value ?? false),
                ),
              ],
              const SizedBox(height: 24),
              FilledButton(
                onPressed: registering && !(terms && privacy && health)
                    ? null
                    : () => setState(() => attempted = true),
                child: Text(registering ? '登録を試す（デモ）' : 'ログインを試す（デモ）'),
              ),
              if (attempted) ...[
                const SizedBox(height: 16),
                const Text('送信先は未接続です。登録・ログインは行われていません。'),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
