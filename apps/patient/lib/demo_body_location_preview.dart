import 'package:flutter/material.dart';

import 'body_location_screen.dart';
import 'patient_theme.dart';

/// `flutter run -t lib/demo_body_location_preview.dart` で独立起動する。
void main() => runApp(const BodyLocationPreview());

class BodyLocationPreview extends StatelessWidget {
  const BodyLocationPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '部位選択デモ',
      theme: buildPatientTheme(),
      home: const BodyLocationScreen(),
    );
  }
}
