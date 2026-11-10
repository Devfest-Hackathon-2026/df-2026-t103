import 'package:flutter/material.dart';

import 'ocr_processing_screen.dart';
import 'patient_theme.dart';

void main() => runApp(const OcrProcessingPreview());

class OcrProcessingPreview extends StatelessWidget {
  const OcrProcessingPreview({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'OCR処理中のデモ',
    theme: buildPatientTheme(),
    home: const OcrProcessingScreen(),
  );
}
