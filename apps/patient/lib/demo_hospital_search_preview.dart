import 'package:flutter/material.dart';

import 'hospital_search_screen.dart';
import 'patient_theme.dart';

/// `flutter run -t lib/demo_hospital_search_preview.dart` で独立起動する。
void main() => runApp(const HospitalSearchPreview());

class HospitalSearchPreview extends StatelessWidget {
  const HospitalSearchPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '病院検索デモ',
      theme: buildPatientTheme(),
      home: const HospitalSearchScreen(),
    );
  }
}
