import 'package:flutter/material.dart';

import 'hospital_detail_screen.dart';
import 'patient_theme.dart';

/// `flutter run -t lib/demo_hospital_detail_preview.dart` で独立起動する。
void main() => runApp(const HospitalDetailPreview());

class HospitalDetailPreview extends StatelessWidget {
  const HospitalDetailPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '病院詳細デモ',
      theme: buildPatientTheme(),
      home: const HospitalDetailScreen(),
    );
  }
}
