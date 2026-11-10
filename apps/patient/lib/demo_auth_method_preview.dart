import 'package:flutter/material.dart';

import 'auth_method_screen.dart';
import 'patient_theme.dart';

// Passkey は審査承認まで既定で非表示にする。
const bool _passkeyEnabled = bool.fromEnvironment('PASSKEY_AUTH_ENABLED');

// flutter run -t lib/demo_auth_method_preview.dart で明示的に起動する。
void main() => runApp(const AuthMethodPreviewApp());

class AuthMethodPreviewApp extends StatelessWidget {
  const AuthMethodPreviewApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'もしもし問診 認証方式選択プレビュー',
    theme: buildPatientTheme(),
    home: const AuthMethodScreen(passkeyEnabled: _passkeyEnabled),
  );
}
