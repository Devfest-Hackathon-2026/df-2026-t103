import 'package:flutter/material.dart';

import 'patient_theme.dart';
import 'send_confirm_screen.dart';

/// `flutter run -t lib/demo_send_confirm_preview.dart` で独立起動する。
void main() => runApp(const SendConfirmPreview());

class SendConfirmPreview extends StatelessWidget {
  const SendConfirmPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '送信前の確認デモ',
      theme: buildPatientTheme(),
      home: const SendConfirmScreen(),
    );
  }
}
