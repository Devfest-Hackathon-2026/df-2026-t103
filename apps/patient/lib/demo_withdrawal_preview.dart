import 'package:flutter/material.dart';

import 'patient_theme.dart';
import 'withdrawal_screen.dart';

/// `flutter run -t lib/demo_withdrawal_preview.dart` で独立起動する。
void main() => runApp(const WithdrawalPreview());

class WithdrawalPreview extends StatelessWidget {
  const WithdrawalPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '退会フローデモ',
      theme: buildPatientTheme(),
      home: const WithdrawalScreen(),
    );
  }
}
