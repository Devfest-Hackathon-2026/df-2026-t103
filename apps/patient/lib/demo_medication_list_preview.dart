import 'package:flutter/material.dart';

import 'medication_list_screen.dart';
import 'patient_theme.dart';

/// `flutter run -t lib/demo_medication_list_preview.dart` で独立起動する。
void main() => runApp(const MedicationListPreview());

class MedicationListPreview extends StatelessWidget {
  const MedicationListPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '薬の一覧デモ',
      theme: buildPatientTheme(),
      home: const MedicationListScreen(),
    );
  }
}
