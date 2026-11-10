import 'package:flutter/material.dart';

import 'account_screen.dart';
import 'patient_theme.dart';

/// `flutter run -t lib/demo_account_preview.dart` で独立起動する。
void main() => runApp(const AccountPreview());

class AccountPreview extends StatelessWidget {
  const AccountPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'アカウントデモ',
      theme: buildPatientTheme(),
      home: const AccountScreen(),
    );
  }
}
