import 'package:flutter/material.dart';

import 'patient_theme.dart';
import 'review_screen.dart';

/// `flutter run -t lib/demo_review_preview.dart` で独立起動する。
void main() => runApp(const ReviewPreview());

class ReviewPreview extends StatelessWidget {
  const ReviewPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '問診票の確認デモ',
      theme: buildPatientTheme(),
      home: const ReviewScreen(),
    );
  }
}
