import 'package:flutter/material.dart';

import 'ocr_candidate_screen.dart';
import 'patient_theme.dart';

/// `flutter run -t lib/demo_ocr_candidate_preview.dart` で独立起動する。
void main() => runApp(const OcrCandidatePreview());

class OcrCandidatePreview extends StatelessWidget {
  const OcrCandidatePreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '薬の候補確認デモ',
      theme: buildPatientTheme(),
      home: const OcrCandidateScreen(),
    );
  }
}
