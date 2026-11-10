import 'package:flutter/material.dart';

import 'patient_theme.dart';
import 'symptom_input_screen.dart';

void main() => runApp(const SymptomPreviewApp());

class SymptomPreviewApp extends StatelessWidget {
  const SymptomPreviewApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '症状入力プレビュー',
      theme: buildPatientTheme(),
      home: const SymptomInputScreen(),
    );
  }
}
