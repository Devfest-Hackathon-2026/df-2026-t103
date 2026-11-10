import 'package:flutter/material.dart';

import 'patient_theme.dart';
import 'safety_confirm_screen.dart';

/// `flutter run -t lib/demo_safety_confirm_preview.dart` で独立起動する。
void main() => runApp(const SafetyConfirmPreview());

class SafetyConfirmPreview extends StatelessWidget {
  const SafetyConfirmPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '安全に関する確認デモ',
      theme: buildPatientTheme(),
      home: const SafetyConfirmScreen(),
    );
  }
}
