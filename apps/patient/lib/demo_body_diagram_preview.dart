import 'package:flutter/material.dart';

import 'body_diagram_screen.dart';
import 'patient_theme.dart';

/// `flutter run -t lib/demo_body_diagram_preview.dart` で独立起動する。
void main() => runApp(const BodyDiagramPreview());

class BodyDiagramPreview extends StatelessWidget {
  const BodyDiagramPreview({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '身体図デモ',
      theme: buildPatientTheme(),
      home: const BodyDiagramScreen(),
    );
  }
}
