import 'package:flutter/material.dart';

import 'patient_theme.dart';
import 'prescription_capture_screen.dart';

/// `flutter run -t lib/demo_prescription_capture_preview.dart` で独立起動する。
void main() => runApp(const PrescriptionCapturePreview());

class PrescriptionCapturePreview extends StatelessWidget {
  const PrescriptionCapturePreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '処方箋の取り込みデモ',
      theme: buildPatientTheme(),
      home: const PrescriptionCaptureScreen(),
    );
  }
}
